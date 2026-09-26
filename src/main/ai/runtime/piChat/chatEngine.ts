import type { AssistantMessage, ImageContent, ThinkingLevel } from '@earendil-works/pi-ai'
/**
 * W2 — the pi chat engine (plan: docs/plans/2026-09-pi-unification.md, Phase 1).
 *
 * One in-memory pi `AgentSession` per `StreamExecution`: the engine converts the
 * served history into session entries (W1), registers the Cherry-resolved provider
 * on an isolated `ModelRuntime` (the D1 pattern the agent connection uses), prompts
 * with the turn's trailing user content, and streams `UIMessageChunk`s through the
 * existing `PiStreamAdapter` into the untouched trunk. Born at turn start, disposed at
 * turn end — no resume token, no reconcile, no warm state (the architecture decision
 * that keeps it out of the driver registry).
 *
 * Input is PREPARED (provider config materialized, prompt assembled, history served)
 * — the request-to-input translation is the seam wiring's job (W6), so this module
 * stays orchestrable in tests by a faux provider without services or DB.
 *
 * Chat-vs-agent semantics baked in here:
 * - `expandPromptTemplates: false` — user text is model input, never a pi command.
 * - All discovery suppressed (`noExtensions`/`noSkills`/`noPromptTemplates`/
 *   `noThemes` AND `noContextFiles` — chat has no workspace) with the chat prompt as
 *   the sole system-prompt source, so pi's coding persona never leaks into a topic.
 * - Turn failure surfaces as a stream error, abort as a clean close (no `finish`),
 *   matching the legacy engine's `Agent.stream` contract.
 * - Replayed history carries the LIVE turn's provider identity when the caller says the
 *   message came from the same model (`isSameModelAsTurn`); pi's own same-model rules
 *   (signed thinking, tool-call signatures) key off that identity, including the
 *   per-execution provider name only this engine knows.
 */
import type {
  CreateAgentSessionOptions,
  ExtensionContext,
  ExtensionFactory,
  ProviderConfig,
  ToolCallEvent,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { context as otelContext, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import type { FinishReason } from 'ai'

import { application } from '@application'
import { loggerService } from '@logger'
import type { MediaCapabilities } from '@main/ai/messages/messageCapabilities'
import { TRACER_NAME } from '@main/ai/observability'
import type { CherryUIMessage, CherryUIMessageChunk } from '@shared/data/types/message'

import { withPiInvocationCapture, type PiInvocationMetrics } from '../pi/PiRuntimeConnection'
import { createIsolatedPiModelRuntime, loadPiSdk } from '../pi/piSdk'
import { PiStreamAdapter } from '../pi/piStreamAdapter'
import { createPiProviderExtension } from '../pi/providerExtension'
import type { AgentRuntimeUsageInvocation } from '../types'
import { toPiSessionEntries, type PiHistoryModelDescriptor } from './historyConverter'

const logger = loggerService.withContext('PiChatEngine')

/** Provider source for one execution — from `resolvePiProviderInjection` + `materializePiProviderStream`, or a faux config in tests. */
export interface PiChatProviderSource {
  /** Cherry provider id (or test name); the engine namespaces it per execution for fan-out concurrency. */
  name: string
  /** Materialized config — `streamSimple` must be set (`materializePiProviderStream` guarantees it). */
  config: ProviderConfig
  /** Real Cherry key — injected via `setRuntimeApiKey`, never into the config. */
  apiKey: string
  /** pi model id to select (`apiModelId`). */
  modelId: string
}

export interface PiChatTurnRequest {
  /** Identifies the in-memory session — one per StreamExecution. */
  executionId: string
  provider: PiChatProviderSource
  /** Assembled chat system prompt; the pi coding persona is suppressed either way. */
  systemPrompt?: string
  /**
   * Served history EXCLUDING the turn's trailing user message. The engine refuses a turn
   * whose history already contains `prompt.messageId`, so a mis-sliced handoff fails loudly
   * instead of sending the question twice.
   */
  history: readonly CherryUIMessage[]
  /** The turn's user content: text verbatim (no command expansion), images inline. */
  prompt: { messageId: string; text: string; images?: ImageContent[] }
  thinkingLevel?: ThinkingLevel
  /**
   * pi tools for the turn (W4a's `chatToolAdapter` converts the registry; omitted ⇒
   * tool-less turn). Every handed tool is a Cherry registry tool, so its part payload is
   * the result's `details` — the raw execute output the cards, deferred-output lookups
   * and the history converter read.
   */
  tools?: readonly ToolDefinition[]
  /**
   * W4a per-tool-call authorization. Supplied by the seam (built from the registry via
   * `toPiChatToolSurface`, which pairs it with the tools it guards); the engine itself
   * stays gate-free. While this decides,
   * the session holds the tool-call promise in-process — the resume mechanics differ from
   * the legacy engine's pause-and-redispatch, the approval card contract does not.
   */
  authorizer?: PiChatToolAuthorizer
  /**
   * Whether a persisted assistant message came from the same provider+model as this turn.
   * pi replays signed thinking (and tool-call signatures) only for same-model messages, and
   * that comparison includes the per-execution provider identity THIS engine registers — so
   * the engine builds the descriptor and the caller answers only the domain question (e.g.
   * `message.metadata?.modelId === currentUniqueModelId`). Absent ⇒ every replayed message
   * is treated as cross-model.
   */
  isSameModelAsTurn?: (message: CherryUIMessage) => boolean
  mediaCapabilities?: MediaCapabilities
  /** Billing sink — one call per provider invocation, deduplicated by response id. */
  onInvocation?: (invocation: AgentRuntimeUsageInvocation) => void
}

function finiteTokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** One tool call the engine is about to execute, as pi's `tool_call` hook sees it. */
export interface PiChatToolCallRequest {
  toolName: string
  toolCallId: string
  /** Mutated in place when an approval decision carries an edited input. */
  input: Record<string, unknown>
  signal?: AbortSignal
}

export interface PiChatToolCallVerdict {
  block: true
  reason: string
  /**
   * A user denial (not a policy block): the call surfaces as `tool-output-denied`
   * — the state the renderer card and the history converter treat as a denial —
   * instead of pi's default error result for a blocked call.
   */
  denied?: boolean
}

/**
 * Authorize one tool call; `undefined` allows it. `emit` pushes a chunk into this
 * turn's stream (how the `tool-approval-request` chunk reaches the trunk).
 */
export type PiChatToolAuthorizer = (
  call: PiChatToolCallRequest,
  emit: (chunk: CherryUIMessageChunk) => void
) => Promise<PiChatToolCallVerdict | undefined>

/**
 * W4a: wrap the seam's authorizer in pi's `tool_call` hook. The hook fires after
 * `tool_execution_start`, so the tool part exists before the approval chunk
 * references its id (same ordering the agent approval pipeline relies on).
 */
function createToolAuthorizationExtension(
  authorizer: PiChatToolAuthorizer,
  emit: (chunk: CherryUIMessageChunk) => void,
  onDenied: (toolCallId: string) => void
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: ToolCallEvent, extCtx: ExtensionContext) => {
      const verdict = await authorizer(
        {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: event.input,
          signal: extCtx.signal
        },
        emit
      )
      if (verdict === undefined) return undefined
      if (verdict.denied) onDenied(event.toolCallId)
      return { block: true, reason: verdict.reason }
    })
  }
}

/**
 * Force the chat prompt through `before_agent_start`: the forced path is opaque
 * (`forceSystemPrompt`) — no pi coding persona, no tools/rules/docs sections, and no
 * `<cwd>` block, which pi's structured path appends unconditionally (it would leak the
 * agents dir into every topic). An empty prompt forces an empty head; providers
 * serialize falsy system text as no system message at all.
 */
function createChatPromptExtension(systemPrompt: string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', async () => ({ systemPrompt }))
  }
}

type TurnVerdict = { finishReason: FinishReason } | { failure: Error }

/**
 * Terminal verdict for a completed pi run. `error` and `length` are failures (pi's
 * `stopReason` vocabulary has no other failure mode); everything else finishes. Aborts never
 * reach here — the caller closes the stream on the signal, or on pi's own `aborted`
 * stop reason.
 */
function turnVerdict(stopReason: string | undefined, agentError: string | undefined): TurnVerdict {
  if (stopReason === 'error') return { failure: new Error(agentError ?? 'pi chat turn failed') }
  if (stopReason === 'length') {
    return {
      failure: new Error(
        agentError ??
          'Response truncated at the model output limit (stopReason: length). The reply may be incomplete or empty — try continuing the turn or retrying with a higher maximum output.'
      )
    }
  }
  return { finishReason: stopReason === 'toolUse' ? 'tool-calls' : 'stop' }
}

/** pi `input` excludes the cache buckets it reports separately; the record total is inclusive. */
function buildInvocation(
  request: PiChatTurnRequest,
  message: AssistantMessage,
  metrics?: PiInvocationMetrics
): AgentRuntimeUsageInvocation {
  const noCacheTokens = finiteTokenCount(message.usage.input)
  const cacheReadTokens = finiteTokenCount(message.usage.cacheRead)
  const cacheWriteTokens = finiteTokenCount(message.usage.cacheWrite)
  const inputTokens = noCacheTokens + cacheReadTokens + cacheWriteTokens
  const outputTokens = finiteTokenCount(message.usage.output)
  return {
    requestId: `pi-chat:${request.executionId}:${message.responseId?.trim() || `${message.timestamp}:${message.model}`}`,
    model: message.responseModel?.trim() || message.model || request.provider.modelId,
    messageAssociation: 'current-turn',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(message.usage.reasoning !== undefined ? { reasoningTokens: finiteTokenCount(message.usage.reasoning) } : {}),
      noCacheTokens,
      cacheReadTokens,
      cacheWriteTokens
    },
    ...(metrics ? { metrics } : {})
  }
}

interface ProviderSpanObserver {
  complete(message: AssistantMessage): void
  error(error: unknown): void
}

/**
 * Provider span under the trunk's active context (`runExecutionLoop` wraps the
 * execution in its root span). Attribute names mirror the agent connection's
 * `pi.generate_content` spans; a no-op when developer-mode tracing is off.
 */
function startProviderSpan(model: { provider?: string; id?: string }): ProviderSpanObserver | undefined {
  let span: Span
  try {
    span = trace.getTracer(TRACER_NAME).startSpan(
      'pi.generate_content',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          ...(model.provider ? { 'gen_ai.provider.name': model.provider } : {}),
          ...(model.id ? { 'gen_ai.request.model': model.id } : {})
        }
      },
      otelContext.active()
    )
  } catch (error) {
    logger.warn('Failed to start Pi chat provider span', { error })
    return undefined
  }
  if (!span.isRecording()) return undefined
  return {
    complete(message) {
      try {
        const inputTokens =
          finiteTokenCount(message.usage.input) +
          finiteTokenCount(message.usage.cacheRead) +
          finiteTokenCount(message.usage.cacheWrite)
        span.setAttribute('gen_ai.response.model', message.responseModel?.trim() || message.model)
        if (message.responseId?.trim()) span.setAttribute('gen_ai.response.id', message.responseId.trim())
        span.setAttribute('gen_ai.response.finish_reasons', [message.stopReason])
        span.setAttribute('gen_ai.usage.input_tokens', inputTokens)
        span.setAttribute('gen_ai.usage.output_tokens', finiteTokenCount(message.usage.output))
        span.setAttribute('gen_ai.usage.cache_read_tokens', finiteTokenCount(message.usage.cacheRead))
        span.setAttribute('gen_ai.usage.cache_write_tokens', finiteTokenCount(message.usage.cacheWrite))
        if (message.usage.reasoning !== undefined) {
          span.setAttribute('gen_ai.usage.reasoning_tokens', finiteTokenCount(message.usage.reasoning))
        }
      } catch (error) {
        logger.warn('Failed to annotate Pi chat provider span', { error })
      }
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
    },
    error(error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message })
      span.recordException(failure)
      span.end()
    }
  }
}

/**
 * Stream one chat turn on an in-memory pi session. Setup failures reject before any
 * stream exists (the trunk routes them through its pre-stream error path); turn
 * failures error the stream; aborts close it cleanly without a `finish` chunk.
 */
export async function streamPiChatTurn(
  request: PiChatTurnRequest,
  signal: AbortSignal
): Promise<ReadableStream<CherryUIMessageChunk>> {
  // The seam slices the trailing user message out of the served list before calling; if it
  // did not, the question would ride in both the prompt and the history. Fail setup instead.
  if (request.history.some((message) => message.id === request.prompt.messageId)) {
    throw new Error(
      `pi chat turn ${request.executionId}: history already contains the prompt message ${request.prompt.messageId}`
    )
  }
  const pi = await loadPiSdk()
  const piDir = application.getPath('feature.agents.pi.root')

  const streamSimple = request.provider.config.streamSimple
  if (!streamSimple) {
    throw new Error(`pi chat provider "${request.provider.name}" has no streamSimple (materialize the injection first)`)
  }
  const committedInvocationIds = new Set<string>()
  const capturedConfig = withPiInvocationCapture(
    request.provider.config,
    streamSimple,
    (message, metrics) => {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return
      const invocation = buildInvocation(request, message, metrics)
      if (committedInvocationIds.has(invocation.requestId)) return
      committedInvocationIds.add(invocation.requestId)
      request.onInvocation?.(invocation)
    },
    startProviderSpan
  )

  // Provider registration namespaced per execution: multi-model fan-out runs
  // concurrent engines, and each must own an isolated registration (plan D1).
  const runtimeProviderName = `${request.provider.name}:${request.executionId}`
  const modelRuntime = await createIsolatedPiModelRuntime()
  await modelRuntime.setRuntimeApiKey(runtimeProviderName, request.provider.apiKey)
  modelRuntime.registerProvider(runtimeProviderName, capturedConfig)
  const model = modelRuntime.getModel(runtimeProviderName, request.provider.modelId)
  if (!model) {
    throw new Error(`pi chat model ${runtimeProviderName}/${request.provider.modelId} could not be resolved`)
  }

  const isSameModelAsTurn = request.isSameModelAsTurn
  const entries = toPiSessionEntries(request.history, {
    // pi compares provider+api+model against the live turn, and the provider name is this
    // engine's own registration — so the descriptor is built here, not by the caller.
    ...(isSameModelAsTurn && {
      resolveHistoryModel: (message: CherryUIMessage) =>
        isSameModelAsTurn(message)
          ? ({ api: model.api, provider: model.provider, model: model.id } satisfies PiHistoryModelDescriptor)
          : undefined
    }),
    ...(request.mediaCapabilities && { mediaCapabilities: request.mediaCapabilities }),
    ...(request.tools && { declaredToolNames: new Set(request.tools.map((tool) => tool.name)) })
  })

  // Stream plumbing first: the authorization extension (built below) emits through the
  // same enqueue path as the adapter, and the reader may not exist yet when it does.
  let streamSettled = false
  let controllerRef: ReadableStreamDefaultController<CherryUIMessageChunk> | undefined
  const enqueueChunk = (chunk: CherryUIMessageChunk): void => {
    if (streamSettled || !controllerRef) return
    try {
      controllerRef.enqueue(chunk)
    } catch (error) {
      logger.warn('pi chat chunk dropped after stream settle', { error })
    }
  }

  // A denied call arrives from pi as an error result (the block reason); the trunk's
  // denial state is what the renderer card and the history converter expect.
  const deniedToolCalls = new Set<string>()

  const settingsManager = pi.SettingsManager.inMemory({}, { projectTrusted: true })
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: piDir,
    agentDir: piDir,
    settingsManager,
    // Chat owns the prompt end-to-end: every discovery channel is off (unlike the
    // agent workspace, `noContextFiles` too — a topic has no project directory).
    // Explicit factories still load under `noExtensions` — only discovery is disabled.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createPiProviderExtension(runtimeProviderName, capturedConfig),
      createChatPromptExtension(request.systemPrompt ?? ''),
      ...(request.authorizer
        ? [createToolAuthorizationExtension(request.authorizer, enqueueChunk, (id) => deniedToolCalls.add(id))]
        : [])
    ],
    // Belt-only (the forcing extension is the real gate): the loader override at
    // least keeps pi's default persona out of the options the extension observes.
    systemPromptOverride: () => request.systemPrompt ?? ''
  })
  await resourceLoader.reload()

  const sessionManager = pi.SessionManager.inMemory(piDir, { id: request.executionId }, entries)
  const tools = request.tools ?? []
  const created = await pi.createAgentSession({
    cwd: piDir,
    agentDir: piDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    model,
    ...(request.thinkingLevel && {
      // pi-ai's union carries the patched `ultra` effort; pi-agent-core's copy of the
      // type lags. The value flows through to pi-ai, whose models guard it themselves.
      thinkingLevel: request.thinkingLevel as CreateAgentSessionOptions['thinkingLevel']
    }),
    ...(tools.length > 0 ? { tools: tools.map((tool) => tool.name), customTools: [...tools] } : { noTools: 'all' })
  })
  const session = created.session

  let lastStopReason: string | undefined
  let lastAgentError: string | undefined
  const adapter = new PiStreamAdapter(
    {
      enqueue: (chunk) => {
        if (chunk.type === 'tool-output-error' && deniedToolCalls.has(chunk.toolCallId)) {
          enqueueChunk({ type: 'tool-output-denied', toolCallId: chunk.toolCallId })
          return
        }
        enqueueChunk(chunk)
      }
    },
    // Chat tool parts carry the raw execute output (legacy parity for cards, deferred
    // lookups and replay); pi's native `{content, details}` envelope is what the agent
    // path's pi-owned tools keep.
    new Set(tools.map((tool) => tool.name))
  )
  const unsubscribe = session.subscribe((event) => {
    // Content/tool/usage projection first; lifecycle bookkeeping after, mirroring
    // the agent connection's handlePiEvent ordering.
    adapter.handleEvent(event)
    if (event.type === 'turn_end') {
      if (event.message.role === 'assistant' && event.message.stopReason) {
        lastStopReason = event.message.stopReason
      }
      return
    }
    if (event.type === 'agent_end') {
      // pi retries internally; a retry means the loop is not done, so the prior
      // turn_end's stop reason must not taint the eventual verdict.
      if (event.willRetry) {
        lastStopReason = undefined
        lastAgentError = undefined
      } else {
        lastAgentError = lastErrorMessage(event.messages)
      }
    }
  })

  const abortSession = (): void => {
    void session.abort().catch((error) => logger.warn('pi chat session abort failed', { error }))
  }

  const cleanup = (): void => {
    if (streamSettled) return
    streamSettled = true
    signal.removeEventListener('abort', abortSession)
    unsubscribe()
    try {
      session.dispose()
    } catch (error) {
      logger.warn('pi chat session dispose failed', { error })
    }
    // pi resolves extension providers per runtime, so there is no global api
    // registration to undo — the isolated runtime is dropped with this execution.
  }

  const stream = new ReadableStream<CherryUIMessageChunk>({
    start(controller) {
      controllerRef = controller
      controller.enqueue({ type: 'start' })

      const settleClosed = (): void => {
        cleanup()
        try {
          controller.close()
        } catch {
          // A peer cancel may have closed the readable side already.
        }
      }
      const fail = (error: unknown): void => {
        cleanup()
        try {
          controller.error(error)
        } catch {
          // Already errored/cancelled — the terminal state was signalled once.
        }
      }

      // An abort can land while the session is built; `addEventListener` never fires for an
      // already-aborted signal, so a never-started turn must close instead of prompting.
      if (signal.aborted) {
        settleClosed()
        return
      }
      signal.addEventListener('abort', abortSession, { once: true })

      session
        .prompt(request.prompt.text, {
          images: request.prompt.images,
          // Chat text is model input verbatim — never a pi command or skill trigger.
          expandPromptTemplates: false
        })
        .then(
          () => {
            // A pi-side abort (reader cancel today, W4a approval flows later) with a live
            // signal closes cleanly like a signal abort — an aborted turn never emits `finish`.
            if (signal.aborted || lastStopReason === 'aborted' || streamSettled) {
              settleClosed()
              return
            }
            const verdict = turnVerdict(lastStopReason, lastAgentError)
            if ('failure' in verdict) {
              fail(verdict.failure)
              return
            }
            enqueueChunk({ type: 'finish', finishReason: verdict.finishReason })
            settleClosed()
          },
          (error: unknown) => {
            if (signal.aborted) {
              settleClosed()
              return
            }
            fail(error)
          }
        )
    },
    cancel() {
      abortSession()
    }
  })

  return stream
}

function lastErrorMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; errorMessage?: string }
    if (message.role === 'assistant' && typeof message.errorMessage === 'string') return message.errorMessage
  }
  return undefined
}
