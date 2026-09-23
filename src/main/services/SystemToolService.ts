import { loggerService } from '@logger'
import { findExecutableInEnv } from '@main/utils/commandResolver'
import { getShellEnv } from '@main/utils/shellEnv'
import type { BinaryToolSnapshot } from '@shared/types/binary'

const logger = loggerService.withContext('SystemToolService')

/**
 * Read-only observation of CLI executables on the user's login-shell PATH.
 *
 * This fork ships and installs no binaries — no mise backend, no bundled tools,
 * no downloads. Every consumer (the Dependencies dashboard, Code CLI
 * availability, MCP and agent runtimes) treats the user's own installation as
 * the only source and degrades when it is absent.
 */
export const systemToolService = {
  async getToolSnapshots(names: string[]): Promise<Record<string, BinaryToolSnapshot>> {
    const env = await getShellEnv()
    const entries = await Promise.all(
      names.map(async (name) => {
        const executablePath = await findExecutableInEnv(name, { env })
        logger.debug('probed executable', { name, found: executablePath !== null })
        return [
          name,
          {
            name,
            availability: executablePath
              ? { source: 'system' as const, path: executablePath }
              : { source: 'none' as const }
          }
        ] as const
      })
    )
    return Object.fromEntries(entries)
  }
}
