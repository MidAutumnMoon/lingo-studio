import { beforeEach, describe, expect, it, vi } from 'vitest'

const findExecutableInEnv = vi.hoisted(() => vi.fn())

vi.mock('@main/utils/commandResolver', () => ({ findExecutableInEnv }))

import { resolveDshBunRuntime } from '../bunRuntime'

beforeEach(() => {
  findExecutableInEnv.mockReset()
})

describe('resolveDshBunRuntime', () => {
  it('resolves the user’s own Bun from the login-shell PATH', async () => {
    findExecutableInEnv.mockResolvedValue('/home/user/.bun/bin/bun')

    await expect(resolveDshBunRuntime()).resolves.toBe('/home/user/.bun/bin/bun')
    expect(findExecutableInEnv).toHaveBeenCalledWith('bun')
  })

  it('fails with the designed no-longer-bundled error when Bun is absent from PATH', async () => {
    findExecutableInEnv.mockResolvedValue(null)

    await expect(resolveDshBunRuntime()).rejects.toThrow(
      'DSH requires Bun, which is no longer bundled with this app. Install Bun from https://bun.sh and restart.'
    )
  })
})
