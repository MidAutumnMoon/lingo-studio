/**
 * Apply defer-based tool exposition to a per-request tool map.
 *
 * Decides which entries are deferred (via {@link shouldDefer}) and rebuilds
 * the map so the model sees:
 *   - non-deferred entries inline, exactly as before
 *   - `tool_search` + `tool_inspect` + `tool_invoke` meta-tools when at least
 *     one entry is deferred, so the deferred set is still discoverable /
 *     inspectable / callable
 *
 * Returns the deferred entries alongside the rebuilt map so callers
 * (system-prompt assembly, observability) can introspect what's hidden
 * behind the meta-tools without re-running `shouldDefer`.
 */

import { TOOL_INVOKE_TOOL_NAME } from '../../../metaToolNames'
import type { NeutralTool } from '../../../neutralTool'
import { createToolInspectTool, TOOL_INSPECT_TOOL_NAME } from '../meta/toolInspect'
import { createToolInvokeTool } from '../meta/toolInvoke'
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from '../meta/toolSearch'
import type { ToolRegistry } from '../registry'
import type { ToolEntry } from '../types'
import { shouldDefer } from './shouldDefer'

export interface ApplyDeferExpositionResult {
  tools: Record<string, NeutralTool> | undefined
  deferredEntries: ToolEntry[]
}

export async function applyDeferExposition(
  tools: Record<string, NeutralTool> | undefined,
  registry: ToolRegistry,
  contextWindow: number | undefined,
  /**
   * Names the request exposed outside this map (legacy client tools, already SDK-shaped and
   * merged after this pass) — they count toward the meta-tools' allowed set exactly as when
   * they merged before it.
   */
  extraAllowedNames: ReadonlySet<string> = new Set()
): Promise<ApplyDeferExpositionResult> {
  if (!tools || Object.keys(tools).length === 0) return { tools, deferredEntries: [] }

  const candidateEntries = Object.keys(tools)
    .map((name) => registry.getByName(name))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)

  // Approval-gated tools are kept out of the deferred set at their source: each entry carries
  // `defer: 'never'` when force-prompt (see `mcp/mcpTools.ts`), so the SDK's native gate fires on
  // the inline tool. `tool_invoke` / `tool_exec` still guard at execution time as the runtime
  // backstop for the `registry.getByName(any-name)` vector.
  const { deferredNames } = await shouldDefer(candidateEntries, contextWindow)
  if (deferredNames.size === 0) return { tools, deferredEntries: [] }

  // Per-request scope for the meta-tools: every tool the request exposed (inline or deferred).
  // `tool_invoke` / `tool_inspect` reach the process-wide registry, so without this they could
  // resolve user-owned tools `applies()` excluded for this request. Captured before the meta-tools
  // are added below — they don't address themselves.
  const allowedNames = new Set([...Object.keys(tools), ...extraAllowedNames])

  // Shared per-request inspect-before-invoke ledger: `tool_inspect` (and a verbose `tool_search`)
  // record the tools whose signature the model has seen; `tool_invoke` requires membership before
  // running one. The ledger persists across every step of one streamText loop and resets per
  // request — the model confirms a tool's schema once per request, not once per turn.
  const inspectedNames = new Set<string>()

  const inlineTools: Record<string, NeutralTool> = {}
  for (const [name, entry] of Object.entries(tools)) {
    if (!deferredNames.has(name)) inlineTools[name] = entry
  }
  inlineTools[TOOL_SEARCH_TOOL_NAME] = createToolSearchTool(registry, deferredNames, inspectedNames)
  inlineTools[TOOL_INSPECT_TOOL_NAME] = createToolInspectTool(registry, allowedNames, inspectedNames)
  inlineTools[TOOL_INVOKE_TOOL_NAME] = createToolInvokeTool(registry, allowedNames, inspectedNames)
  // `tool_exec` (worker-thread JS sandbox with full registry access) is
  // intentionally NOT injected by default — it is a meaningful privilege-
  // escalation surface vs the renderer's prior restrictions. Re-enable
  // behind an explicit Preference key when there is a concrete need.
  const deferredEntries = candidateEntries.filter((e) => deferredNames.has(e.name))
  return { tools: inlineTools, deferredEntries }
}
