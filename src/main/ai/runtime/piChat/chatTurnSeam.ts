/**
 * W6 — the chat-turn seam: the per-execution gate and request→engine-input
 * preparation that routes a `streamText` request onto the pi chat engine
 * (plan: docs/plans/2026-09-pi-unification.md, W6).
 *
 * The gate resolves PER EXECUTION: while the rollout flag is on, an execution
 * runs pi unless a matrix row excludes it, in which case this returns `null`
 * and the caller silently falls back to the legacy engine (logged). Flag off —
 * the shipped default — returns `null` before touching anything.
 *
 * Everything engine-agnostic is resolved by the shared `resolveChatTurnPlan`
 * (`src/main/ai/chatTurnPlan.ts`), so the pi path and the legacy path consume
 * one set of decisions (selection, system prompt inputs, knobs, reasoning).
 */
import { randomUUID } from 'node:crypto'

import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'
import type { UIMessageChunk } from 'ai'

import { application } from '@application'
import type { TokenUsageSource } from '@cherrystudio/analytics-client'
import { aiUsageRecordService, type SourceSnapshot } from '@data/services/AiUsageRecordService'
import { loggerService } from '@logger'
import { resolveChatTurnPlan, type ChatTurnPlanRequest } from '@main/ai/chatTurnPlan'
import { resolveInFlightTruncateThreshold } from '@main/ai/contextBuild/inFlightTruncate'
import { resolveRequestedMaxOutputTokens } from '@main/ai/contextBuild/resolveOutputReservation'
import type { Assistant } from '@shared/data/types/assistant'
import type { CherryUIMessage } from '@shared/data/types/message'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { isVisionModel } from '@shared/utils/model'
import { matchesPreset } from '@shared/utils/provider'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import { resolveAttachmentBudget } from '../../messages/attachmentBudget'
import { prepareChatMessages } from '../../messages/attachmentRouting'
import { resolveMediaCapabilities } from '../../messages/messageCapabilities'
import { resolveAiSdkProviderId, resolveEffectiveEndpoint } from '../../provider/endpoint'
import type { ChatTrigger } from '../../types'
import { createRequestCaptureContext, sourceSnapshotForAssistant } from '../../utils/usageCapture'
import { assembleSystemPrompt } from '../aiSdk'
import {
  materializePiProviderStream,
  PiMissingApiKeyError,
  PiUnsupportedProviderError,
  resolvePiProviderInjectionFromSnapshot,
  usesPiGateway
} from '../pi/modelInjection'
import { streamPiChatTurn, type PiChatProviderSource } from './chatEngine'
import { toPiChatToolSurface } from './chatToolSurface'
import { filePartContent } from './historyConverter'
import { resolveUserThinkingSuffix } from './userThinkingSuffix'

const logger = loggerService.withContext('PiChatSeam')

/** The slice of the streaming request the seam reads (kept structural so the seam stays AiService-free). */
export type PiChatSeamRequest = ChatTurnPlanRequest & {
  conversation: ChatTurnPlanRequest['conversation'] & { topicId: string }
  /** The renderer contract's `ChatTrigger` plus the main-only synthesized dispatch triggers
   *  (streamManager/context/dispatch.ts's `MainDispatchRequest`). */
  trigger?: ChatTrigger | 'continue-conversation' | 'steer-continuation' | 'edit-agent-message'
  source?: SourceSnapshot | null
  usageContext?: { source?: SourceSnapshot | null; assistantMessageId: string }
  tokenUsageSource?: TokenUsageSource
  runtimeTimingSink?: { onToolExecutionStart(e: { callId: string; toolName?: string }): void } & {
    onToolExecutionEnd(e: { callId: string; toolName?: string; durationMs: number }): void
  }
}

export interface PiChatSeamInput {
  request: PiChatSeamRequest
  signal: AbortSignal
  provider: Provider
  model: Model
  assistant: Assistant | undefined
}

/**
 * Whether the pi chat engine may serve requests at all — the cheap first check
 * the caller runs BEFORE resolving provider/model, so a flag-off process pays
 * nothing and the legacy path stays byte-identical.
 */
export function piChatEngineEnabled(): boolean {
  return application.get('PreferenceService').get('chat.pi_engine.enabled') === true
}

/**
 * Attempt this chat turn on the pi engine. `null` means the gate excluded it —
 * the caller proceeds on the legacy engine unchanged.
 */
export async function tryStreamPiChatTurn(input: PiChatSeamInput): Promise<ReadableStream<UIMessageChunk> | null> {
  const { request, signal, provider, model, assistant } = input

  if (!piChatEngineEnabled()) return null

  const exclusion = resolvePiExclusion(input)
  if (exclusion) {
    logger.info('pi chat engine excluded, falling back to legacy', {
      topicId: request.conversation.topicId,
      modelId: model.id,
      reason: exclusion
    })
    return null
  }

  // The provider injection doubles as the last matrix row: an endpoint pi cannot
  // serve, or a provider with no credential, falls back to legacy (which renders
  // its own well-known error UX for missing keys).
  const injection = (() => {
    try {
      return resolvePiProviderInjectionFromSnapshot(provider, model)
    } catch (error) {
      if (error instanceof PiUnsupportedProviderError) {
        logger.info('pi chat engine excluded, falling back to legacy', {
          topicId: request.conversation.topicId,
          modelId: model.id,
          reason: `no pi api family (${error.providerId})`
        })
        return null
      }
      if (error instanceof PiMissingApiKeyError) {
        logger.info('pi chat engine excluded, falling back to legacy', {
          topicId: request.conversation.topicId,
          modelId: model.id,
          reason: `no api key (${error.providerId})`
        })
        return null
      }
      throw error
    }
  })()
  if (!injection) return null

  const plan = await resolveChatTurnPlan({
    request,
    provider,
    model,
    assistant,
    runtimeProviderId: resolveAiSdkProviderId(provider, resolveEffectiveEndpoint(provider, model).endpointType)
  })
  const materialized = await materializePiProviderStream(injection)
  // The injection's model config carries the MODEL-level output cap only; the
  // request-level cap (assistant setting / callOverrides) would otherwise be
  // inert on pi. Patch it into the materialized config before the engine
  // registers the provider.
  const providerSource: PiChatProviderSource = {
    name: injection.providerName,
    apiKey: injection.apiKey,
    modelId: injection.modelId,
    config: patchRequestMaxOutputTokens(materialized.providerConfig, injection.modelId, plan.requestedMaxOutputTokens)
  }

  // pi user content is text+image: pin native attachment support to exactly that
  // (image per model vision; pdf/audio/video forced to extracted text) so a
  // "native" PDF never degrades to a filename note in the converter.
  const systemPrompt = await assembleSystemPrompt({
    assistant,
    model,
    hasCitableTools: plan.hasCitableTools,
    webSearchEnabled: plan.webToolRoutes.webSearch !== 'none'
  })
  const preparedMessages = await prepareChatMessages(request.messages ?? [], {
    attachments: plan.fileAttachments,
    nativeSupport: { image: isVisionModel(model), pdf: false, audio: false, video: false },
    isToolCapable: plan.canConsumeTools,
    budget:
      plan.hasFileAttachments && request.contextOwner !== 'caller'
        ? ((await resolveAttachmentBudget({
            provider,
            model,
            system: systemPrompt,
            tools: toolSetOf(plan),
            maxOutputTokens: plan.requestedMaxOutputTokens ?? model.maxOutputTokens,
            messages: request.messages ?? [],
            mediaCapabilities: resolveMediaCapabilities(model)
          })) ?? undefined)
        : undefined,
    signal
  })

  // Slice the trailing user message into the engine's prompt channel; the served
  // list minus it is the replayed history. The engine refuses a history that
  // still contains the prompt message (double-send guard).
  const trailing = preparedMessages[preparedMessages.length - 1]
  const promptText = trailing.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const promptImages = trailing.parts
    .filter((part): part is { type: 'file'; mediaType: string; url: string; filename?: string } => part.type === 'file')
    .map((part) => filePartContent(part))
    // Only real images ride the prompt channel; the text note `filePartContent`
    // mints for a non-base64 file contributes nothing here (history replay keeps
    // its note — the prompt drops it).
    .filter((content): content is { type: 'image'; data: string; mimeType: string } => content.type === 'image')

  const executionId = request.messageId ? `${request.messageId}:${model.id}` : `prompt:${randomUUID()}`

  const requestContext = {
    requestId: request.messageId ?? randomUUID(),
    topicId: request.conversation.topicId,
    assistant,
    abortSignal: signal,
    fileAttachments: plan.fileAttachments,
    knowledgeBaseIds: plan.knowledgeBaseIds,
    // fs_read's allow-list — seeded unconditionally (it is NOT the offload gate);
    // the in-flight offload adapter appends mid-turn markers to this clone.
    persistedOutputPaths: new Set(plan.retained.persistedOutputPaths),
    mcpResourceServerIds: plan.mcpResourceServerIds,
    toolOutputCharCap: plan.contextSettings.truncateThreshold,
    ...(plan.contextSettings.enabled &&
      request.contextOwner !== 'caller' && {
        toolResultTruncation: {
          thresholdChars: resolveInFlightTruncateThreshold(
            plan.contextSettings.truncateThreshold,
            model.contextWindow,
            // Deliberately recomputed with `undefined` for the custom-params slot:
            // the legacy in-flight lane (contextBuild feature) excludes the
            // assistant's custom maxOutputTokens from the reservation, and the
            // plan's own `requestedMaxOutputTokens` folds them in — reusing it
            // would silently change the truncate threshold.
            resolveRequestedMaxOutputTokens(
              request.callOverrides?.maxOutputTokens,
              undefined,
              assistant,
              model,
              plan.endpointType
            )
          ),
          canOffload: plan.canOffloadToolOutputs
        }
      })
  }

  const surface =
    plan.selectedEntries.length > 0
      ? toPiChatToolSurface(
          plan.selectedEntries,
          { requestContext },
          {
            approvalScope: `pi-chat:${executionId}`,
            onApprovalResolved: (toolCallId, approved) =>
              application.get('AiStreamManager').resolveToolApproval(request.conversation.topicId, toolCallId, approved)
          }
        )
      : undefined

  const captureContext = createRequestCaptureContext({
    provider,
    model,
    sdkModelId: injection.modelId,
    credentialReceipt:
      injection.usageCapture.owner === 'agent-sdk' ? injection.usageCapture.credentialReceipt : undefined,
    source: request.usageContext
      ? (request.usageContext.source ?? null)
      : (request.source ?? sourceSnapshotForAssistant(assistant) ?? null),
    messageRef: request.usageContext
      ? { kind: 'agent-session', id: request.usageContext.assistantMessageId }
      : request.messageId
        ? { kind: 'chat', id: request.messageId }
        : null
  })
  const tokenUsageSource = request.tokenUsageSource ?? 'chat'

  const stream = await streamPiChatTurn(
    {
      executionId,
      provider: providerSource,
      systemPrompt,
      history: preparedMessages.slice(0, -1) as CherryUIMessage[],
      prompt: {
        messageId: trailing.id,
        text: promptText,
        ...(promptImages.length > 0 && { images: promptImages })
      },
      thinkingLevel: resolvePiThinkingLevel(plan.reasoningInvocation),
      ...(surface && { tools: surface.tools, authorizer: surface.authorizer }),
      isSameModelAsTurn: (message) => message.metadata?.modelId === model.id,
      mediaCapabilities: resolveMediaCapabilities(model),
      onInvocation: (invocation) => {
        aiUsageRecordService.recordInvocation({
          requestId: invocation.requestId,
          context: captureContext,
          modality: 'language',
          usage: invocation.usage,
          metrics: invocation.metrics,
          completedAt: Date.now()
        })
        if (!model.providerId || !model.apiModelId) return
        try {
          application.get('AnalyticsService').trackTokenUsage({
            provider: model.providerId,
            model: model.apiModelId ?? model.id,
            input_tokens: invocation.usage?.inputTokens ?? 0,
            output_tokens: invocation.usage?.outputTokens ?? 0,
            source: tokenUsageSource
          })
        } catch {
          // AnalyticsService may not be activated (data collection disabled)
        }
      },
      ...(request.runtimeTimingSink && { runtimeTimingSink: request.runtimeTimingSink }),
      toolCallLimit: plan.toolCallLimit,
      userTextSuffix: resolveUserThinkingSuffix({
        provider,
        model,
        reasoningKind: plan.reasoningInvocation.kind,
        hasAssistant: assistant !== undefined,
        hasExplicitReasoningEffort: plan.hasExplicitReasoningEffort,
        mcpToolCount: plan.mcpToolIds.size
      })
    },
    signal
  )
  return stream
}

/** The per-execution matrix exclusions (register rows); `undefined` means "gate passes".
 *  Pure checks only — the provider-injection try/catch lives in the main flow so the
 *  credential rotation is consumed at most once. */
function resolvePiExclusion(input: PiChatSeamInput): string | undefined {
  const { request, provider, assistant } = input

  // `streamSimple` is SSE-only: a non-streaming (simulate-streaming) request has no pi surface.
  if (assistant?.settings.streamOutput === false) return 'non-streaming assistant (streamOutput=false)'

  // Approval-resume dispatches serve a list that ENDS with the assistant anchor —
  // there is no trailing user message to slice into the prompt, and pi holds its
  // approvals in-process, so every continue-conversation is a legacy pause by
  // construction.
  if (request.trigger === 'continue-conversation') return 'continue-conversation dispatch'

  const messages = request.messages ?? []
  const trailing = messages[messages.length - 1]
  if (!trailing || trailing.role !== 'user') {
    return 'served list does not end with a user message (legacy pause / degenerate regenerate)'
  }

  // Gateway client tools carry no execute implementation; the pi surface converts
  // registry entries only and a client tool would fail at call time.
  if (Object.keys(request.callOverrides?.tools ?? {}).length > 0) return 'client tools (gateway tools request)'

  // The API-key override is an AI-SDK serving concern; the pi injection resolves
  // its own credential and would silently ignore the override.
  if (request.apiKeyOverride) return 'apiKeyOverride (not represented in the pi injection)'

  // HF's router hard-400s any reasoning input item — a pi-written same-model turn
  // replayed on HF fails the request outright (both of HF's protocols route
  // through the same reasoning-stripping router).
  if (matchesPreset(provider, SystemProviderIds.huggingface)) return 'huggingface reasoning-replay 400'

  // Provider-declared gateway routes resolve their injection session-side; the
  // chat seam uses the direct snapshot resolver, so those stay legacy for now.
  if (usesPiGateway(provider)) return 'gateway-routed provider (cherry cloud)'

  return undefined
}

/**
 * Chat reasoning selection → pi `ThinkingLevel`. `omit` (the model/profile sends
 * nothing) and `default`/`auto` map to `undefined` — pi then applies its own
 * model-side default, closest to "provider decides". `none` is pi's `off`.
 * Recorded delta: pi's qwen dialect emits `enable_thinking: !!thinkingLevel`, so
 * an omit-kind turn still sends `enable_thinking: false` where legacy sent no
 * parameter at all.
 */
function resolvePiThinkingLevel(invocation: { kind: string; selection: string }): ModelThinkingLevel | undefined {
  const { kind, selection } = invocation
  if (kind === 'omit') return undefined
  if (selection === 'default' || selection === 'auto') return undefined
  if (selection === 'none') return 'off'
  return selection as ModelThinkingLevel
}

/** `ToolSet` view of the plan's selection for the attachment budget (`ToolEntry.tool` IS an SDK tool). */
function toolSetOf(plan: Awaited<ReturnType<typeof resolveChatTurnPlan>>) {
  if (plan.selectedEntries.length === 0) return undefined
  const tools: Record<string, unknown> = {}
  for (const entry of plan.selectedEntries) tools[entry.name] = entry.tool
  return tools as never
}

/** Patch the request-level output cap into the materialized provider config's model entry. */
function patchRequestMaxOutputTokens(
  config: ProviderConfig,
  modelId: string,
  requestedMaxOutputTokens: number | undefined
): ProviderConfig {
  if (requestedMaxOutputTokens === undefined || !config.models) return config
  return {
    ...config,
    models: config.models.map((entry) =>
      entry.id === modelId ? { ...entry, maxTokens: requestedMaxOutputTokens } : entry
    )
  }
}
