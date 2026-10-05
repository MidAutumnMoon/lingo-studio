import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toast } from '@renderer/services/toast'

import { copyApiKeyToClipboard } from '../copyApiKeyToClipboard'

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      warn: loggerWarnMock
    })
  }
}))

describe('copyApiKeyToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // happy-dom defines navigator.clipboard as a getter-only prototype accessor,
    // so defineProperty (which works in jsdom too) replaces it instead of Object.assign.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    })
  })

  it('shows success feedback after copying', async () => {
    await copyApiKeyToClipboard('sk-test', (key) => key)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sk-test')
    expect(toast.success).toHaveBeenCalledWith('message.copied')
  })

  it('shows error feedback when copying fails', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('copy failed'))

    await copyApiKeyToClipboard('sk-test', (key) => key)

    expect(loggerWarnMock).toHaveBeenCalledWith('Failed to copy API key to clipboard', expect.any(Error))
    expect(toast.error).toHaveBeenCalledWith('common.copy_failed')
  })
})
