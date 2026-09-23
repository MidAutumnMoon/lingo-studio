import { loggerService } from '@logger'
import { findExecutableInEnv } from '@main/utils/commandResolver'

const logger = loggerService.withContext('dsh:bunRuntime')

/**
 * Resolve the Bun runtime DSH runs under, from the user's login-shell PATH.
 *
 * This fork no longer bundles a Bun runtime, so DSH is deliberately broken on
 * machines without a system Bun — the error below is the designed failure mode,
 * not a regression to work around.
 */
export async function resolveDshBunRuntime(): Promise<string> {
  const bunPath = await findExecutableInEnv('bun')
  if (!bunPath) {
    throw new Error(
      'DSH requires Bun, which is no longer bundled with this app. Install Bun from https://bun.sh and restart.'
    )
  }
  logger.debug('Resolved DSH Bun runtime from PATH', { bunPath })
  return bunPath
}
