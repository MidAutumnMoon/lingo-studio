/**
 * Web fetch tool — agentic.
 *
 * The model supplies known page URLs (often from a prior `web_search`) and
 * gets back their readable content. The lookup itself lives in the shared
 * `webLookup` core so the agent MCP bridge runs identical logic; this file is
 * just the registry's neutral tool wrapper.
 */

import * as z from 'zod'

import { markTrustedLocalToolTerminalFailure } from '@main/ai/tools/toolLoopTerminal'
import { WEB_FETCH_TOOL_NAME, webFetchInputSchema, webFetchOutputSchema } from '@shared/ai/builtinTools'

import { zodToolSchema, type NeutralTool } from '../../../neutralTool'
import { makeEntitiesCodec } from '../../../outputCodec'
import { fetchWeb, WEB_FETCH_DESCRIPTION, webLookupErrorSchema, webLookupModelOutput } from '../../../webLookup'
import { getToolCallContext } from '../context'
import type { ToolEntry } from '../types'

const webFetchResultSchema = z.union([webFetchOutputSchema, webLookupErrorSchema])

const webFetchTool: NeutralTool = {
  description: WEB_FETCH_DESCRIPTION,
  inputSchema: zodToolSchema(webFetchInputSchema),
  outputSchema: zodToolSchema(webFetchResultSchema),
  execute: async ({ urls }: { urls: string[] }, options) =>
    markTrustedLocalToolTerminalFailure(await fetchWeb(urls, getToolCallContext(options).request.abortSignal)),
  toModelOutput: ({ output }) => webLookupModelOutput(output as WebFetchToolOutput)
}

export function createWebFetchToolEntry(): ToolEntry {
  return {
    name: WEB_FETCH_TOOL_NAME,
    // Entity codec instead of the blanket truncatable:false it used to carry:
    // a fetched page's citation identity is its URL (in the input AND the
    // result skeleton), so trimming per-entity `content` loses nothing the
    // model cites — while an uncapped page was the one output no context
    // guard covered (compaction never folds the current turn; finding #7).
    codec: makeEntitiesCodec({ contentKey: 'content' }),
    namespace: 'web',
    description: 'Fetch readable content from known web page URLs',
    defer: 'auto',
    tool: webFetchTool,
    applies: (scope) => scope.webToolRoutes?.webFetch === 'client'
  }
}

export type WebFetchToolInput = z.infer<typeof webFetchInputSchema>
export type WebFetchToolOutput = z.infer<typeof webFetchResultSchema>
