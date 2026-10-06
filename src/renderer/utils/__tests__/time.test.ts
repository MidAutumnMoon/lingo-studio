import { describe, expect, it } from 'vitest'

import {
  createDurationFormatter,
  formatBackupModifiedTime,
  formatBucketedLocalTime,
  formatNumericNow,
  formatNumericTime,
  formatRelativeTime,
  getLocaleFirstDayOfWeek,
  safeParseInstant,
  timeFilterLowerBoundISO
} from '../time'

const NOW = new Date('2026-04-22T12:00:00Z').getTime()

describe('formatRelativeTime', () => {
  it('formats minute-level differences within one hour', () => {
    expect(formatRelativeTime('2026-04-22T11:58:00Z', 'en-US', NOW)).toBe('2 minutes ago')
  })

  it('formats hour-level differences within one day', () => {
    expect(formatRelativeTime('2026-04-22T15:00:00Z', 'en-US', NOW)).toBe('in 3 hours')
  })

  it('formats day-level differences beyond one day', () => {
    expect(formatRelativeTime('2026-04-20T12:00:00Z', 'en-US', NOW)).toBe('2 days ago')
  })

  it('rolls a sub-hour value up to the next unit at the boundary', () => {
    // 59m54s ago rounds to 60 minutes -> must read "1 hour ago", not "60 minutes ago"
    expect(formatRelativeTime(new Date(NOW - 3594000).toISOString(), 'en-US', NOW)).toBe('1 hour ago')
    // 59m54s in the future likewise rolls up to "in 1 hour"
    expect(formatRelativeTime(new Date(NOW + 3594000).toISOString(), 'en-US', NOW)).toBe('in 1 hour')
  })

  it('rolls a sub-day value up to days at the hour boundary', () => {
    // 23h59m ago rounds to 24 hours -> must read "yesterday", not "24 hours ago"
    const almostADay = 23 * 3600000 + 59 * 60000
    expect(formatRelativeTime(new Date(NOW - almostADay).toISOString(), 'en-US', NOW)).toBe('yesterday')
  })

  it('switches to months and years instead of counting hundreds of days', () => {
    expect(formatRelativeTime('2026-01-22T12:00:00Z', 'en-US', NOW)).toBe('3 months ago')
    expect(formatRelativeTime('2024-04-22T12:00:00Z', 'en-US', NOW)).toBe('2 years ago')
  })

  it('picks the same unit for equal distances in either direction', () => {
    // Math.round breaks ties toward +infinity, so a signed threshold put -11.5 months on `month` and
    // +11.5 months on `year`.
    const days = (n: number) => n * 86400000
    expect(formatRelativeTime(new Date(NOW - days(345)).toISOString(), 'en-US', NOW)).toBe('last year')
    expect(formatRelativeTime(new Date(NOW + days(345)).toISOString(), 'en-US', NOW)).toBe('next year')
    expect(formatRelativeTime(new Date(NOW - days(29.5)).toISOString(), 'en-US', NOW)).toBe('last month')
    expect(formatRelativeTime(new Date(NOW + days(29.5)).toISOString(), 'en-US', NOW)).toBe('next month')
  })

  it('leaves no gap between the day, month and year units', () => {
    const daysAgo = (days: number) => new Date(NOW - days * 86400000).toISOString()
    // 29 days is still day-level; 30 must already read as a month, never "30 days ago".
    expect(formatRelativeTime(daysAgo(29), 'en-US', NOW)).toBe('29 days ago')
    expect(formatRelativeTime(daysAgo(30), 'en-US', NOW)).toBe('last month')
    // 360 days rounds to 12 months, which must roll up rather than read "12 months ago".
    expect(formatRelativeTime(daysAgo(360), 'en-US', NOW)).toBe('last year')
  })
})

describe('createDurationFormatter', () => {
  it('formats units and decimal separators for the requested locale', () => {
    expect(createDurationFormatter('de-DE')(1_200)).toBe('1,2 Sek.')
    expect(createDurationFormatter('zh-CN')(61_200)).toBe('1分钟1.2秒')
  })

  it('carries rounded seconds into the next minute', () => {
    expect(createDurationFormatter('en-US')(119_960)).toBe('2m 0s')
  })
})

describe('getLocaleFirstDayOfWeek', () => {
  it('uses locale calendar metadata', () => {
    expect(getLocaleFirstDayOfWeek('en-US')).toBe(0)
    expect(getLocaleFirstDayOfWeek('zh-CN')).toBe(1)
  })
})

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

describe('formatBackupModifiedTime', () => {
  it('formats ISO modified times like the numeric seam', () => {
    expect(formatBackupModifiedTime('2026-07-04T09:05:06Z')).toBe('2026-07-04 09:05:06')
    expect(formatBackupModifiedTime(INSTANT_MS)).toBe(
      formatNumericTime(INSTANT_MS, 'YYYY-MM-DD HH:mm:ss', Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
  })

  it('parses WebDAV RFC 1123 HTTP-dates the ISO-only seam rejects', () => {
    // webdav `getlastmodified` arrives as 'Wed, 21 Oct 2015 07:28:00 GMT'-style strings
    expect(formatBackupModifiedTime('Sat, 04 Jul 2026 09:05:06 GMT')).toBe('2026-07-04 09:05:06')
  })

  it('degrades S3 empty lastModified and garbage to an empty string', () => {
    expect(formatBackupModifiedTime('')).toBe('')
    expect(formatBackupModifiedTime('not-a-date')).toBe('')
  })
})

describe('timeFilterLowerBoundISO', () => {
  const MS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  const DAY_MS = 86_400_000

  it('always emits millisecond-precision UTC ISO for every filter', () => {
    // The string crosses IPC into z.iso.datetime() schemas and Date.parse `>=` comparisons in main
    for (const period of ['today', 'week', 'month', 'quarter'] as const) {
      expect(timeFilterLowerBoundISO(period)).toMatch(MS_ISO)
    }
  })

  it("bounds 'today' at the current local midnight", () => {
    const ms = Date.parse(timeFilterLowerBoundISO('today'))
    const now = Date.now()
    expect(ms % DAY_MS).toBe(0) // vitest pins TZ=UTC, so local midnight is UTC midnight
    expect(now - ms).toBeGreaterThanOrEqual(0)
    expect(now - ms).toBeLessThan(DAY_MS)
  })

  it("bounds 'week' one seven-day span ago", () => {
    const ms = Date.parse(timeFilterLowerBoundISO('week'))
    const age = Date.now() - ms
    expect(age).toBeGreaterThanOrEqual(7 * DAY_MS - 5_000)
    expect(age).toBeLessThanOrEqual(7 * DAY_MS + 5_000)
  })

  it("bounds 'month' and 'quarter' one and three calendar months ago", () => {
    const monthAge = Date.now() - Date.parse(timeFilterLowerBoundISO('month'))
    expect(monthAge).toBeGreaterThanOrEqual(27 * DAY_MS)
    expect(monthAge).toBeLessThanOrEqual(32 * DAY_MS)
    const quarterAge = Date.now() - Date.parse(timeFilterLowerBoundISO('quarter'))
    expect(quarterAge).toBeGreaterThanOrEqual(89 * DAY_MS)
    expect(quarterAge).toBeLessThanOrEqual(93 * DAY_MS)
  })
})

describe('formatBucketedLocalTime', () => {
  const labels = { yesterday: '<yesterday>', fallback: '<empty>' }

  it('shows only the time for a timestamp from today', () => {
    const today = Temporal.Now.plainDateISO()
    const noon = today.toZonedDateTime('UTC').add({ hours: 12, minutes: 34 }).toInstant()
    expect(formatBucketedLocalTime(noon, labels)).toBe('12:34')
  })

  it('labels calendar-yesterday regardless of hour distance', () => {
    const yesterdayLate = Temporal.Now.zonedDateTimeISO('UTC').startOfDay().subtract({ hours: 1 }).toInstant()
    expect(formatBucketedLocalTime(yesterdayLate, labels)).toBe(labels.yesterday)
  })

  it('compresses same-year dates to MM/DD and other years to YYYY/MM/DD', () => {
    expect(formatBucketedLocalTime('2015-03-09T10:20:00Z', labels)).toBe('2015/03/09')
    const twoDaysAgo = Temporal.Now.plainDateISO().subtract({ days: 2 })
    const expected =
      twoDaysAgo.year === Temporal.Now.plainDateISO().year
        ? `${String(twoDaysAgo.month).padStart(2, '0')}/${String(twoDaysAgo.day).padStart(2, '0')}`
        : `${twoDaysAgo.year}/${String(twoDaysAgo.month).padStart(2, '0')}/${String(twoDaysAgo.day).padStart(2, '0')}`
    expect(formatBucketedLocalTime(`${twoDaysAgo}T10:20:00Z`, labels)).toBe(expected)
  })

  it('degrades unparseable input to the fallback label', () => {
    expect(formatBucketedLocalTime('garbage', labels)).toBe(labels.fallback)
    expect(formatBucketedLocalTime('', labels)).toBe(labels.fallback)
  })
})
