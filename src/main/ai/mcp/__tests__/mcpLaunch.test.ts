import { beforeEach, describe, expect, it, vi } from 'vitest'

const commandMock = vi.hoisted(() => ({
  findExecutableInEnv: vi.fn<(name: string, options: unknown) => Promise<string | null>>(),
  findCommandInShellEnv:
    vi.fn<(name: string, env: Record<string, string>, signal?: unknown) => Promise<string | null>>()
}))

vi.mock('@main/utils/commandResolver', () => commandMock)

const { resolveLaunchCommand } = await import('../mcpLaunch')

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any

const resolve = (command: string, args: string[] = [], registryUrl?: string) =>
  resolveLaunchCommand({ command, args, registryUrl, loginShellEnv: { PATH: '/usr/bin' }, logger })

describe('resolveLaunchCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commandMock.findExecutableInEnv.mockResolvedValue(null)
    commandMock.findCommandInShellEnv.mockResolvedValue(null)
  })

  it('shares resolution by command and effective environment without sharing arguments or registries', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/npx')
    const resolutionCache = new Map()
    const options = { command: 'npx', loginShellEnv: { PATH: '/a' }, logger, resolutionCache }
    const a = await resolveLaunchCommand({ ...options, args: ['one'], registryUrl: 'https://one.example' })
    const b = await resolveLaunchCommand({ ...options, args: ['two'], registryUrl: 'https://two.example' })
    expect(a.args).toEqual(['one'])
    expect(b.args).toEqual(['two'])
    expect(b.env).toEqual({ NPM_CONFIG_REGISTRY: 'https://two.example' })
    expect(commandMock.findExecutableInEnv).toHaveBeenCalledTimes(1)
    await resolveLaunchCommand({ ...options, loginShellEnv: { PATH: '/b' }, args: [] })
    expect(commandMock.findExecutableInEnv).toHaveBeenCalledTimes(2)
  })

  it('prefers the user’s own npx and passes the args through verbatim', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/npx')

    const launch = await resolve('npx', ['-y', 'example-mcp'])

    expect(launch).toMatchObject({
      command: '/usr/local/bin/npx',
      args: ['-y', 'example-mcp'],
      env: {},
      resolution: 'system'
    })
    expect(launch.unavailableReason).toBeUndefined()
  })

  it('does not mutate the caller’s args', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/npx')
    const args = ['-y', 'example-mcp']

    await resolve('npx', args)

    expect(args).toEqual(['-y', 'example-mcp'])
  })

  it('reports unresolved with the Node.js guidance when npx is not on PATH', async () => {
    await expect(resolve('npx', ['example-mcp'])).resolves.toMatchObject({
      command: 'npx',
      args: ['example-mcp'],
      resolution: 'unresolved',
      unavailableReason:
        'npx not found in PATH.\n' +
        'Please either:\n' +
        '1. Install Node.js (which includes npx) from https://nodejs.org\n' +
        '2. Restart the application if you recently installed Node.js'
    })
  })

  it('reports unresolved with the uv guidance when uv and uvx are not on PATH', async () => {
    const expected =
      'uvx not found in PATH.\n' +
      'Please either:\n' +
      '1. Install uv from https://github.com/astral-sh/uv\n' +
      '2. Restart the application if you recently installed uvx'

    await expect(resolve('uvx', ['example'])).resolves.toMatchObject({
      command: 'uvx',
      resolution: 'unresolved',
      unavailableReason: expected
    })
    await expect(resolve('uv', ['run'])).resolves.toMatchObject({
      command: 'uv',
      resolution: 'unresolved',
      unavailableReason: expected.replace(/uvx/g, 'uv')
    })
  })

  it('resolves the user’s own uv and uvx to full paths without rewriting args', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/uvx')

    expect(await resolve('uvx', ['example'])).toMatchObject({
      command: '/usr/local/bin/uvx',
      args: ['example'],
      resolution: 'system'
    })
  })

  it('passes the registry through the env each package manager reads', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/tool')

    expect((await resolve('npx', [], 'https://registry.example')).env).toEqual({
      NPM_CONFIG_REGISTRY: 'https://registry.example'
    })
    expect((await resolve('uvx', [], 'https://registry.example')).env).toEqual({
      UV_DEFAULT_INDEX: 'https://registry.example',
      PIP_INDEX_URL: 'https://registry.example'
    })
    expect((await resolve('node', [], 'https://registry.example')).env).toEqual({})
  })

  it('probes known runners in the login-shell env and other commands via shell lookup', async () => {
    commandMock.findExecutableInEnv.mockResolvedValue('/usr/local/bin/npx')
    commandMock.findCommandInShellEnv.mockResolvedValue('/opt/tools/my-server')

    await resolve('npx', [])
    expect(commandMock.findExecutableInEnv).toHaveBeenCalledWith('npx', {
      env: { PATH: '/usr/bin' },
      signal: undefined
    })
    expect(commandMock.findCommandInShellEnv).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await resolve('my-server', [])
    expect(commandMock.findCommandInShellEnv).toHaveBeenCalledWith('my-server', { PATH: '/usr/bin' }, undefined)
    expect(commandMock.findExecutableInEnv).not.toHaveBeenCalled()
  })

  it('resolves an unknown command to a full path, and keeps it verbatim when resolution fails', async () => {
    commandMock.findCommandInShellEnv.mockResolvedValueOnce('/opt/tools/my-server')
    expect((await resolve('my-server', ['--stdio'])).command).toBe('/opt/tools/my-server')

    const unresolved = await resolve('my-server', ['--stdio'])
    expect(unresolved.command).toBe('my-server')
    expect(unresolved.resolution).toBe('unresolved')
  })

  it('returns unresolved facts without adding a diagnostic-specific policy', async () => {
    await expect(
      resolveLaunchCommand({
        command: 'missing-server',
        args: [],
        loginShellEnv: { PATH: '/usr/bin' },
        logger
      })
    ).resolves.toMatchObject({ resolution: 'unresolved', command: 'missing-server' })
  })

  it('normalizes surrounding whitespace before resolving or falling back', async () => {
    const launch = await resolve('  my-server  ', ['--stdio'])

    expect(commandMock.findCommandInShellEnv).toHaveBeenCalledWith('my-server', { PATH: '/usr/bin' }, undefined)
    expect(launch.command).toBe('my-server')
  })

  it('rejects a command that is empty after normalization', async () => {
    await expect(resolve('   ')).rejects.toThrow(/MCP stdio command cannot be empty/)
    expect(commandMock.findCommandInShellEnv).not.toHaveBeenCalled()
  })
})
