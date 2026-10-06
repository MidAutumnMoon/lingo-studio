const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

export function createDurationFormatter(language?: string): (durationMs: number) => string {
  const millisecondFormatter = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'millisecond',
    unitDisplay: 'narrow',
    maximumFractionDigits: 0
  })
  const secondFormatter = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1
  })
  const minuteFormatter = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'narrow',
    maximumFractionDigits: 0
  })
  const durationListFormatter = new Intl.ListFormat(language, { style: 'narrow', type: 'unit' })

  return (durationMs) => {
    if (durationMs < 1000) return millisecondFormatter.format(Math.round(durationMs))

    const roundedTenths = Math.round(durationMs / 100)
    if (roundedTenths < 600) return secondFormatter.format(roundedTenths / 10)

    const minutes = Math.floor(roundedTenths / 600)
    const seconds = (roundedTenths % 600) / 10
    return durationListFormatter.format([minuteFormatter.format(minutes), secondFormatter.format(seconds)])
  }
}

export function getLocaleFirstDayOfWeek(language?: string): number {
  const locale = new Intl.Locale(language ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
    getWeekInfo(): { firstDay: number }
  }
  // Intl uses 1=Monday … 7=Sunday; Date#getDay uses 0=Sunday … 6=Saturday.
  return locale.getWeekInfo().firstDay % 7
}

export const formatRelativeTime = (value: string, language: string, now = Date.now()) => {
  const diffMs = new Date(value).getTime() - now
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })

  // Pick the unit from the *rounded* magnitude, not the raw threshold: 59m54s rounds to 60 minutes,
  // which must roll up to "1 hour ago" rather than render "60 minutes ago" (and likewise 23h59m -> a
  // day, not "24 hours ago"). Rounding the magnitude keeps both directions on the same unit —
  // `Math.round` breaks ties toward +∞, so a signed test would put -11.5 months and +11.5 months on
  // different units. Months and years use fixed averages; Intl has no calendar-aware relative unit.
  const magnitude = Math.abs(diffMs)
  const sign = diffMs < 0 ? -1 : 1
  const inUnit = (unitMs: number) => sign * Math.round(magnitude / unitMs)

  if (Math.round(magnitude / MINUTE_MS) < 60) return formatter.format(inUnit(MINUTE_MS), 'minute')
  if (Math.round(magnitude / HOUR_MS) < 24) return formatter.format(inUnit(HOUR_MS), 'hour')
  if (Math.round(magnitude / DAY_MS) < 30) return formatter.format(inUnit(DAY_MS), 'day')
  if (Math.round(magnitude / MONTH_MS) < 12) return formatter.format(inUnit(MONTH_MS), 'month')
  return formatter.format(inUnit(YEAR_MS), 'year')
}

/**
 * External timestamps arrive as epoch-ms numbers, offset-bearing strings, offset-less local
 * strings, or Date objects — the union dayjs used to absorb. Garbage degrades to null /
 * '' instead of throwing or printing 'Invalid Date'.
 */
export type LenientTimeInput = string | number | Date | Temporal.Instant | null | undefined

/** dayjs numeric tokens are locale-stable digits; the pattern set is closed so a typo cannot silently produce a mangled string. */
export type NumericTimePattern =
  | 'YYYY-MM-DD HH:mm:ss'
  | 'YYYY-MM-DD HH:mm'
  | 'YYYY-MM-DD'
  | 'HH:mm:ss'
  | 'MM/DD HH:mm'
  | 'YYYYMMDDHHmm'
  | 'YYYYMMDDHHmmss'
  | 'YYYYMMDDHHmmssSSS'
  | 'YYYY-MM-DD-HH-mm-ss'
  | 'YYYY-MM-DD_HHmmss'

const pad = (value: number, width: number) => String(value).padStart(width, '0')

type NumericTimeFields = Pick<
  Temporal.PlainDateTime,
  'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond'
>

/**
 * Padding calendar fields reproduces dayjs output byte-for-byte; Intl is unusable here — its
 * numeric styles carry locale variance (commas, native digits) that dayjs tokens never had.
 */
function expandTimeTokens(pattern: string, time: NumericTimeFields): string {
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (token) => {
    switch (token) {
      case 'YYYY':
        return pad(time.year, 4)
      case 'MM':
        return pad(time.month, 2)
      case 'DD':
        return pad(time.day, 2)
      case 'HH':
        return pad(time.hour, 2)
      case 'mm':
        return pad(time.minute, 2)
      case 'ss':
        return pad(time.second, 2)
      case 'SSS':
        return pad(time.millisecond, 3)
      default:
        return token
    }
  })
}

function tryParse<T>(parse: () => T): T | null {
  try {
    return parse()
  } catch {
    return null
  }
}

/**
 * The one lenient parse point for external timestamps — call sites never hand raw strings to
 * Temporal.Instant.from. Offset-less strings fall back to wall-clock interpretation in
 * `timeZone` (default: system zone, dayjs parity), first as a datetime, then date-only at
 * midnight. An invalid `timeZone` id still throws: that is programmer error, not dirty data.
 */
export function safeParseInstant(input: LenientTimeInput, timeZone?: string): Temporal.Instant | null {
  if (input == null) return null
  if (input instanceof Temporal.Instant) return input
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : Temporal.Instant.fromEpochMilliseconds(input.getTime())
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Temporal.Instant.fromEpochMilliseconds(input) : null
  }
  if (typeof input !== 'string') return null
  const zone = timeZone ?? Temporal.Now.timeZoneId()
  return (
    tryParse(() => Temporal.Instant.from(input)) ??
    tryParse(() => Temporal.PlainDateTime.from(input).toZonedDateTime(zone).toInstant()) ??
    tryParse(() => Temporal.PlainDate.from(input).toZonedDateTime(zone).toInstant())
  )
}

export function formatNumericTime(input: LenientTimeInput, pattern: NumericTimePattern, timeZone?: string): string {
  const instant = safeParseInstant(input, timeZone)
  if (!instant) return ''
  return expandTimeTokens(pattern, instant.toZonedDateTimeISO(timeZone ?? Temporal.Now.timeZoneId()))
}

export function formatNumericNow(pattern: NumericTimePattern, timeZone?: string): string {
  return expandTimeTokens(pattern, Temporal.Now.zonedDateTimeISO(timeZone))
}

/**
 * Backup-manager `modifiedTime` cells: S3 and local listings emit ISO strings, but WebDAV passes
 * the server's `getlastmodified` through verbatim as an RFC 1123 HTTP-date ('Wed, 21 Oct 2015
 * 07:28:00 GMT') — the one legacy format dayjs parsed for free via Date. Bridge through Date
 * only after the ISO seam declines, so ISO inputs keep Temporal semantics.
 */
export function formatBackupModifiedTime(input: LenientTimeInput): string {
  const epochMs = typeof input === 'string' && input !== '' ? Date.parse(input) : Number.NaN
  const bridged = Number.isFinite(epochMs) ? Temporal.Instant.fromEpochMilliseconds(epochMs) : null
  const instant = safeParseInstant(input) ?? bridged
  if (!instant) return ''
  return expandTimeTokens('YYYY-MM-DD HH:mm:ss', instant.toZonedDateTimeISO(Temporal.Now.timeZoneId()))
}

export type TimeFilterPeriod = 'today' | 'week' | 'month' | 'quarter'

/**
 * Lower-bound ISO instant for the global-search time filters. Millisecond precision is
 * load-bearing: the string crosses IPC into `z.iso.datetime()` schemas and `Date.parse`-based
 * `>=` comparisons in main, and Temporal's default bare-second output must never reach them.
 */
export function timeFilterLowerBoundISO(period: TimeFilterPeriod): string {
  const now = Temporal.Now.zonedDateTimeISO()
  const boundary =
    period === 'today'
      ? now.startOfDay()
      : now.subtract(period === 'week' ? { days: 7 } : { months: period === 'month' ? 1 : 3 })
  return boundary.toInstant().toString({ smallestUnit: 'millisecond' })
}

/**
 * History-table timestamps compress relative to today (HH:mm → yesterday → MM/DD → YYYY/MM/DD).
 * Buckets compare wall-clock calendar dates, not instants, so a row stamped just before local
 * midnight stays "yesterday" until the reader's date rolls over. Translated labels stay with
 * the caller; unparseable input degrades to `labels.fallback`.
 */
export function formatBucketedLocalTime(
  input: LenientTimeInput,
  labels: { yesterday: string; fallback: string }
): string {
  const instant = safeParseInstant(input)
  if (!instant) return labels.fallback
  const zone = Temporal.Now.timeZoneId()
  const zoned = instant.toZonedDateTimeISO(zone)
  const date = zoned.toPlainDate()
  const today = Temporal.Now.zonedDateTimeISO(zone).toPlainDate()
  // 'HH:mm' is intentionally outside the seam's closed pattern union; the raw expander serves it
  if (date.equals(today)) return expandTimeTokens('HH:mm', zoned)
  if (date.equals(today.subtract({ days: 1 }))) return labels.yesterday
  const monthDay = `${pad(date.month, 2)}/${pad(date.day, 2)}`
  return date.year === today.year ? monthDay : `${date.year}/${monthDay}`
}
