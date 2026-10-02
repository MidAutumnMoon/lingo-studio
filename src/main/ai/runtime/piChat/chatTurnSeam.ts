/**
 * W6 — the chat-turn seam: the per-execution gate and request→engine-input
 * preparation that routes a `streamText` request onto the pi chat engine
 * (plan: docs/plans/2026-09-pi-unification.md, W6).
 *
 * pi is the ONLY chat engine: this either returns a stream or fails the turn —
 * matrix rows that once fell back to the legacy engine (approval-resume
 * dispatches, credentials, unsupported families) are explicit error turns now.
 * The `chat.pi_engine.enabled` preference is inert (pi runs either way, logged)
 * until its removal lands.
 *
 * Everything engine-agnostic is resolved by the shared `resolveChatTurnPlan`
 * (`src/main/ai/chatTurnPlan.ts`), so preparation decisions (selection, system
 * prompt inputs, knobs, reasoning) stay in one place.
 */
import { randomUUID } from 'node:crypto'

import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'

import { application } from '@application'
import type { TokenUsageSource } from '@cherrystudio/analytics-client'
import { aiUsageRecordService, type SourceSnapshot } from '@data/services/AiUsageRecordService'
import { loggerService } from '@logger'
import { resolveChatTurnPlan, type ChatTurnPlan, type ChatTurnPlanRequest } from '@main/ai/chatTurnPlan'
import { resolveTurnInFlightTruncateThreshold } from '@main/ai/contextBuild/inFlightTruncate'
import type { NeutralTool } from '@main/ai/tools/neutralTool'
import { assembleSystemPrompt } from '@main/ai/utils/assembleSystemPrompt'
import { t } from '@main/i18n'
import type { UIMessageChunk } from '@shared/ai/uiDialect'
import type { Assistant } from '@shared/data/types/assistant'
import type { CherryUIMessage } from '@shared/data/types/message'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type { ReasoningEffortOption } from '@shared/types/aiSdk'
import { isVisionModel } from '@shared/utils/model'

import { resolveAttachmentBudget } from '../../messages/attachmentBudget'
import { prepareChatMessages } from '../../messages/attachmentRouting'
import { resolveMediaCapabilities } from '../../messages/messageCapabilities'
import { resolveAiSdkProviderId, resolveEffectiveEndpoint } from '../../provider/endpoint'
import type { MainDispatchRequest } from '../../streamManager'
import { getTemperature, getTopP } from '../../utils/modelParameters'
import type { ResolvedReasoningInvocation } from '../../utils/reasoningSerializers'
import { createRequestCaptureContext, resolveUsageAttribution } from '../../utils/usageCapture'
import {
  materializePiProviderStream,
  PiMissingApiKeyError,
  piPreferredEndpointType,
  type PiStreamRequestOptions,
  PiUnsupportedProviderError,
  resolvePiProviderInjectionFromSnapshot
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
 * Pre-flight missing-credential failure. Carries the `i18nKey` + `providerId` the
 * renderer's ErrorBlock renders as the localized, provider-linked missing-key error
 * (the same `error.chat.no_api_key` surface auth failures document in types/error.ts).
 */
class PiMissingApiKeyTurnError extends Error {
  readonly i18nKey = 'chat.no_api_key'
  readonly providerId: string

  constructor(providerId: string) {
    super(`No API key is configured for provider "${providerId}"`)
    this.name = 'PiMissingApiKeyTurnError'
    this.providerId = providerId
  }
}

/**
 * Run this chat turn on the pi engine — the only chat engine. Returns a stream
 * (a one-chunk error stream for seam-rejected requests) or throws (pre-stream
 * failures the trunk renders through its serialized-error path).
 */
export async function tryStreamPiChatTurn(input: PiChatSeamInput): Promise<ReadableStream<UIMessageChunk>> {
  const { request, signal, provider, model, assistant } = input

  // Owner decision: the gateway serves tool-less clients only. A tool-carrying
  // request has no pi lane and no legacy fallback — fail loud at the seam.
  if (Object.keys(request.callOverrides?.tools ?? {}).length > 0) {
    logger.warn('pi chat engine: rejecting a tool-carrying gateway request', {
      topicId: request.conversation.topicId
    })
    return errorTextStream(t('chat.errors.client_tools_not_supported'))
  }

  const exclusionError = resolvePiExclusionError(input)
  if (exclusionError) {
    logger.warn('pi chat engine rejected the dispatch; serving an error turn', {
      topicId: request.conversation.topicId,
      modelId: model.id,
      reason: exclusionError.reason
    })
    return errorTextStream(exclusionError.errorText)
  }

  // The provider injection doubles as the last matrix row. An endpoint pi cannot
  // serve fails the turn explicitly; a provider with no credential throws the
  // i18n-keyed error so the renderer renders the localized missing-key UX.
  const injection = (() => {
    try {
      return resolvePiProviderInjectionFromSnapshot(provider, model, undefined, request.apiKeyOverride)
    } catch (error) {
      if (error instanceof PiUnsupportedProviderError) {
        logger.warn('pi chat engine: provider family has no pi api mapping; serving an error turn', {
          topicId: request.conversation.topicId,
          modelId: model.id,
          providerId: error.providerId
        })
        return {
          errorStream: errorTextStream(t('chat.errors.unsupported_endpoint_family', { provider: error.providerId }))
        }
      }
      if (error instanceof PiMissingApiKeyError) {
        logger.warn('pi chat engine: no API key configured; failing the turn', {
          topicId: request.conversation.topicId,
          modelId: model.id,
          providerId: error.providerId
        })
        throw new PiMissingApiKeyTurnError(error.providerId)
      }
      throw error
    }
  })()
  if ('errorStream' in injection) return injection.errorStream

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
          ...(invocation.providerCost ? { providerCost: invocation.providerCost } : {}),
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

/** A seam rejection: a machine reason for the log plus the user-facing turn error text. */
interface SeamExclusionError {
  reason: string
  errorText: string
}

/**
 * The per-execution matrix rows that once fell back to the legacy engine — now
 * explicit error turns (owner decision: the legacy engine is deleted; a pending
 * approval whose turn is gone cannot be resumed, so the user resends). Pure checks
 * only — the provider-injection try/catch lives in the main flow so the credential
 * rotation is consumed at most once. Client tools were moved out: they are a
 * separate seam error (tool-less gateway policy).
 */
function resolvePiExclusionError(input: PiChatSeamInput): SeamExclusionError | undefined {
  const { request } = input

  // Approval-resume dispatches serve a list that ENDS with the assistant anchor —
  // there is no trailing user message to slice into the prompt, and pi holds its
  // approvals in-process, so a continue-conversation only arrives when the original
  // turn is gone (crash/restart resume).
  if (request.trigger === 'continue-conversation') {
    return {
      reason: 'continue-conversation dispatch',
      errorText: t('chat.errors.approval_resume_gone')
    }
  }

  const messages = request.messages ?? []
  const trailing = messages[messages.length - 1]
  if (!trailing || trailing.role !== 'user') {
    return {
      reason: 'served list does not end with a user message',
      errorText: t('chat.errors.resend_user_message')
    }
  }

  return undefined
}

/** A one-chunk error stream — the dialect's terminal error chunk, as the engine emits on failure. */
function errorTextStream(errorText: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'error', errorText })
      controller.close()
    }
  })
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

/** The plan's selection as the neutral tool map the attachment budget prices. */
function toolSetOf(plan: ChatTurnPlan): Record<string, NeutralTool> | undefined {
  if (plan.selectedEntries.length === 0) return undefined
  const tools: Record<string, NeutralTool> = {}
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
