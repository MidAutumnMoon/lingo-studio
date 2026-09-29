import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { installArchitectureMatch } = await import('../install')

const setTranslated = (value: boolean | undefined) => {
  ;(app as { runningUnderARM64Translation?: boolean }).runningUnderARM64Translation = value
}
const signal = new AbortController().signal
const ctx = { signal, share: <T>(_key: string, factory: (signal: AbortSignal) => Promise<T>) => factory(signal) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(app.getVersion).mockReturnValue('2.0.0')
  setTranslated(false)
})

describe('install-architecture-match', () => {
  it('passes on a build that matches the machine', async () => {
    await expect(installArchitectureMatch.run(ctx)).resolves.toEqual({ status: 'pass' })
  })

  // linux has no translator, so Electron does not define the property at all.
  it('passes where the platform exposes no translation flag', async () => {
    setTranslated(undefined)
    await expect(installArchitectureMatch.run(ctx)).resolves.toEqual({ status: 'pass' })
  })

  it('warns when an x64 build runs under ARM64 translation', async () => {
    setTranslated(true)
    await expect(installArchitectureMatch.run(ctx)).resolves.toMatchObject({
      status: 'warn',
      attribution: 'user-fixable',
      detail: { variant: 'translated', params: { arch: process.arch } },
      evidence: expect.arrayContaining([{ key: 'translated', value: true, dataClass: 'public' }])
    })
  })
})
