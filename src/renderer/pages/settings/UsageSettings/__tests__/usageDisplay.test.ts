import { describe, expect, it } from 'vitest'

import { endOfDayEpochMs, localDateOf, parseDateKey, startOfDayEpochMs, startOfLocalWeek } from '../usageDisplay'

describe('localDateOf', () => {
  it('truncates an epoch instant to its local calendar date', () => {
    expect(localDateOf(Date.UTC(2026, 6, 4, 16, 30), 'Asia/Taipei')?.toString()).toBe('2026-07-05')
    expect(localDateOf(Date.UTC(2026, 6, 4, 16, 30), 'UTC')?.toString()).toBe('2026-07-04')
  })
})

describe('day boundaries', () => {
  it('returns local midnight as the start-of-day epoch', () => {
    const date = parseDateKey('2026-07-04')
    expect(startOfDayEpochMs(date, 'Asia/Taipei')).toBe(Date.UTC(2026, 6, 3, 16))
    expect(startOfDayEpochMs(date, 'UTC')).toBe(Date.UTC(2026, 6, 4))
  })

  it('closes the day at wall-clock 23:59:59.999 even on a DST-shortened day', () => {
    // 2026-03-08 in New York is 23h long; its last wall-clock moment is still 23:59:59.999
    const springForward = parseDateKey('2026-03-08')
    expect(endOfDayEpochMs(springForward, 'America/New_York')).toBe(
      Date.UTC(2026, 2, 9, 3, 59, 59, 999) // next midnight minus 1ms in absolute time
    )
    expect(
      endOfDayEpochMs(springForward, 'America/New_York') - startOfDayEpochMs(springForward, 'America/New_York')
    ).toBe(23 * 60 * 60 * 1000 - 1)
  })
})

describe('startOfLocalWeek', () => {
  it('snaps to the locale-specific first day across a Sunday/Monday boundary', () => {
    // 2026-07-04 is a Saturday; its week starts 2026-06-28 (Sunday) or 2026-06-29 (Monday)
    expect(startOfLocalWeek(parseDateKey('2026-07-04'), 0).toString()).toBe('2026-06-28')
    expect(startOfLocalWeek(parseDateKey('2026-07-04'), 1).toString()).toBe('2026-06-29')
    expect(startOfLocalWeek(parseDateKey('2026-06-28'), 0).toString()).toBe('2026-06-28')
    expect(startOfLocalWeek(parseDateKey('2026-06-29'), 1).toString()).toBe('2026-06-29')
  })
})
