/** MCP tool-result formatters. */

import type { McpCallToolResponse } from '@main/ai/mcp/types'

/** True if the call produced any image / audio / binary resource. */
export function hasMultimodalContent(result: McpCallToolResponse): boolean {
  return (
    Array.isArray(result?.content) &&
    result.content.some(
      (item) => item.type === 'image' || item.type === 'audio' || (item.type === 'resource' && !!item.resource?.blob)
    )
  )
}
