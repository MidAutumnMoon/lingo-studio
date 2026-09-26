import type {
  Api,
  AssistantMessage,
  ImageContent,
  JsonObject,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage
} from '@earendil-works/pi-ai'
/**
 * W1 — persisted chat history → pi session entries.
 *
 * The pi chat engine (plan: docs/plans/2026-09-pi-unification.md, Phase 1) replays a
 * topic's served messages by seeding `SessionManager.inMemory` with converted entries.
 * Input is the already-served path — boundary slicing (`data-clear`) and durable
 * compaction summaries are host-owned upstream (`PersistentChatContextProvider`) — so
 * this module maps parts only and never writes. Its one read dependency is the shared
 * persisted-output marker rendering (the same pass the legacy engine runs before
 * conversion), so replayed prompt bytes stay identical and provider prefix caches hold.
 *
 * Fidelity matrix (persisted part → pi representation). "Lossy" rows are by design,
 * not omissions; every gap here has an owner in the plan's W5 register.
 *
 * | Cherry part                          | pi mapping                                             | Fidelity |
 * |--------------------------------------|--------------------------------------------------------|----------|
 * | text                                 | TextContent                                            | full     |
 * | reasoning                            | ThinkingContent (no signature persisted; pi's signed-thinking recovery handles replay) | text only |
 * | file (image, data URL)               | ImageContent                                           | full     |
 * | file (image, remote/unsupported URL) | text note                                              | lossy — converter is offline/pure, never fetches |
 * | file (non-image: pdf/audio/video/…)  | text note                                              | lossy — pi-ai has no native file input (W5 attachments row) |
 * | tool-* / dynamic-tool, terminal      | ToolCall in AssistantMessage + paired ToolResultMessage | output JSON kept structurally in `details` |
 * | tool-* / dynamic-tool, non-terminal  | dropped (call and result)                              | by design — a dangling call breaks provider pairing rules |
 * | source-url / source-document         | dropped                                                | lossy — citations metadata (W5 register row) |
 * | step-start                           | dropped                                                | pi replay has no step markers |
 * | data-error / data-translation / data-code | dropped                                          | UI-only projections; matches the legacy engine's treatment |
 * | data-compact / data-compaction-anchor| dropped                                                | markers of host-owned durable compaction |
 * | data-clear / data-knowledge-scope / data-conversation-reset | dropped                          | hidden control parts, never model content |
 * | data-video / data-agent-task-event / data-agent-session-fork / data-retry | dropped          | no model content |
 *
 * Message-level rules: a message that converts to no content is skipped (empty user
 * turn, assistant turn holding only non-content parts); replayed AssistantMessages
 * carry zero cost (billing is host-side) and token counts from persisted stats when
 * present. Deterministic: output is a pure function of (input, options) — ids derive
 * from message ids, timestamps from `metadata.createdAt` (epoch 0 when absent).
 */
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import { isToolUIPart } from 'ai'

import type { CherryMessagePart, CherryUIMessage, MessageStats } from '@shared/data/types/message'
import { parseDataUrl } from '@shared/utils/dataUrl'

import { ALL_MEDIA, type MediaCapabilities, stripUnsupportedMedia } from '../../messages/messageCapabilities'
import { dropUnansweredApprovals, toWireToolName, WIRE_TOOL_NAME } from '../../messages/messageRules'
import { renderPersistedToolOutputs } from '../../messages/persistedOutputRendering'

/** pi identity fields for a replayed assistant message (required by pi's AssistantMessage). */
export interface PiHistoryModelDescriptor {
  api: Api
  provider: string
  model: string
}

export interface PiChatHistoryOptions {
  /**
   * Resolve a persisted assistant message's model into pi's identity fields. The wire
   * serialization of replayed turns (notably thinking replay per api family) depends on
   * these. Unresolvable or absent → placeholder descriptor.
   */
  resolveHistoryModel?: (message: CherryUIMessage) => PiHistoryModelDescriptor | undefined
  /** Media the target model accepts; unsupported file parts become text notes. */
  mediaCapabilities?: MediaCapabilities
  /** Tool names declared for this request — replayed verbatim even when wire-illegal. */
  declaredToolNames?: ReadonlySet<string>
}

/** Placeholder identity for history pi cannot attribute to a live provider. */
export const HISTORY_MODEL_PLACEHOLDER: PiHistoryModelDescriptor = {
  api: 'openai-completions',
  provider: 'cherry-history',
  model: 'history'
}

const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

/** Tool part states whose call/result pair is complete enough to replay. */
function isTerminalToolState(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied'
}

function toolPartName(part: CherryUIMessage['parts'][number]): string | undefined {
  if (part.type === 'dynamic-tool') return part.toolName
  if (isToolUIPart(part)) return part.type.slice('tool-'.length)
  return undefined
}

/** Wire-legal replay name: declared names pass verbatim, legacy-illegal names get the digest scheme. */
function wireToolName(name: string, declared: ReadonlySet<string> | undefined): string {
  if (WIRE_TOOL_NAME.test(name) || declared?.has(name)) return name
  return toWireToolName(name)
}

function timestampMs(message: CherryUIMessage): number {
  const createdAt = message.metadata?.createdAt
  return createdAt ? Date.parse(createdAt) : 0
}

function timestampIso(message: CherryUIMessage): string {
  return message.metadata?.createdAt ?? EPOCH_ISO
}

function attachmentNote(what: string): TextContent {
  return { type: 'text', text: `[attachment: ${what}]` }
}

function filePartContent(part: { mediaType: string; url: string; filename?: string }): TextContent | ImageContent {
  if (part.mediaType.startsWith('image/')) {
    const parsed = parseDataUrl(part.url)
    if (parsed?.isBase64) {
      return { type: 'image', data: parsed.data, mimeType: parsed.mediaType ?? part.mediaType }
    }
    return attachmentNote(`image ${part.filename ?? part.url}`)
  }
  return attachmentNote(`${part.filename ?? 'file'} (${part.mediaType})`)
}

/** Token counts from persisted stats; cost stays zero — billing is owned by the host. */
function toPiUsage(stats: MessageStats | undefined): Usage {
  const input = stats?.inputTokens ?? 0
  const output = stats?.outputTokens ?? 0
  const cacheRead = stats?.inputTokenDetails?.cacheReadTokens ?? 0
  const cacheWrite = stats?.inputTokenDetails?.cacheWriteTokens ?? 0
  const reasoning = stats?.outputTokenDetails?.reasoningTokens
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined && { reasoning }),
    totalTokens: stats?.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

/** Any tool-shaped part: `tool-${name}` or `dynamic-tool`. */
type ToolPart = Extract<CherryMessagePart, { toolCallId: string }>

function buildToolResult(tool: ToolPart, toolName: string, timestamp: number): ToolResultMessage {
  const base = { role: 'toolResult' as const, toolCallId: tool.toolCallId, toolName, timestamp }
  if (tool.state === 'output-denied') {
    const reason = 'approval' in tool ? tool.approval?.reason : undefined
    return {
      ...base,
      content: [{ type: 'text', text: `[tool call denied by the user${reason ? `: ${reason}` : ''}]` }],
      isError: true
    }
  }
  if (tool.state === 'output-error') {
    const errorText = 'errorText' in tool ? tool.errorText : undefined
    return {
      ...base,
      content: [{ type: 'text', text: errorText ?? 'tool execution failed' }],
      isError: true
    }
  }
  const output = 'output' in tool ? tool.output : undefined
  if (typeof output === 'string') {
    return { ...base, content: [{ type: 'text', text: output }], isError: false }
  }
  const details = asJsonObject(output)
  return {
    ...base,
    content: [{ type: 'text', text: JSON.stringify(output) ?? 'undefined' }],
    ...(details !== undefined && { details }),
    isError: false
  }
}

function toUserMessage(message: CherryUIMessage, timestamp: number): UserMessage | undefined {
  const content: Array<TextContent | ImageContent> = []
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) {
      content.push({ type: 'text', text: part.text })
    } else if (part.type === 'file') {
      content.push(filePartContent(part))
    }
  }
  if (content.length === 0) return undefined
  if (content.length === 1 && content[0].type === 'text') {
    return { role: 'user', content: content[0].text, timestamp }
  }
  return { role: 'user', content, timestamp }
}

function toSystemMessage(message: CherryUIMessage, timestamp: number): SystemMessage | undefined {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text' && Boolean(part.text))
    .map((part) => part.text)
    .join('\n\n')
  return text ? { role: 'system', content: text, timestamp } : undefined
}

function toAssistantTurn(
  message: CherryUIMessage,
  options: PiChatHistoryOptions,
  timestamp: number
): { assistant: AssistantMessage; toolResults: ToolResultMessage[] } | undefined {
  const content: AssistantMessage['content'] = []
  const toolResults: ToolResultMessage[] = []
  for (const part of message.parts) {
    const name = toolPartName(part)
    if (name === undefined) {
      if (part.type === 'text' && part.text) {
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'reasoning' && part.text) {
        content.push({ type: 'thinking', thinking: part.text })
      } else if (part.type === 'file') {
        // Assistant content has no image slot in pi — generated media degrades to a note.
        content.push(attachmentNote(`${part.filename ?? 'file'} (${part.mediaType})`))
      }
      continue
    }
    const tool = part as ToolPart
    if (!isTerminalToolState(tool.state)) continue // dangling call — dropped pair (matrix)
    const wireName = wireToolName(name, options.declaredToolNames)
    const input = 'input' in tool ? tool.input : undefined
    const call: ToolCall = {
      type: 'toolCall',
      id: tool.toolCallId,
      name: wireName,
      arguments: asJsonObject(input) ?? { input: input as never }
    }
    content.push(call)
    toolResults.push(buildToolResult(tool, wireName, timestamp))
  }
  if (content.length === 0) return undefined

  const descriptor = options.resolveHistoryModel?.(message) ?? HISTORY_MODEL_PLACEHOLDER
  const assistant: AssistantMessage = {
    role: 'assistant',
    content,
    api: descriptor.api,
    provider: descriptor.provider,
    model: descriptor.model,
    usage: toPiUsage(message.metadata?.stats),
    stopReason: toolResults.length > 0 ? 'toolUse' : 'stop',
    timestamp
  }
  return { assistant, toolResults }
}

/**
 * Convert served chat history into pi session message entries forming a linear
 * `parentId` chain (ready for `SessionManager.inMemory(cwd, { id }, entries)` —
 * the session manager synthesizes the header itself when none is present).
 */
export function toPiSessionEntries(
  messages: readonly CherryUIMessage[],
  options: PiChatHistoryOptions = {}
): SessionMessageEntry[] {
  const prepared = stripUnsupportedMedia(
    dropUnansweredApprovals(renderPersistedToolOutputs(messages as CherryUIMessage[])),
    options.mediaCapabilities ?? ALL_MEDIA
  )

  const entries: SessionMessageEntry[] = []
  const emit = (message: SessionMessageEntry['message'], id: string, timestamp: string): void => {
    entries.push({ type: 'message', id, parentId: entries.at(-1)?.id ?? null, timestamp, message })
  }

  for (const message of prepared) {
    const timestamp = timestampMs(message)
    const iso = timestampIso(message)
    if (message.role === 'system') {
      const system = toSystemMessage(message, timestamp)
      if (system) emit(system, message.id, iso)
    } else if (message.role === 'user') {
      const user = toUserMessage(message, timestamp)
      if (user) emit(user, message.id, iso)
    } else {
      const turn = toAssistantTurn(message, options, timestamp)
      if (turn) {
        emit(turn.assistant, message.id, iso)
        turn.toolResults.forEach((result, index) => emit(result, `${message.id}#t${index}`, iso))
      }
    }
  }
  return entries
}
