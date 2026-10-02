/**
 * Pi one-shot text generation: the non-streaming twin of the pi chat engine
 * (`piChat/chatEngine.ts`). One request, no session, no tools — the injection
 * seam (`modelInjection.ts`) resolves the provider, the stream is materialized
 * exactly like an interactive turn, and the event stream is driven to
 * completion on an isolated runtime (the D1 pattern: the key reaches the
 * request via `setRuntimeApiKey`, never through the config).
 *
 * Consumers: `AiService.generateText` (renderer one-shots, health checks) and
 * durable compaction's summarize call.
 */
import type { AssistantMessage, Context, ThinkingLevel, UserMessage } from '@earendil-works/pi-ai'

import { loggerService } from '@logger'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type { ReasoningEffortOption } from '@shared/types/aiSdk'

import {
  materializePiProviderStream,
  type PiDirectProviderInjection,
  type PiStreamRequestOptions,
  resolvePiProviderInjectionFromSnapshot,
  withPiSessionHeader
} from './modelInjection'
import { toProviderCost, type PiProviderCost } from './piCost'
import { createIsolatedPiModelRuntime } from './piSdk'

const logger = loggerService.withContext('PiOneShot')

/** One turn message: plain text under its conversation role. */
export interface PiOneShotTurnMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PiOneShotTextRequest {
  provider: Provider
  model: Model
  /** Leading system prompt; omitted from the request entirely when absent. */
  systemPrompt?: string
  /** Transcript — the last entry is the prompt; earlier entries replay as history. */
  messages: readonly PiOneShotTurnMessage[]
  signal?: AbortSignal
  /** Explicit serving key (provider health checks); replaces the rotated selection. */
  apiKeyOverride?: string
  /** Stamps the OpenCode per-conversation session header when the provider is preset-scoped. */
  sessionId?: string
  /** Request reasoning selection; `undefined` sends no reasoning parameter (provider default). */
  reasoning?: ReasoningEffortOption
  /** Request-level stream options (output cap / sampling) — the seam's `piStreamRequestOptions` tail. */
  requestOptions?: PiStreamRequestOptions
}

/** pi usage normalized for Cherry's usage records (input inclusive of the cache buckets). */
export interface PiOneShotUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
}

export interface PiOneShotTextResult {
  text: string
  usage: PiOneShotUsage
  /** Provider-computed cost from pi's pricing, when rates are known (see `toProviderCost`). */
  providerCost: PiProviderCost | undefined
  /** Injection the call ran on — model id + credential receipt for usage attribution. */
  injection: PiDirectProviderInjection
  /** Wall-clock duration of the provider call, for usage-record metrics. */
  timeCompletionMs: number
}

/** pi `input` excludes the cache buckets it reports separately; the record total is inclusive. */
function finiteTokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function toUsageRecord(usage: AssistantMessage['usage']): PiOneShotUsage {
  const noCacheTokens = finiteTokenCount(usage.input)
  const cacheReadTokens = finiteTokenCount(usage.cacheRead)
  const cacheWriteTokens = finiteTokenCount(usage.cacheWrite)
  const outputTokens = finiteTokenCount(usage.output)
  const inputTokens = noCacheTokens + cacheReadTokens + cacheWriteTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    noCacheTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(usage.reasoning !== undefined ? { reasoningTokens: finiteTokenCount(usage.reasoning) } : {})
  }
}

/** Thinking blocks stay out of `text` — the one-shot contract is the final answer only. */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Replay `assistant` history with the identity of the model serving the request, so
 * pi's same-model transcript rules treat it as this model's own prior output.
 */
function toPiContextMessages(
  messages: readonly PiOneShotTurnMessage[],
  injection: PiDirectProviderInjection
): Context['messages'] {
  const timestamp = Date.now()
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: message.content }],
        api: injection.api,
        provider: injection.providerName,
        model: injection.modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop' as const,
        timestamp
      }
    }
    return { role: 'user', content: message.content, timestamp } satisfies UserMessage
  })
}

/**
 * One-shot reasoning selection → pi thinking level. `none` and an absent selection
 * send NO parameter — pi's own agent loop implements `off` the same way, and a
 * literal `'off'` handed to `streamSimple` breaks the anthropic adapter (a NaN
 * thinking budget) while clamping tiered openai vocabularies back UP. Tier
 * vocabulary is shared with `chatTurnSeam.resolvePiThinkingLevel`; the twin lives
 * here because the seam module is frozen while the two lanes converge.
 */
function oneShotThinkingLevel(reasoning: ReasoningEffortOption | undefined): ThinkingLevel | undefined {
  if (reasoning === undefined || reasoning === 'default' || reasoning === 'none') return undefined
  if (reasoning === 'auto') return 'medium'
  if (!PI_ONE_SHOT_TIERS.has(reasoning)) {
    logger.warn('reasoning selection has no pi thinking level; sending none', { reasoning })
    return undefined
  }
  return reasoning
}

/** Cherry's effort tiers that pi accepts verbatim (mirrors the seam's ladder). */
const PI_ONE_SHOT_TIERS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * Run one non-streaming text generation on pi. Rejects on request failure and on
 * abort; a provider-side failure surfaces as the stream's own error message.
 */
export async function runPiOneShotText(request: PiOneShotTextRequest): Promise<PiOneShotTextResult> {
  request.signal?.throwIfAborted()

  let injection = resolvePiProviderInjectionFromSnapshot(
    request.provider,
    request.model,
    undefined,
    request.apiKeyOverride
  )
  if (request.sessionId !== undefined) {
    injection = withPiSessionHeader(injection, request.provider, request.sessionId)
  }
  const materialized = await materializePiProviderStream(injection, request.requestOptions)

  const runtime = await createIsolatedPiModelRuntime()
  await runtime.setRuntimeApiKey(injection.providerName, injection.apiKey)
  runtime.registerProvider(injection.providerName, materialized.providerConfig)
  const piModel = runtime.getModel(injection.providerName, injection.modelId)
  if (!piModel) {
    throw new Error(`pi one-shot: model ${injection.providerName}/${injection.modelId} could not be resolved`)
  }

  const context: Context = {
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    messages: toPiContextMessages(request.messages, injection)
  }
  const thinkingLevel = oneShotThinkingLevel(request.reasoning)
  const startedAt = performance.now()
  const message = await runtime.completeSimple(piModel, context, {
    ...(request.signal ? { signal: request.signal } : {}),
    ...(thinkingLevel ? { reasoning: thinkingLevel } : {})
  })
  const timeCompletionMs = Math.max(0, Math.round(performance.now() - startedAt))

  if (message.stopReason === 'error') {
    throw new Error(message.errorMessage?.trim() || `pi one-shot generation failed (${injection.providerName})`)
  }
  if (message.stopReason === 'aborted') {
    throw new DOMException('pi one-shot generation aborted', 'AbortError')
  }
  return {
    text: assistantText(message),
    usage: toUsageRecord(message.usage),
    providerCost: toProviderCost(message.usage.cost),
    injection,
    timeCompletionMs
  }
}
