import { messageService } from '@data/services/MessageService'
import { ErrorCode, isDataApiError } from '@shared/data/api/errors'

/**
 * Whether the request's id maps to a real `message` row — the chat path's
 * assistant placeholder, committed before dispatch, that a provisional
 * `tool_output` ref can target. Temporary chats carry a synthetic uuid with no
 * row and one-shot `streamPrompt` calls (translate / naming / probes) carry a
 * random one; for those the truncator falls back to plain inline head/tail
 * truncation, so no `<persisted-output>` marker can ever be produced.
 *
 * Shared by the ai-sdk in-flight middleware and the pi chat seam (W6); it was
 * re-homed from `runtime/aiSdk/params/features/contextBuild.ts` when the seam
 * needed it without that module's ai-core middleware graph.
 */
export function hasAnchorRow(messageId: string | undefined): boolean {
  if (messageId === undefined) return false
  try {
    messageService.getById(messageId)
    return true
  } catch (error) {
    // getById throws NOT_FOUND for missing rows (it never returns null) —
    // that's the expected non-anchored case. Anything else is a real failure.
    if (isDataApiError(error) && error.code === ErrorCode.NOT_FOUND) return false
    throw error
  }
}
