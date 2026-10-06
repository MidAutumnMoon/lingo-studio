/**
 * Temporal-based absolute-time seam, duplicated with src/renderer/utils/time.ts: Temporal is
 * banned in src/shared (tsx scripts run on Node 24), so each process carries a copy — keep in sync.
 */

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

/** Calendar-day key (`YYYY-MM-DD`) of `input` in `timeZone` (default: system zone). */
export function toLocalDayKey(input: LenientTimeInput, timeZone?: string): string | null {
  const instant = safeParseInstant(input, timeZone)
  if (!instant) return null
  const { year, month, day } = instant.toZonedDateTimeISO(timeZone ?? Temporal.Now.timeZoneId())
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Epoch-ms of local midnight that starts the calendar day `dayKey`, shifted by `dayOffset`
 * calendar days (DST-safe: shifting a day is not `DAY_MS * offset`). Null when `dayKey` is
 * not a real calendar date — callers use that to reject impossible stamps like `2026-02-30`.
 */
export function dayKeyToEpochMs(dayKey: string, options?: { dayOffset?: number; timeZone?: string }): number | null {
  const { dayOffset = 0, timeZone } = options ?? {}
  return tryParse(
    () =>
      Temporal.PlainDate.from(dayKey)
        .add({ days: dayOffset })
        .toZonedDateTime(timeZone ?? Temporal.Now.timeZoneId()).epochMilliseconds
  )
}
