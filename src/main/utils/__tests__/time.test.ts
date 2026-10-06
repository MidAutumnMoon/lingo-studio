import { describe, expect, it } from 'vitest'

import { dayKeyToEpochMs, formatNumericNow, formatNumericTime, safeParseInstant, toLocalDayKey } from '../time'

// This seam is a deliberate copy of src/renderer/utils/time.ts (Temporal cannot live in
// src/shared), so every contract below is pinned here independently — a divergent edit to
// either copy must fail its own suite.
const INSTANT = '2026-07-04T09:05:06.789Z'
const INSTANT_MS = Date.UTC(2026, 6, 4, 9, 5, 6, 789)

describe('safeParseInstant', () => {
  it('reads epoch-milliseconds numbers exactly', () => {
    expect(safeParseInstant(INSTANT_MS)?.epochMilliseconds).toBe(INSTANT_MS)
  })

  it('rejects NaN and infinite numbers', () => {
    expect(safeParseInstant(Number.NaN)).toBeNull()
    expect(safeParseInstant(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('parses offset-bearing strings as exact instants', () => {
    expect(safeParseInstant(INSTANT)?.epochMilliseconds).toBe(INSTANT_MS)
    expect(safeParseInstant('2026-07-04T17:05:06.789+08:00')?.epochMilliseconds).toBe(INSTANT_MS)
  })

  it('interprets offset-less strings as wall time in the given zone', () => {
    // 09:05 at UTC+8 is 01:05Z — an offset-less string must not be read as UTC
    expect(safeParseInstant('2026-07-04 09:05', 'Asia/Taipei')?.epochMilliseconds).toBe(Date.UTC(2026, 6, 4, 1, 5))
    expect(safeParseInstant('2026-07-04T09:05', 'Asia/Taipei')?.epochMilliseconds).toBe(Date.UTC(2026, 6, 4, 1, 5))
  })

  it('defaults offset-less strings to the system zone', () => {
    // vitest pins TZ=UTC, so the system zone reads 09:05 as 09:05Z
    expect(safeParseInstant('2026-07-04T09:05:06')?.epochMilliseconds).toBe(Date.UTC(2026, 6, 4, 9, 5, 6))
  })

  it('treats date-only strings as midnight in the given zone', () => {
    expect(safeParseInstant('2026-07-04', 'Asia/Taipei')?.epochMilliseconds).toBe(Date.UTC(2026, 6, 3, 16))
  })

  it('reads Date objects by epoch and rejects invalid ones', () => {
    expect(safeParseInstant(new Date(INSTANT_MS))?.epochMilliseconds).toBe(INSTANT_MS)
    expect(safeParseInstant(new Date(Number.NaN))).toBeNull()
  })

  it('passes Temporal.Instant through', () => {
    const instant = Temporal.Instant.from(INSTANT)
    expect(safeParseInstant(instant)).toBe(instant)
  })

  it('degrades unparseable input to null', () => {
    expect(safeParseInstant(null)).toBeNull()
    expect(safeParseInstant(undefined)).toBeNull()
    expect(safeParseInstant('')).toBeNull()
    expect(safeParseInstant('garbage')).toBeNull()
    // calendar-invalid dates reject instead of silently constraining to Feb 28
    expect(safeParseInstant('2026-02-30T09:05')).toBeNull()
  })
})

describe('formatNumericTime', () => {
  it('renders the display styles byte-identical to the dayjs tokens', () => {
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD HH:mm:ss', 'UTC')).toBe('2026-07-04 09:05:06')
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD HH:mm', 'UTC')).toBe('2026-07-04 09:05')
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD', 'UTC')).toBe('2026-07-04')
    expect(formatNumericTime(INSTANT, 'HH:mm:ss', 'UTC')).toBe('09:05:06')
    expect(formatNumericTime(INSTANT, 'MM/DD HH:mm', 'UTC')).toBe('07/04 09:05')
  })

  it('renders in the requested zone', () => {
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD HH:mm:ss', 'Asia/Taipei')).toBe('2026-07-04 17:05:06')
    expect(formatNumericTime(INSTANT, 'MM/DD HH:mm', 'Asia/Taipei')).toBe('07/04 17:05')
  })

  it('defaults to the system zone', () => {
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD HH:mm')).toBe('2026-07-04 09:05')
  })

  it('accepts the lenient input union', () => {
    expect(formatNumericTime(INSTANT_MS, 'YYYY-MM-DD HH:mm:ss', 'UTC')).toBe('2026-07-04 09:05:06')
    expect(formatNumericTime(new Date(0), 'YYYY-MM-DD HH:mm:ss', 'UTC')).toBe('1970-01-01 00:00:00')
  })

  it('formats unparseable input as an empty string', () => {
    expect(formatNumericTime('garbage', 'YYYY-MM-DD')).toBe('')
    expect(formatNumericTime(Number.NaN, 'HH:mm:ss')).toBe('')
    expect(formatNumericTime(null, 'YYYY-MM-DD HH:mm:ss')).toBe('')
  })
})

describe('formatNumericTime filename stamps', () => {
  it('renders the stamp patterns byte-identical', () => {
    expect(formatNumericTime(INSTANT, 'YYYYMMDDHHmm', 'UTC')).toBe('202607040905')
    expect(formatNumericTime(INSTANT, 'YYYYMMDDHHmmss', 'UTC')).toBe('20260704090506')
    expect(formatNumericTime(INSTANT, 'YYYYMMDDHHmmssSSS', 'UTC')).toBe('20260704090506789')
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD-HH-mm-ss', 'UTC')).toBe('2026-07-04-09-05-06')
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD_HHmmss', 'UTC')).toBe('2026-07-04_090506')
  })

  it('stamps in the requested zone', () => {
    expect(formatNumericTime(INSTANT, 'YYYY-MM-DD_HHmmss', 'Asia/Taipei')).toBe('2026-07-04_170506')
  })
})

describe('formatNumericNow', () => {
  it('stamps the current instant in the requested pattern', () => {
    const before = Date.now()
    const stamp = formatNumericNow('YYYY-MM-DD HH:mm:ss')
    const stamped = safeParseInstant(stamp, 'UTC')?.epochMilliseconds
    // second-truncation lets the stamp land up to a second before `before`
    expect(stamped).toBeGreaterThanOrEqual(before - 1000)
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000)
  })
})

describe('toLocalDayKey', () => {
  it('keys an instant by its calendar day in the given zone, not its UTC day', () => {
    // 16:30Z on Jul 4 is already Jul 5 in Taipei and still Jul 4 in New York
    const instant = '2026-07-04T16:30:00Z'
    expect(toLocalDayKey(instant, 'Asia/Taipei')).toBe('2026-07-05')
    expect(toLocalDayKey(instant, 'America/New_York')).toBe('2026-07-04')
  })

  it('accepts lenient inputs and degrades to null', () => {
    expect(toLocalDayKey(INSTANT_MS, 'UTC')).toBe('2026-07-04')
    expect(toLocalDayKey(new Date(0), 'UTC')).toBe('1970-01-01')
    expect(toLocalDayKey('garbage')).toBeNull()
    expect(toLocalDayKey(null)).toBeNull()
  })
})

describe('dayKeyToEpochMs', () => {
  it('returns local midnight of the keyed day in the given zone', () => {
    // Taipei midnight on Jul 4 is 16:00Z on Jul 3
    expect(dayKeyToEpochMs('2026-07-04', { timeZone: 'Asia/Taipei' })).toBe(Date.UTC(2026, 6, 3, 16))
    expect(dayKeyToEpochMs('2026-07-04', { timeZone: 'UTC' })).toBe(Date.UTC(2026, 6, 4))
  })

  it('round-trips with toLocalDayKey', () => {
    const key = toLocalDayKey('2026-11-15T23:45:00Z', 'America/New_York')
    const epoch = dayKeyToEpochMs(key!, { timeZone: 'America/New_York' })
    expect(epoch !== null && toLocalDayKey(epoch, 'America/New_York')).toBe(key)
  })

  it('shifts by calendar days, staying on local midnight across a DST transition', () => {
    // US spring-forward: Mar 8 2026 is 23h long in New York — 2026-03-08 midnight + 1 day is
    // 23h later, not 24h
    const start = dayKeyToEpochMs('2026-03-08', { timeZone: 'America/New_York' })!
    const next = dayKeyToEpochMs('2026-03-08', { timeZone: 'America/New_York', dayOffset: 1 })!
    expect(next - start).toBe(23 * 60 * 60 * 1000)
    expect(dayKeyToEpochMs('2026-02-28', { timeZone: 'America/New_York', dayOffset: 1 })).toBe(
      dayKeyToEpochMs('2026-03-01', { timeZone: 'America/New_York' })
    )
  })

  it('rejects keys that are not real calendar dates or not keys at all', () => {
    expect(dayKeyToEpochMs('2026-02-30')).toBeNull()
    expect(dayKeyToEpochMs('2026-13-01')).toBeNull()
    expect(dayKeyToEpochMs('garbage')).toBeNull()
    expect(dayKeyToEpochMs('')).toBeNull()
  })
})
