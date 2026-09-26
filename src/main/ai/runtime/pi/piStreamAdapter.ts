/**
 * Translate pi `AgentSessionEvent`s into Cherry `UIMessageChunk`s (plan D3).
 *
 * pi's event vocabulary differs from the other runtimes', so this is a fresh, smaller
 * adapter (not a reuse of the Claude `streamAdapter`). It maps only the
 * content/tool/usage surface; turn lifecycle (`agent_end` → `turn-complete`,
 * resume tokens, errors) is owned by `PiRuntimeConnection`.
 *
 * Mapping:
 * - `message_update` text/thinking deltas → text and reasoning chunks
 * - `tool_execution_start` → tool-input-start + tool-input-available
 * - `tool_execution_end` → tool-output-available / tool-output-error
 * - `turn_end` (assistant message) → `message-metadata` usage projection
 *
 * Tool parts are stamped with the pi runtime transport tag
 * (D8) so the renderer routes them to the generic pi tool card.
 *
 * Reasoning/text/tool parts also persist pi's replay signatures
 * (`thinkingSignature`, `textSignature`, tool `thoughtSignature`) under
 * `providerMetadata.pi` — the history converter replays them for same-model
 * turns the same way it replays the legacy AI SDK provider keys
 * (`anthropic.signature`, `google.thoughtSignature`, `openai.itemId`).
 */
import type { AgentSessionEvent, AgentToolResult } from '@earendil-works/pi-coding-agent'

import { AGENT_RUNTIME_CAPABILITIES } from '@shared/ai/agentRuntimeCapabilities'
import { PI_TOOL_CALL_TOOL_NAME, PI_TOOL_EXEC_TOOL_NAME, PI_TOOL_SEARCH_TOOL_NAME } from '@shared/ai/piBuiltinTools'
import { parseFunctionCallToolName } from '@shared/ai/tools/mcpToolName'
import type { CherryUIMessageChunk } from '@shared/data/types/message'

export interface PiStreamSink {
  enqueue(chunk: CherryUIMessageChunk): void
}

/** pi transport tag consumed by the renderer's tool-part routing (D8). */
export const PI_TRANSPORT = AGENT_RUNTIME_CAPABILITIES.pi.transport

function toolProviderMetadata(toolName: string, extra: Record<string, unknown> = {}) {
  const parsed = parseFunctionCallToolName(toolName)
  return {
    cherry: {
      transport: PI_TRANSPORT,
      tool: parsed
        ? { type: 'mcp' as const, name: parsed.toolPart, serverName: parsed.serverPart }
        : { type: 'builtin' as const, name: toolName }
    },
    pi: { toolName, ...extra }
  }
}

export class PiStreamAdapter {
  /** Bumped on every assistant `message_start` so content-part ids stay unique
   *  across the multiple assistant messages of a single multi-turn tool loop
   *  (pi resets `contentIndex` to 0 per message). */
  private messageSeq = 0
  private readonly startedTools = new Set<string>()
  /** Tool-call signatures captured from `message_update` blocks, keyed by toolCallId —
   *  attached to the `tool_execution_*` chunks that carry the call to the trunk. */
  private readonly toolSignatures = new Map<string, string>()
  /** Running token totals for the current turn (`agent_start` → `agent_end`).
   *  pi's `Usage` is per-assistant-message, but a Cherry turn spans N `turn_end`s
   *  (one per LLM response in the tool loop) that accumulate into a single message
   *  whose `message-metadata` is last-wins. Summing here makes the final chunk carry
   *  the whole turn's tokens instead of just the last LLM call — parity with the
   *  Claude driver, whose SDK `result` usage is already a turn total. */
  private turnUsage = emptyTurnUsage()

  constructor(
    private readonly sink: PiStreamSink,
    /**
     * Tool names whose part payload is the result's `details` rather than pi's native
     * `AgentToolResult` envelope: Cherry's own tool surfaces (the chat engine's registry
     * tools). Renderer cards, deferred-output lookups and the history converter read the
     * raw payload for those tools — the same shape the legacy engine persisted — while
     * pi's builtin tools keep the envelope their cards are built on.
     */
    private readonly payloadToolNames?: ReadonlySet<string>
  ) {}

  handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        // New turn — reset the per-turn token accumulator.
        this.turnUsage = emptyTurnUsage()
        return
      case 'message_start':
        // An assistant message opens a step: the trunk's accumulator materialises
        // `start-step` into a `step-start` part, which message-edit and legacy step
        // restoration derive boundaries from — a turn persisted without it cannot be
        // split back later. User/toolResult starts only bump the id sequence
        // (harmless: ids just need to be unique).
        if (event.message.role === 'assistant') this.sink.enqueue({ type: 'start-step' })
        this.messageSeq += 1
        return
      case 'message_update':
        this.handleAssistantDelta(event.assistantMessageEvent)
        return
      case 'tool_execution_start':
        this.handleToolStart(event.toolCallId, event.toolName, event.args)
        return
      case 'tool_execution_end':
        this.handleToolEnd(event.toolCallId, event.toolName, event.result, event.isError)
        return
      case 'turn_end':
        this.handleTurnEnd(event.message)
        return
      default:
        // tool_execution_update (no standard partial-output chunk in v1),
        // agent_end, compaction_*, retry, queue_update, etc. are lifecycle
        // events handled by the connection or intentionally ignored.
        return
    }
  }

  private textId(contentIndex: number): string {
    return `pi-${this.messageSeq}-text-${contentIndex}`
  }

  private reasoningId(contentIndex: number): string {
    return `pi-${this.messageSeq}-reasoning-${contentIndex}`
  }

  private handleAssistantDelta(event: AssistantMessageEventLike): void {
    switch (event.type) {
      case 'text_start':
        this.sink.enqueue({ type: 'text-start', id: this.textId(event.contentIndex) })
        return
      case 'text_delta':
        this.sink.enqueue({ type: 'text-delta', id: this.textId(event.contentIndex), delta: event.delta })
        return
      case 'text_end': {
        const textSignature = this.blockSignature(event, 'textSignature')
        this.sink.enqueue({
          type: 'text-end',
          id: this.textId(event.contentIndex),
          ...(textSignature && { providerMetadata: { pi: { textSignature } } })
        })
        return
      }
      case 'thinking_start':
        this.sink.enqueue({ type: 'reasoning-start', id: this.reasoningId(event.contentIndex) })
        return
      case 'thinking_delta':
        this.sink.enqueue({ type: 'reasoning-delta', id: this.reasoningId(event.contentIndex), delta: event.delta })
        return
      case 'thinking_end': {
        const thinking = this.thinkingMetadata(event)
        this.sink.enqueue({
          type: 'reasoning-end',
          id: this.reasoningId(event.contentIndex),
          ...(thinking && { providerMetadata: { pi: thinking } })
        })
        return
      }
      case 'toolcall_end':
        this.captureToolSignature(event)
        return
      default:
        // start/done/error and toolcall_start/delta — tool calls are surfaced via
        // the tool_execution_* events instead, which carry the executed args.
        return
    }
  }

  /** pi's replay signature for the finished content block, if the provider sent one. */
  private blockSignature(
    event: Extract<AssistantMessageEventLike, { contentIndex: number; partial?: unknown }>,
    key: 'thinkingSignature' | 'textSignature'
  ): string | undefined {
    const block = this.contentBlock(event)
    if (block === undefined) return undefined
    const signature = block[key]
    return typeof signature === 'string' && signature.length > 0 ? signature : undefined
  }

  /**
   * The `pi` metadata for a finished thinking block: its replay signature plus pi's
   * `redacted` marker. The Anthropic serializer only emits `redacted_thinking` for a
   * flagged block, and refuses the opaque payload as a normal thinking signature — so the
   * flag is what keeps redacted reasoning replayable at all.
   */
  private thinkingMetadata(
    event: Extract<AssistantMessageEventLike, { contentIndex: number; partial?: unknown }>
  ): { thinkingSignature: string; redacted?: true } | undefined {
    const thinkingSignature = this.blockSignature(event, 'thinkingSignature')
    if (thinkingSignature === undefined) return undefined
    return this.contentBlock(event)?.redacted === true ? { thinkingSignature, redacted: true } : { thinkingSignature }
  }

  private contentBlock(event: { contentIndex: number; partial?: unknown }): Record<string, unknown> | undefined {
    const content = (event.partial as { content?: unknown[] } | undefined)?.content
    const block = content?.[event.contentIndex]
    return block !== null && typeof block === 'object' ? (block as Record<string, unknown>) : undefined
  }

  /** A finished tool-call block may carry a `thoughtSignature` (Google) — keep it for the
   *  `tool_execution_*` chunks, which is where the call reaches the trunk. */
  private captureToolSignature(event: { contentIndex: number; partial?: unknown }): void {
    const block = this.contentBlock(event)
    if (block === undefined || block.type !== 'toolCall') return
    const signature = block.thoughtSignature
    if (typeof signature === 'string' && signature.length > 0 && typeof block.id === 'string') {
      this.toolSignatures.set(block.id, signature)
    }
  }

  /** Transport routing metadata plus the call's replay signature when the provider sent one. */
  private toolMetadataFor(toolCallId: string, toolName: string): ReturnType<typeof toolProviderMetadata> {
    const thoughtSignature = this.toolSignatures.get(toolCallId)
    return toolProviderMetadata(toolName, thoughtSignature !== undefined ? { thoughtSignature } : undefined)
  }

  private handleToolStart(toolCallId: string, toolName: string, args: unknown): void {
    if (this.startedTools.has(toolCallId)) return
    this.startedTools.add(toolCallId)
    const metadata = this.toolMetadataFor(toolCallId, toolName)
    this.sink.enqueue({
      type: 'tool-input-start',
      toolCallId,
      toolName,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: metadata
    })
    this.sink.enqueue({
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input: args ?? {},
      providerExecuted: true,
      dynamic: true,
      providerMetadata: metadata
    })
  }

  private handleToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    // A tool result with no preceding start (defensive) still needs its input parts.
    if (!this.startedTools.has(toolCallId)) this.handleToolStart(toolCallId, toolName, {})
    const metadata = this.toolMetadataFor(toolCallId, toolName)
    if (isError) {
      this.sink.enqueue({
        type: 'tool-output-error',
        toolCallId,
        errorText: errorTextFor(toolName, result, this.payloadToolNames),
        dynamic: true,
        providerExecuted: true,
        providerMetadata: metadata
      })
      return
    }
    this.sink.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output: projectPiToolOutput(toolName, result, this.payloadToolNames),
      dynamic: true,
      providerExecuted: true,
      providerMetadata: metadata
    })
  }

  private handleTurnEnd(message: unknown): void {
    const usage = extractAssistantUsage(message)
    if (!usage) return
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
    const completionTokens = usage.output
    const totalTokens = usage.totalTokens && usage.totalTokens > 0 ? usage.totalTokens : promptTokens + completionTokens
    // Accumulate across the turn's LLM responses; emit the running total so the
    // last-wins `message-metadata` carries the whole turn, not just this response.
    this.turnUsage.promptTokens += promptTokens
    this.turnUsage.completionTokens += completionTokens
    this.turnUsage.totalTokens += totalTokens
    if (usage.reasoning !== undefined) {
      this.turnUsage.thoughtsTokens += usage.reasoning
      this.turnUsage.hasReasoning = true
    }
    this.sink.enqueue({
      type: 'message-metadata',
      messageMetadata: {
        totalTokens: this.turnUsage.totalTokens,
        stats: {
          inputTokens: this.turnUsage.promptTokens,
          outputTokens: this.turnUsage.completionTokens,
          totalTokens: this.turnUsage.totalTokens,
          ...(this.turnUsage.hasReasoning
            ? { outputTokenDetails: { reasoningTokens: this.turnUsage.thoughtsTokens } }
            : {})
        }
      }
    })
  }
}

type PiToolContent = AgentToolResult<unknown>['content'][number]

function isTextContent(block: PiToolContent): block is Extract<PiToolContent, { type: 'text' }> {
  return block.type === 'text'
}

/** pi types `tool_execution_end`'s `result` as `any`, and its builtins may return a bare string. */
function asToolResult(result: unknown): AgentToolResult<unknown> | undefined {
  const candidate = result as AgentToolResult<unknown> | undefined
  return candidate && Array.isArray(candidate.content) ? candidate : undefined
}

function projectPiToolOutput(toolName: string, result: unknown, payloadToolNames?: ReadonlySet<string>): unknown {
  const toolResult = asToolResult(result)
  if (!toolResult) return result ?? null
  // Cherry tool surfaces: the card/replay payload is the execute output, not the envelope.
  if (payloadToolNames?.has(toolName)) return toolResult.details ?? null
  if (toolName === PI_TOOL_SEARCH_TOOL_NAME || toolName === PI_TOOL_EXEC_TOOL_NAME) {
    return toolResult.details ?? toolResult
  }
  return toolName === PI_TOOL_CALL_TOOL_NAME ? unwrapMcpContent(toolResult) : toolResult
}

/**
 * pi reports a thrown tool as an error result (`{content:[{type:'text',text:message}]}`),
 * which the adapter would hand the trunk as JSON. Cherry tool surfaces show the message.
 */
function errorTextFor(toolName: string, result: unknown, payloadToolNames?: ReadonlySet<string>): string {
  if (!payloadToolNames?.has(toolName)) return stringifyResult(result)
  const text = asToolResult(result)
    ?.content.filter(isTextContent)
    .map((block) => block.text)
    .join('\n')
  return text || stringifyResult(result)
}

/**
 * `tool_call` returns the target tool's MCP result verbatim, hiding an all-text payload inside a
 * JSON string. Unwrap it the same way the dsh adapter does, so tool cards and citation
 * resolution see one shape across runtimes.
 */
function unwrapMcpContent({ content }: AgentToolResult<unknown>): unknown {
  if (!content.every(isTextContent)) return content
  const text = content.map((block) => block.text).join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

interface TurnUsageTotals {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  thoughtsTokens: number
  hasReasoning: boolean
}

function emptyTurnUsage(): TurnUsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, thoughtsTokens: 0, hasReasoning: false }
}

/**
 * Structural shape of the pi-ai `AssistantMessageEvent` variants we consume.
 * The connection casts pi's full event to this before dispatch; unlisted
 * variants (start/done/error, toolcall_start/delta) fall through the adapter's
 * `default`. `partial` (present on every pi event) is read only where a
 * finished block's replay signature lives on it.
 */
type AssistantMessageEventLike =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; partial?: unknown }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; partial?: unknown }
  | { type: 'toolcall_end'; contentIndex: number; partial?: unknown }
  | { type: 'start' | 'done' | 'error' | 'toolcall_start' | 'toolcall_delta' }

interface PiUsageLike {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens?: number
}

function extractAssistantUsage(message: unknown): PiUsageLike | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as { role?: unknown; usage?: unknown }
  if (record.role !== 'assistant' || typeof record.usage !== 'object' || record.usage === null) return undefined
  const usage = record.usage as Record<string, unknown>
  return {
    input: numeric(usage.input),
    output: numeric(usage.output),
    cacheRead: numeric(usage.cacheRead),
    cacheWrite: numeric(usage.cacheWrite),
    reasoning: typeof usage.reasoning === 'number' ? usage.reasoning : undefined,
    totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
