import type { LoggerService } from '@logger'
import { findCommandInShellEnv, findExecutableInEnv } from '@main/utils/commandResolver'

type Runner = {
  registryEnv?: (url: string) => Record<string, string>
  notFound: (command: string) => string
}

const uvRunner: Runner = {
  registryEnv: (url) => ({ UV_DEFAULT_INDEX: url, PIP_INDEX_URL: url }),
  notFound: (command) =>
    `${command} not found in PATH.\n` +
    'Please either:\n' +
    '1. Install uv from https://github.com/astral-sh/uv\n' +
    `2. Restart the application if you recently installed ${command}`
}

const RUNNERS: Record<string, Runner> = {
  npx: {
    registryEnv: (url) => ({ NPM_CONFIG_REGISTRY: url }),
    notFound: () =>
      'npx not found in PATH.\n' +
      'Please either:\n' +
      '1. Install Node.js (which includes npx) from https://nodejs.org\n' +
      '2. Restart the application if you recently installed Node.js'
  },
  uvx: uvRunner,
  uv: uvRunner
}

export type LaunchCommand = {
  command: string
  args: string[]
  /** Registry env the resolved package manager reads; merge into the transport env. */
  env: Record<string, string>
  resolution: 'system' | 'unresolved'
  unavailableReason?: string
}

type CommandResolution = Pick<LaunchCommand, 'command' | 'resolution' | 'unavailableReason'>
export type LaunchResolutionCache = Map<string, Promise<CommandResolution>>

/**
 * Resolves what a stdio server is actually started with: the user's own `npx` /
 * `uvx` / `uv` from PATH — this fork bundles no binaries, so an absent runner is
 * a user-side install away, not a fallback away. Any other command is
 * best-effort resolved to a full path so cross-spawn does not depend on a
 * possibly incomplete PATH.
 */
export async function resolveLaunchCommand({
  command,
  args,
  registryUrl,
  loginShellEnv,
  logger,
  signal,
  resolutionCache
}: {
  command: string
  args: string[]
  registryUrl?: string
  loginShellEnv: Record<string, string>
  logger: LoggerService
  signal?: AbortSignal
  resolutionCache?: LaunchResolutionCache
}): Promise<LaunchCommand> {
  const normalizedCommand = command.trim()
  signal?.throwIfAborted()
  if (!normalizedCommand) {
    throw new Error('MCP stdio command cannot be empty')
  }

  const runner = RUNNERS[normalizedCommand]
  const env = runner?.registryEnv && registryUrl ? runner.registryEnv(registryUrl) : {}

  const resolve = async (): Promise<CommandResolution> => {
    const systemPath = runner
      ? await findExecutableInEnv(normalizedCommand, { env: loginShellEnv, signal })
      : await findCommandInShellEnv(normalizedCommand, loginShellEnv, signal)
    signal?.throwIfAborted()
    if (systemPath) return { command: systemPath, resolution: 'system' }
    if (!runner) return { command: normalizedCommand, resolution: 'unresolved' }
    return {
      command: normalizedCommand,
      resolution: 'unresolved',
      unavailableReason: runner.notFound(normalizedCommand)
    }
  }
  const key = JSON.stringify([normalizedCommand, Object.entries(loginShellEnv).sort(([a], [b]) => a.localeCompare(b))])
  let pending = resolutionCache?.get(key)
  if (!pending) {
    pending = resolve()
    resolutionCache?.set(key, pending)
  }
  const resolution = await pending
  signal?.throwIfAborted()
  logger.debug('Resolved stdio launch command', { resolution: resolution.resolution })
  return { ...resolution, args, env }
}

export function buildStdioEnvironment(
  loginShellEnv: Record<string, string>,
  serverEnv: Record<string, string>
): Record<string, string> {
  const env = { ...loginShellEnv, ...serverEnv }
  if (process.platform !== 'win32') return env

  const serverPathKey = Object.keys(serverEnv)
    .filter((key) => key.toLowerCase() === 'path')
    .at(-1)
  const shellPathKey = Object.keys(loginShellEnv)
    .filter((key) => key.toLowerCase() === 'path')
    .at(-1)
  const pathValue = serverPathKey ? serverEnv[serverPathKey] : shellPathKey ? loginShellEnv[shellPathKey] : undefined

  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  if (pathValue !== undefined) env.PATH = pathValue

  return env
}
