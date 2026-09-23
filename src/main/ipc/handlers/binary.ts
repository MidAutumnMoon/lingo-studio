import { systemToolService } from '@main/services/SystemToolService'
import type { binaryRequestSchemas } from '@shared/ipc/schemas/binary'
import type { IpcHandlersFor } from '@shared/ipc/types'

/**
 * Thin adapter for the PATH-observation route — the only binary surface left.
 * This fork installs nothing; the route reports what already exists on the
 * user's login-shell PATH.
 */
export const binaryHandlers: IpcHandlersFor<typeof binaryRequestSchemas> = {
  'binary.get_tool_snapshots': async (names) => systemToolService.getToolSnapshots(names)
}
