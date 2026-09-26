/**
 * W4a — chat tool-call approval over the neutral approval machinery (plan:
 * docs/plans/2026-09-pi-unification.md, W4).
 *
 * Same resume mechanics as the pi agent path, different gate: the registry's
 * `Tool.needsApproval` (the `isApprovalGated` evaluation) instead of agent
 * permission modes — chat tools are Cherry builtins and MCP entries, not pi
 * workspace tools. When a call is gated, the authorizer registers in the neutral
 * `toolApprovalRegistry` and emits the AI SDK `tool-approval-request` chunk into
 * the engine's stream; the existing `ai.tool.respond_approval` IPC resolves it
 * (the responder peeks the neutral registry by approval id, so it dispatches
 * chat entries exactly like agent ones), and the engine stays resident while the
 * promise pends. That is the whole design change versus the legacy engine, which
 * ends its turn and re-dispatches through `continue-conversation`.
 */
import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'

import { type DispatchDecision, toolApprovalRegistry } from '../../toolApproval/ToolApprovalRegistry'
import { isApprovalGated } from '../../tools/adapters/aiSdk/isApprovalGated'
import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import { applyPiToolInputEdit } from '../pi/approvalExtension'
import type { PiChatToolAuthorizer } from './chatEngine'

const logger = loggerService.withContext('PiChatToolApproval')

export interface ChatToolApprovalOptions {
  /**
   * Registry key for the neutral `toolApprovalRegistry` — the engine execution id
   * namespaced so it can never collide with an agent-session topic id (the shared
   * responder would otherwise resolve approvals against a live agent stream).
   */
  approvalScope: string
  /** The turn's registry entries by wire name — the gate reads `tool.needsApproval`. */
  entries: ReadonlyMap<string, ToolEntry>
  /**
   * Fires the moment a decision lands. The seam wires this to
   * `AiStreamManager.resolveToolApproval(topicId, …)`: on approve the trunk replays
   * the buffered input chunk so the card advances immediately (a slow tool would
   * otherwise leave it pending until the output arrives). Denials need nothing —
   * the engine translates the blocked call itself.
   */
  onApprovalResolved?: (toolCallId: string, approved: boolean) => void
}

/** Build the engine's tool-call authorizer from the turn's registry entries. */
export function createChatToolAuthorizer(options: ChatToolApprovalOptions): PiChatToolAuthorizer {
  return async (call, emit) => {
    const entry = options.entries.get(call.toolName)
    // Tools the caller handed the engine directly (not from this registry) are not
    // ours to gate — the seam decides what reaches the engine.
    if (!entry) return undefined
    const gated = await isApprovalGated(entry.tool, { input: call.input, toolCallId: call.toolCallId })
    if (!gated) return undefined

    const approvalId = randomUUID()
    let decision: DispatchDecision
    try {
      decision = await new Promise<DispatchDecision>((resolve) => {
        const pending = toolApprovalRegistry.register({
          approvalId,
          sessionId: options.approvalScope,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          originalInput: { ...call.input },
          presentation: 'stream',
          signal: call.signal,
          resolve
        })
        // Only surface the card when the request is actually pending; a synchronous
        // resolve (duplicate id, aborted turn) already settled the promise, and an
        // emitted chunk would leave an unanswerable card behind.
        if (!pending) return
        emit({ type: 'tool-approval-request', approvalId, toolCallId: call.toolCallId })
      })
    } catch (error) {
      logger.warn('chat tool approval await failed; blocking the call', {
        toolName: call.toolName,
        error: error instanceof Error ? error.message : String(error)
      })
      return { block: true, reason: 'Tool approval could not be completed.' }
    }

    options.onApprovalResolved?.(call.toolCallId, decision.approved)
    if (!decision.approved) {
      return {
        block: true,
        reason: decision.reason ?? 'User denied permission for this tool.',
        denied: true
      }
    }
    if (decision.updatedInput) applyPiToolInputEdit(call.input, decision.updatedInput)
    return undefined
  }
}
