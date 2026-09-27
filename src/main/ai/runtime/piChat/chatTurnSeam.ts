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
import type { ToolSet, UIMessageChunk } from 'ai'

import { application } from '@application'
import type { TokenUsageSource } from '@cherrystudio/analytics-client'
import { aiUsageRecordService, type SourceSnapshot } from '@data/services/AiUsageRecordService'
import { loggerService } from '@logger'
import { resolveChatTurnPlan, type ChatTurnPlan, type ChatTurnPlanRequest } from '@main/ai/chatTurnPlan'
import { resolveTurnInFlightTruncateThreshold } from '@main/ai/contextBuild/inFlightTruncate'
import type { Assistant } from '@shared/data/types/assistant'
import type { CherryUIMessage } from '@shared/data/types/message'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type { ReasoningEffortOption } from '@shared/types/aiSdk'
import { isVisionModel } from '@shared/utils/model'
import { matchesPreset } from '@shared/utils/provider'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import { resolveAttachmentBudget } from '../../messages/attachmentBudget'
import { prepareChatMessages } from '../../messages/attachmentRouting'
import { resolveMediaCapabilities } from '../../messages/messageCapabilities'
import { resolveAiSdkProviderId, resolveEffectiveEndpoint } from '../../provider/endpoint'
import type { MainDispatchRequest } from '../../streamManager'
import { getTemperature, getTopP } from '../../utils/modelParameters'
import type { ResolvedReasoningInvocation } from '../../utils/reasoningSerializers'
import { createRequestCaptureContext, resolveUsageAttribution } from '../../utils/usageCapture'
import { assembleSystemPrompt } from '../aiSdk'
import {
  materializePiProviderStream,
  PiMissingApiKeyError,
  piPreferredEndpointType,
  type PiStreamRequestOptions,
  PiUnsupportedProviderError,
  resolvePiProviderInjectionFromSnapshot,
  usesPiGateway
} from '../pi/modelInjection'
import { streamPiChatTurn, type PiChatProviderSource, type PiChatRuntimeTimingSink } from './chatEngine'
import { toPiChatToolSurface } from './chatToolSurface'
import { filePartContent } from './historyConverter'
import { resolveUserThinkingSuffix } from './userThinkingSuffix'

const logger = loggerService.withContext('PiChatSeam')

/** The slice of the streaming request the seam reads (kept structural so the seam stays AiService-free). */
export type PiChatSeamRequest = ChatTurnPlanRequest & {
  conversation: ChatTurnPlanRequest['conversation'] & { topicId: string }
  /** The trunk's dispatch trigger vocabulary — derived, not mirrored (a new main-only
   *  trigger must survive the seam's exclusion switch or fail to compile). */
  trigger?: MainDispatchRequest['trigger']
  source?: SourceSnapshot | null
  usageContext?: { source?: SourceSnapshot | null; assistantMessageId: string }
  tokenUsageSource?: TokenUsageSource
  runtimeTimingSink?: PiChatRuntimeTimingSink
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

  // The plan must describe the endpoint pi will actually SERVE: pi prefers
  // anthropic-messages for dual-protocol models, and the plan's reasoning profile and
  // output-cap resolution are endpoint-keyed — an `endpointTypes[0]` view silently
  // diverges from the anthropic wire for those models.
  const preferredEndpoint = piPreferredEndpointType(model)
  const plan = await resolveChatTurnPlan({
    request,
    provider,
    model,
    assistant,
    preferredEndpoint,
    runtimeProviderId: resolveAiSdkProviderId(
      provider,
      resolveEffectiveEndpoint(provider, model, preferredEndpoint).endpointType
    )
  })

  // Provider-native search has no pi surface (`providerOptions` plugins are legacy-only),
  // and the client `web_search` tool only loads for client-routed turns — the DEFAULT for
  // native-search providers without a search backend is `server`, which on pi would send
  // a search-telling prompt with no search behind it. Legacy keeps serving those turns.
  if (plan.webToolRoutes.webSearch === 'server') {
    logger.info('pi chat engine excluded, falling back to legacy', {
      topicId: request.conversation.topicId,
      modelId: model.id,
      reason: 'server-routed web search (provider-native search has no pi surface)'
    })
    return null
  }

  const materialized = await materializePiProviderStream(injection, piStreamRequestOptions(plan, assistant, model))
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
          thresholdChars: resolveTurnInFlightTruncateThreshold({
            truncateThreshold: plan.contextSettings.truncateThreshold,
            contextWindow: model.contextWindow,
            // The custom-params reservation slot policy lives IN the helper (shared
            // with the legacy lane) — do not fold the plan's output cap in here.
            callOverrideMaxTokens: request.callOverrides?.maxOutputTokens,
            assistant,
            model,
            endpointType: plan.endpointType
          }),
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
    ...resolveUsageAttribution(request, assistant)
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
      thinkingLevel: resolvePiThinkingLevel(plan.reasoningInvocation, model, injection.api),
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
 * Chat reasoning selection → pi `ThinkingLevel`.
 *
 * - `off`/tiers map by identity (the tier vocabulary alignment is compile-enforced below).
 * - `auto` means thinking ON in Cherry's profiles (gemini `includeThoughts`, anthropic
 *   `adaptive`, effortMap auto→medium), so it maps to an explicit `medium` — the least-bad
 *   on-signal. Residual (recorded): pi has no adaptive/dynamic sentinel; gemini's dynamic
 *   budget and claude's adaptive mode land on `medium`.
 * - `omit` (an unset selection — legacy's wire for `default` too, since no built-in
 *   profile defines a default mode) CANNOT stay absent: pi resolves an absent level to its
 *   own `medium` default — thinking silently ON, clamped UP to `high` on tiered
 *   vocabularies. Explicit `off` restores legacy's wire only where it is both expressible
 *   and faithful: the anthropic family (an absent thinking param IS disabled there).
 *   Elsewhere the residual is recorded (google's dynamic default, qwen's deployment
 *   default, openai's tiered provider default all ride pi's `medium`).
 */
export function resolvePiThinkingLevel(
  invocation: ResolvedReasoningInvocation,
  model: Model,
  api: string
): ModelThinkingLevel | undefined {
  const { kind, selection } = invocation
  if (kind === 'off') return 'off'
  if (kind === 'auto') return 'medium'
  if (kind === 'effort' || kind === 'budget') return piThinkingTier(selection)
  if (api === 'anthropic-messages' && piOffExpressible(model)) return 'off'
  return undefined
}

/** Compile-enforced vocabulary alignment: Cherry's tiers ARE pi's (minus the non-tier
 *  selections). A new registry tier is a type error here until it is classified. */
const PI_TIER_SELECTIONS = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  ultra: true
} satisfies Record<Exclude<ReasoningEffortOption, 'none' | 'auto' | 'default'>, true>

function piThinkingTier(selection: ReasoningEffortOption): ModelThinkingLevel | undefined {
  if (selection === 'none' || selection === 'auto' || selection === 'default') return undefined
  if (PI_TIER_SELECTIONS[selection] !== true) {
    logger.warn('reasoning selection has no pi thinking level; sending none', { selection })
    return undefined
  }
  return selection
}

/** pi can only express `off` when the model's effort vocabulary admits it: a tiered model
 *  that does not declare `none` gets `off: null` in its thinkingLevelMap, and pi clamps
 *  `'off'` UP to the lowest declared tier — silently turning thinking back on. */
function piOffExpressible(model: Model): boolean {
  const declared = model.reasoning?.selectableEfforts ?? []
  const hasConcreteTier = declared.some((effort) => effort !== 'none' && effort !== 'auto')
  return !hasConcreteTier || declared.includes('none')
}

/** `ToolSet` view of the plan's selection for the attachment budget (`ToolEntry.tool` IS an SDK tool). */
function toolSetOf(plan: ChatTurnPlan): ToolSet | undefined {
  if (plan.selectedEntries.length === 0) return undefined
  const tools: ToolSet = {}
  for (const entry of plan.selectedEntries) tools[entry.name] = entry.tool
  return tools
}

/**
 * The request-level stream options (the legacy `buildAgentOptions` sampling tail, pi-shaped):
 * temperature/topP through the SHARED gates (`getTemperature`/`getTopP` — the model and
 * reasoning gating is legacy's, by reuse not re-derivation), custom standard params by wire
 * alias. `samplingParams` is applied by pi's openai-compatible adapters only (recorded
 * residual), and provider-scoped custom body params (legacy's fetch-wrapper lane) have no
 * pi surface yet. Legacy precedence kept: custom params override the settings-derived values.
 */
function piStreamRequestOptions(
  plan: ChatTurnPlan,
  assistant: Assistant | undefined,
  model: Model
): PiStreamRequestOptions | undefined {
  const custom = plan.customParameters.standardParams
  const gatedTemperature = assistant ? getTemperature(assistant.settings, model, plan.reasoningInvocation) : undefined
  const gatedTopP = assistant ? getTopP(assistant.settings, model, plan.reasoningInvocation) : undefined
  const temperature = (custom.temperature as number | undefined) ?? gatedTemperature
  const topP = (custom.topP as number | undefined) ?? gatedTopP
  const samplingParams: Record<string, unknown> = {
    ...(topP !== undefined && { top_p: topP }),
    ...(custom.topK !== undefined && { top_k: custom.topK }),
    ...(custom.presencePenalty !== undefined && { presence_penalty: custom.presencePenalty }),
    ...(custom.frequencyPenalty !== undefined && { frequency_penalty: custom.frequencyPenalty }),
    ...(custom.stopSequences !== undefined && { stop: custom.stopSequences }),
    ...(custom.seed !== undefined && { seed: custom.seed })
  }
  const options: PiStreamRequestOptions = {
    ...(plan.requestedMaxOutputTokens !== undefined && { maxTokens: plan.requestedMaxOutputTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(Object.keys(samplingParams).length > 0 && { samplingParams })
  }
  return Object.keys(options).length > 0 ? options : undefined
}

/** Patch the request-level output cap into the materialized provider config's model entry.
 *  A cap that finds no entry means the injection's modelId and config disagree — fail the
 *  turn rather than silently letting the setting go inert (the exact bug this patch exists
 *  to fix). */
function patchRequestMaxOutputTokens(
  config: ProviderConfig,
  modelId: string,
  requestedMaxOutputTokens: number | undefined
): ProviderConfig {
  if (requestedMaxOutputTokens === undefined || !config.models) return config
  let matched = false
  const models = config.models.map((entry) => {
    if (entry.id !== modelId) return entry
    matched = true
    return { ...entry, maxTokens: requestedMaxOutputTokens }
  })
  if (!matched) {
    throw new Error(`pi chat provider config has no model entry "${modelId}" to receive the request output cap`)
  }
  return { ...config, models }
}
