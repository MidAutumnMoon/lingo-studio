/**
 * System-prompt assembly for chat turns and one-shot generation — engine-agnostic,
 * re-homed from the retired legacy engine's `params/` tree. The `tool_search`
 * gated section stays for the defer-exposition port (pi-unification register).
 */

import { replacePromptVariables } from '@main/utils/prompt'
import type { ToolSet } from '@shared/ai/uiDialect'
import type { Assistant } from '@shared/data/types/assistant'
import type { Model } from '@shared/data/types/model'

import { TOOL_SEARCH_TOOL_NAME } from '../tools/adapters/aiSdk/meta/toolSearch'
import type { ToolEntry } from '../tools/adapters/aiSdk/types'

export interface AssembleSystemPromptInput {
  assistant?: Assistant
  model: Model
  /** Final tool set going to the model — checked for `tool_search` membership. */
  tools?: ToolSet
  /** Entries hidden behind `tool_search`. Used to build the namespace inventory. */
  deferredEntries?: readonly ToolEntry[]
  /** True only when a selected first-party lookup tool with the citation-id contract remains available. */
  hasCitableTools?: boolean
  /** Add a volatile local-date anchor when this request can execute web search. */
  webSearchEnabled?: boolean
  /** Injectable clock for deterministic tests. */
  now?: Date
}

export async function assembleSystemPrompt(input: AssembleSystemPromptInput): Promise<string | undefined> {
  const { assistant, model, tools, deferredEntries, hasCitableTools = false, webSearchEnabled = false } = input

  const sections: string[] = []

  // `anthropic-cache` checks the original assistant prompt for volatile time variables before caching.
  if (assistant?.prompt) {
    const resolved = await replacePromptVariables(assistant.prompt, model.name)
    if (resolved) sections.push(resolved)
  }

  if (tools && TOOL_SEARCH_TOOL_NAME in tools) {
    sections.push(getDeferredToolsSystemPrompt(deferredEntries))
  }

  // No persisted-output section here: that protocol is taught in-band — the
  // marker itself carries the retrieval line (getVFSOffloadReminder) and the
  // fs_read tool description carries the paging + coverage contract — so
  // conversations that never truncate pay nothing for it.

  if (hasCitableTools) {
    sections.push(CITATIONS_SYSTEM_PROMPT)
  }

  if (webSearchEnabled) {
    sections.push(buildWebSearchDateContext(input.now ?? new Date()))
  }

  if (sections.length === 0) return undefined
  return sections.join('\n\n')
}

export function buildWebSearchDateContext(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `<current-date>${year}-${month}-${day}</current-date>\nInterpret relative dates such as today, this month, and the last 30 days from this date. Do not substitute dates remembered from training or earlier conversation turns.`
}

/**
 * Inline-citation guidance, appended to the system prompt only when a
 * citable lookup tool (web_search / web_fetch / kb_search / kb_read) is exposed
 * to the model — inline or deferred behind `tool_search`. The `[cite:id]`
 * markers it mandates are resolved by the renderer against the tool results of
 * the message and earlier turns (see `src/renderer/utils/message/citations.ts`).
 *
 * Wrapped in XML tags for parser-friendly structure (recommended by
 * Anthropic; tolerated well by other providers).
 */
export const CITATIONS_SYSTEM_PROMPT = `<citations>
When a statement in your answer is based on a web_search, web_fetch, kb_search, or kb_read result, append a citation marker immediately after that statement: [cite:ID], where ID is the exact \`id\` field of the supporting result item.
- Example: "Cherry Studio 2.0 entered beta in May. [cite:3f2a1b9c-2]"
- Chain markers when several results support one statement: [cite:3f2a1b9c-1][cite:7d4e0a51-3]
- Copy ids exactly as returned by the tool. Never invent, renumber, or reuse ids from other results.
- Do not add a "References" or "Sources" section at the end — the app renders citations from the inline markers.
- Statements from your own knowledge take no marker.
</citations>`

const DEFERRED_TOOLS_HEADER = `<deferred-tools>
Some tools are not loaded inline. Discover and call them through the meta-tools below.

<usage>
1. \`tool_search({ query?, namespace?, verbose? })\` — discover tools, grouped by namespace (e.g. \`web\`, \`kb\`, \`mcp:<server>\`). This is tool discovery, NOT web search. Pass \`verbose: true\` to include full input schemas.
2. \`tool_inspect({ name })\` — fetch a tool JSDoc signature to confirm its parameter names and shapes. Optional, but inspecting first (or searching with \`verbose: true\`) saves a round-trip.
3. \`tool_invoke({ name, params })\` — call a single tool. If you call one you haven't inspected, or pass params that don't match its signature, the call returns that tool's signature — read it and call again with corrected params.
</usage>`

/**
 * Build the deferred-tools system-prompt section. Includes a per-namespace
 * inventory so the model knows where to drill down without an exploratory
 * `tool_search()` round-trip.
 *
 * Wrapped in XML tags for parser-friendly structure (recommended by
 * Anthropic; tolerated well by other providers).
 */
export function getDeferredToolsSystemPrompt(deferredEntries: readonly ToolEntry[] = []): string {
  if (deferredEntries.length === 0) return `${DEFERRED_TOOLS_HEADER}\n</deferred-tools>`

  const counts = new Map<string, number>()
  for (const entry of deferredEntries) {
    // Label, not `namespace` — MCP namespaces are opaque server ids.
    const label = entry.namespaceLabel ?? entry.namespace
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, n]) => `  <namespace name="${ns}" count="${n}"/>`)

  return `${DEFERRED_TOOLS_HEADER}

<namespaces>
${lines.join('\n')}
</namespaces>
</deferred-tools>`
}
