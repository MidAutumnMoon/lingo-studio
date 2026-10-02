/**
 * Web search tool — agentic.
 *
 * The model picks search queries and may call multiple times with refined
 * terms. The actual lookup (provider resolution, mapping, error handling)
 * lives in the shared `webLookup` core so the agent MCP bridge runs the
 * exact same logic; this file is just the registry's neutral tool wrapper.
 */

import * as z from 'zod'

import { markTrustedLocalToolTerminalFailure } from '@main/ai/tools/toolLoopTerminal'
import {
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  webSearchInputSchema,
  webSearchOutputSchema
} from '@shared/ai/builtinTools'

import { zodToolSchema, type NeutralTool } from '../../../neutralTool'
import { makeEntitiesCodec } from '../../../outputCodec'
import { searchWeb, WEB_SEARCH_DESCRIPTION, webLookupErrorSchema, webLookupModelOutput } from '../../../webLookup'
import { getToolCallContext } from '../context'
import type { ToolEntry } from '../types'

export { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME }

const webSearchResultSchema = z.union([webSearchOutputSchema, webLookupErrorSchema])

const webSearchTool: NeutralTool = {
  description: WEB_SEARCH_DESCRIPTION,
  inputSchema: zodToolSchema(webSearchInputSchema),
  outputSchema: zodToolSchema(webSearchResultSchema),
  execute: async ({ query }: { query?: string }, options) => {
    if (typeof query !== 'string' || !query.trim()) {
      return []
    }
    return markTrustedLocalToolTerminalFailure(
      await searchWeb(query.trim(), getToolCallContext(options).request.abortSignal)
    )
  },
  toModelOutput: ({ output }) => webLookupModelOutput(output as WebSearchToolOutput)
}

export function createWebSearchToolEntry(): ToolEntry {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    // Entity codec instead of the blanket truncatable:false (same rationale as
    // web_fetch): per-entity `content` trimming keeps every id/url/title anchor
    // visible. Near a no-op at default thresholds — search snippets are small —
    // but a provider returning full-page content is no longer uncapped.
    codec: makeEntitiesCodec({ contentKey: 'content' }),
    namespace: 'web',
    description: 'Search the web for current information',
    defer: 'auto',
    tool: webSearchTool,
    applies: (scope) => scope.webToolRoutes?.webSearch === 'client'
  }
}

export type WebSearchToolInput = z.infer<typeof webSearchInputSchema>
export type WebSearchToolOutput = z.infer<typeof webSearchResultSchema>
