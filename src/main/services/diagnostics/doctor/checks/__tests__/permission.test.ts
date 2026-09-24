import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const accessibility = vi.hoisted(() => ({ isTrustedAccessibilityClient: vi.fn() }))

vi.mock('@main/core/platform', () => ({ isMac: true }))
vi.mock('electron', () => ({ systemPreferences: accessibility }))

const { accessibilityPermission } = await import('../permission')
const signal = new AbortController().signal
const ctx = { signal, share: <T>(_key: string, factory: (signal: AbortSignal) => Promise<T>) => factory(signal) }

beforeEach(() => {
  vi.clearAllMocks()
  MockMainPreferenceServiceUtils.resetMocks()
  accessibility.isTrustedAccessibilityClient.mockReturnValue(true)
})

describe('permission-accessibility', () => {
  it('does not report an unanswered trust request as fixed', async () => {
    accessibility.isTrustedAccessibilityClient.mockReturnValue(false)
    await expect(accessibilityPermission.fixes.request(ctx)).resolves.toMatchObject({ status: 'failed' })
  })
  it('passes without probing macOS when Selection Assistant is disabled', async () => {
    await expect(accessibilityPermission.run(ctx)).resolves.toEqual({ status: 'pass' })
    expect(accessibility.isTrustedAccessibilityClient).not.toHaveBeenCalled()
  })

  it('passes when Selection Assistant is enabled and trusted', async () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.selection.enabled', true)
    await expect(accessibilityPermission.run(ctx)).resolves.toEqual({ status: 'pass' })
    expect(accessibility.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
  })

  it('warns and offers a permission request when the enabled feature is not trusted', async () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.selection.enabled', true)
    accessibility.isTrustedAccessibilityClient.mockReturnValue(false)
    await expect(accessibilityPermission.run(ctx)).resolves.toMatchObject({
      status: 'warn',
      attribution: 'user-fixable',
      detail: { variant: 'denied' },
      actions: [{ kind: 'fix', fixId: 'request' }]
    })
  })

  it('requests trust from macOS when the fix runs', async () => {
    await expect(accessibilityPermission.fixes.request(ctx)).resolves.toEqual({ status: 'fixed' })
    expect(accessibility.isTrustedAccessibilityClient).toHaveBeenCalledWith(true)
  })
})
