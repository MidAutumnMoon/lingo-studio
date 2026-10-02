/**
 * Knowledge base search tool — agentic.
 *
 * The model picks the query and target `baseIds` (typically after `kb_list`).
 * The effective knowledge base scope (the assistant's static binding narrowed by the composer's
 * per-turn selection, or that selection alone when there is no binding — see
 * `resolveKnowledgeBaseScope`) flows in via
 * `RequestContext.knowledgeBaseIds` and scopes which base IDs are accepted. The search itself lives
 * in the shared `knowledgeLookup` core so the agent MCP
 * bridge runs identical logic; this file is just the registry's neutral tool wrapper.
 */

import * as z from 'zod'

import { KB_SEARCH_TOOL_NAME, kbSearchInputSchema, kbSearchOutputSchema } from '@shared/ai/builtinTools'

import {
  KNOWLEDGE_SEARCH_DESCRIPTION,
  knowledgeLookupErrorSchema,
  knowledgeSearchModelOutput,
  searchKnowledge
} from '../../../knowledgeLookup'
import { zodToolSchema, type NeutralTool } from '../../../neutralTool'
import { makeEntitiesCodec } from '../../../outputCodec'
import { getToolCallContext } from '../context'
import type { ToolEntry } from '../types'

export { KB_SEARCH_TOOL_NAME }

// Mirror the web tool: an all-bases-failed lookup returns `{ error }`, so the output is a union.
const knowledgeSearchResultSchema = z.union([kbSearchOutputSchema, knowledgeLookupErrorSchema])

const kbSearchTool: NeutralTool = {
  description: KNOWLEDGE_SEARCH_DESCRIPTION,
  inputSchema: zodToolSchema(kbSearchInputSchema),
  outputSchema: zodToolSchema(knowledgeSearchResultSchema),
  execute: async ({ query, baseIds }: { query: string; baseIds: string[] }, options) => {
    const { request } = getToolCallContext(options)
    return searchKnowledge(query, baseIds, request.knowledgeBaseIds ?? [])
  },
  toModelOutput: ({ output }) => knowledgeSearchModelOutput(output as KnowledgeSearchToolOutput)
}

export function createKbSearchToolEntry(): ToolEntry {
  return {
    name: KB_SEARCH_TOOL_NAME,
    // Entity codec instead of the blanket truncatable:false (same rationale as
    // web_fetch): id/baseId/conceptId/title citation anchors ride the skeleton,
    // so per-chunk `content` trimming loses nothing the model cites. Near a
    // no-op at default thresholds — kb chunks are small.
    codec: makeEntitiesCodec({ contentKey: 'content' }),
    namespace: 'kb',
    description: "Search the user's private knowledge base",
    defer: 'never',
    tool: kbSearchTool,
    applies: (scope) => scope.hasAnyKnowledgeBase === true && (scope.knowledgeBaseIds?.length ?? 0) > 0
  }
}

export type KnowledgeSearchToolInput = z.infer<typeof kbSearchInputSchema>
export type KnowledgeSearchToolOutput = z.infer<typeof knowledgeSearchResultSchema>
