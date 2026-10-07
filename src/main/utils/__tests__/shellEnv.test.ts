import { spawn } from 'child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force Windows code path regardless of the host platform.
vi.mock('@main/core/platform', () => ({
  isWin: true,
  isMac: false,
  isLinux: false,
  isDev: false,
  isPortable: false
}))

vi.mock('@application', () => ({
  application: {
    getPath: (key: string) => {
      if (key === 'sys.home') return 'C:\\Users\\test'
      return `/mock/${key}`
    }
  }
}))

vi.mock('child_process')

// Import AFTER mocks are registered so the module binds to mocked values.
import { getPathFromEnvironment, getShellEnv, refreshShellEnv } from '../shellEnv'

describe('shellEnv – Windows environment', () => {
  const savedEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()

    // Minimal process.env used by getWindowsEnvironment()
    process.env = {
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\TestUser',
      MISE_DATA_DIR: 'C:\\Users\\TestUser\\mise-data',
      Path: 'C:\\ParentProcessPath'
    }
  })

  afterEach(() => {
    process.env = savedEnv
  })

  it('returns the current process environment verbatim', async () => {
    const env = await refreshShellEnv()

    expect(env.Path).toBe('C:\\ParentProcessPath')
    expect(env.MISE_DATA_DIR).toBe('C:\\Users\\TestUser\\mise-data')
  })

  it('should not spawn any shell process', async () => {
    await refreshShellEnv()

    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns a copy so a caller mutating the result cannot poison the cache', async () => {
    const first = await refreshShellEnv()
    // Simulate a consumer stripping vars in place (e.g. removeEnvProxy).
    delete first.Path

    const second = await getShellEnv()
    expect(second.Path).toBe('C:\\ParentProcessPath')
  })
})

describe('getPathFromEnvironment', () => {
  it('reads PATH keys case-insensitively without copying unrelated values', () => {
    expect(getPathFromEnvironment({ Path: 'C:\\Users\\tester\\bin', SECRET: 'hidden' })).toBe('C:\\Users\\tester\\bin')
    expect(getPathFromEnvironment({ PATH: '/opt/homebrew/bin' })).toBe('/opt/homebrew/bin')
    expect(getPathFromEnvironment({ HOME: '/Users/tester' })).toBeUndefined()
  })
})
