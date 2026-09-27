import { describe, expect, it } from 'vitest'

import {
  IN_FLIGHT_HEAD_CHARS,
  IN_FLIGHT_TAIL_CHARS,
  resolveInFlightTruncateThreshold,
  truncateInFlightToolResultText
} from './inFlightTruncate'

describe('resolveInFlightTruncateThreshold', () => {
  it('takes the smaller of the configured cap and a window-derived budget', () => {
    // 1M window, no reservation: budget = floor((1M - reserve) * 0.1 * 3) >> 100k configured.
    expect(resolveInFlightTruncateThreshold(100_000, 1_000_000)).toBe(100_000)
    // 16k window: budget ~ floor(16k * 0.3) = 4800 < 100k.
    expect(resolveInFlightTruncateThreshold(100_000, 16_000)).toBe(4800)
  })

  it('floors the window-derived budget and keeps the setting when no window is known', () => {
    expect(resolveInFlightTruncateThreshold(100_000, 100)).toBe(2000)
    expect(resolveInFlightTruncateThreshold(80_000, undefined)).toBe(80_000)
  })
})

describe('truncateInFlightToolResultText', () => {
  const huge = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}`

  it('passes short text and text under the head+tail span through untouched', async () => {
    expect(await truncateInFlightToolResultText('small', { thresholdChars: 100 })).toBe('small')
    expect(await truncateInFlightToolResultText('x'.repeat(1200), { thresholdChars: 10 })).toBe('x'.repeat(1200))
  })

  it('truncates oversized text with the legacy notice when no storage is available', async () => {
    const result = await truncateInFlightToolResultText(huge, { thresholdChars: 100 })
    expect(result).toContain(`--- truncated (2 lines, ${huge.length} chars total) ---`)
    expect(result.startsWith('a')).toBe(true)
    expect(result.endsWith('b')).toBe(true)
    expect(result.length).toBeLessThan(huge.length)
  })

  it('never re-truncates an already-persisted marker', async () => {
    const marker = `head ${'<persisted-output>'.repeat(400)} tail`
    expect(await truncateInFlightToolResultText(marker, { thresholdChars: 10 })).toBe(marker)
  })

  it('offloads through storage with the shared marker format', async () => {
    const written = new Map<string, string>()
    const storage = {
      write: async (filename: string, content: string) => {
        written.set(filename, content)
      },
      read: async (filename: string) => written.get(filename) ?? null,
      getPhysicalPath: (filename: string) => `/blobs/${filename}`
    }
    const result = await truncateInFlightToolResultText(huge, { thresholdChars: 100, storage })
    expect(result).toContain('<persisted-output')
    expect(result).toContain('/blobs/')
    expect([...written.values()]).toEqual([huge])
    // The excerpt keeps the head/tail spans line-snapped at the legacy sizes.
    expect(result.length).toBeLessThan(huge.length)
    expect(IN_FLIGHT_HEAD_CHARS + IN_FLIGHT_TAIL_CHARS).toBeLessThan(huge.length)
  })
})
