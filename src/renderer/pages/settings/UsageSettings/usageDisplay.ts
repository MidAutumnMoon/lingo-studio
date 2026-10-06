import { type LenientTimeInput, safeParseInstant } from '@renderer/utils/time'

export const DEFAULT_COST_CURRENCY = 'USD'

const pad = (value: number, width: number) => String(value).padStart(width, '0')

/** Calendar date of `input` in `timeZone` (default: system zone); null when unparseable. */
export function localDateOf(input: LenientTimeInput, timeZone?: string): Temporal.PlainDate | null {
  const instant = safeParseInstant(input, timeZone)
  return instant ? instant.toZonedDateTimeISO(timeZone ?? Temporal.Now.timeZoneId()).toPlainDate() : null
}

export function toDateKey(date: Temporal.PlainDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
}

/** Parses a `YYYY-MM-DD` key; throws on keys that are not real calendar dates (server keys always are). */
export function parseDateKey(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value)
}

export function startOfDayEpochMs(date: Temporal.PlainDate, timeZone?: string): number {
  return date.toZonedDateTime(timeZone ?? Temporal.Now.timeZoneId()).epochMilliseconds
}

/** Built as wall-clock 23:59:59.999 so a DST transition cannot shift the day boundary. */
export function endOfDayEpochMs(date: Temporal.PlainDate, timeZone?: string): number {
  return date
    .toPlainDateTime(Temporal.PlainTime.from('23:59:59.999'))
    .toZonedDateTime(timeZone ?? Temporal.Now.timeZoneId()).epochMilliseconds
}

/** `firstDayOfWeek` is Date#getDay-numbered (0=Sunday), as produced by getLocaleFirstDayOfWeek. */
export function startOfLocalWeek(date: Temporal.PlainDate, firstDayOfWeek: number): Temporal.PlainDate {
  // dayOfWeek is ISO (1=Monday…7=Sunday); % 7 maps Sunday to 0, matching getDay numbering.
  const offset = ((date.dayOfWeek % 7) - firstDayOfWeek + 7) % 7
  return date.add({ days: -offset })
}

export function formatCost(value: number, currency: string | null | undefined): string {
  const normalizedCurrency = currency?.toUpperCase() ?? DEFAULT_COST_CURRENCY
  const symbol = normalizedCurrency === 'CNY' ? '¥' : '$'

  // Below the 4-digit display floor a real cost would render as an exact zero,
  // which is indistinguishable from an unpriced request.
  if (value > 0 && value < 0.0001) {
    return `<${symbol}0.0001`
  }

  const fractionDigits = value > 0 && value < 1 ? 4 : 2

  return `${symbol}${value.toFixed(fractionDigits)}`
}
