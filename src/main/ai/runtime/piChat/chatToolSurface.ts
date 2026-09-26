/**
 * W4a — the turn's pi tool surface: registry entries converted to pi `ToolDefinition`s
 * plus the gate that guards exactly those entries (plan:
 * docs/plans/2026-09-pi-unification.md, W4).
 *
 * One call because the two views must be built from the same selection and the same
 * context: the gate evaluates `needsApproval` with the context `execute` receives (a
 * context-reading policy otherwise fails closed and prompts on every call), and a tool
 * the engine can run is always a tool the gate knows about.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import type { PiChatToolAuthorizer } from './chatEngine'
import { toPiChatTools, type PiChatToolContext } from './chatToolAdapter'
import { createChatToolAuthorizer, type ChatToolApprovalOptions } from './chatToolApproval'

export interface PiChatToolSurface {
  /** The engine's `tools`. */
  tools: ToolDefinition[]
  /** The engine's `authorizer`. */
  authorizer: PiChatToolAuthorizer
}

/** Build the turn's tool surface from one registry selection and one request context. */
export function toPiChatToolSurface(
  entries: readonly ToolEntry[],
  context: PiChatToolContext,
  approval: Pick<ChatToolApprovalOptions, 'approvalScope' | 'onApprovalResolved'>
): PiChatToolSurface {
  return {
    tools: toPiChatTools(entries, context),
    authorizer: createChatToolAuthorizer({ ...approval, entries, context })
  }
}
