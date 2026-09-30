import type { AnchorMessage } from '../types'

/** One conversation turn: a user message plus the replies that follow it. */
export interface AnchorTurn {
  /** Turn start message — the scroll target. */
  anchorId: string
  userMessageId?: string
  assistantMessageId?: string
  memberIds: string[]
}

export function groupAnchorTurns(messages: readonly AnchorMessage[]): AnchorTurn[] {
  const result: AnchorTurn[] = []
  let current: AnchorTurn | null = null
  /** Whether the current turn's preview assistant sits on the active branch. */
  let assistantOnActiveBranch = false
  for (const message of messages) {
    if (message.isContextBoundary) continue
    if (message.role === 'user') {
      current = { anchorId: message.id, userMessageId: message.id, memberIds: [message.id] }
      assistantOnActiveBranch = false
      result.push(current)
      continue
    }
    if (!current) {
      current = { anchorId: message.id, memberIds: [] }
      assistantOnActiveBranch = false
      result.push(current)
    }
    current.memberIds.push(message.id)
    // Preview the reply the body actually renders: regenerated/multi-model
    // turns carry off-path siblings (isActiveBranch false), so prefer the
    // first active-branch assistant and fall back to the first one only when
    // no member carries the flag.
    if (message.role === 'assistant' && !assistantOnActiveBranch) {
      if (message.isActiveBranch) {
        current.assistantMessageId = message.id
        assistantOnActiveBranch = true
      } else if (!current.assistantMessageId) {
        current.assistantMessageId = message.id
      }
    }
  }
  return result
}
