/**
 * Model-facing text for a replayed tool result.
 *
 * A persisted tool part keeps the tool's raw output; each engine re-derives the text the model
 * sees at conversion time. MCP call results have a declared view — the summary the MCP tool's
 * `toModelOutput` returns — and the raw response cannot stand in for it: `data` payloads are
 * base64 media, and the persist-lane trim never covers non-text content
 * (`extractPersistableText` refuses any non-text block). Lives here, not in the ai-sdk adapter,
 * because the pi chat converter renders from the same persisted parts.
 *
 * Views for the other builtins (knowledge / fs / web / painting `toModelOutput`) are unported —
 * the pi-unification plan's W5 register owns them; outputs without a view keep their JSON text.
 */

import type { McpCallToolResponse, McpToolResultContent } from '@main/ai/mcp/types'

const MCP_BLOCK_TYPES = new Set<McpToolResultContent['type']>(['text', 'image', 'audio', 'resource'])

/** Protocol fields of a call-tool result, plus the `metadata` sibling the MCP tool attaches. */
const MCP_RESULT_KEYS = new Set(['content', 'structuredContent', 'isError', 'metadata'])

function isMcpBlock(item: unknown): item is McpToolResultContent {
  if (typeof item !== 'object' || item === null) return false
  return MCP_BLOCK_TYPES.has((item as { type: McpToolResultContent['type'] }).type)
}

/**
 * Whether a persisted tool output is an MCP call-tool result. Strict on purpose: a foreign object
 * that merely holds a `content` array must keep its JSON text, and an empty `content` must not
 * collapse to an empty text block (some providers reject one).
 */
export function isMcpCallToolResult(value: unknown): value is McpCallToolResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every((key) => MCP_RESULT_KEYS.has(key))) return false
  return Array.isArray(record.content) && record.content.length > 0 && record.content.every(isMcpBlock)
}

/**
 * Flatten for the model's view: text verbatim; image/audio/blob →
 * placeholder; text-backed resource → its `text`; unknown → JSON.
 */
export function mcpResultToTextSummary(result: McpCallToolResponse): string {
  if (!result || !result.content || !Array.isArray(result.content)) {
    return JSON.stringify(result)
  }

  const parts: string[] = []
  for (const item of result.content) {
    switch (item.type) {
      case 'text':
        parts.push(item.text || '')
        break
      case 'image':
        parts.push(`[Image: ${item.mimeType || 'image/png'}, delivered to user]`)
        break
      case 'audio':
        parts.push(`[Audio: ${item.mimeType || 'audio/mp3'}, delivered to user]`)
        break
      case 'resource':
        if (item.resource?.blob) {
          parts.push(
            `[Resource: ${item.resource.mimeType || 'application/octet-stream'}, uri=${
              item.resource.uri || 'unknown'
            }, delivered to user]`
          )
        } else {
          parts.push(item.resource?.text || JSON.stringify(item))
        }
        break
      default:
        parts.push(JSON.stringify(item))
        break
    }
  }

  return parts.join('\n')
}
