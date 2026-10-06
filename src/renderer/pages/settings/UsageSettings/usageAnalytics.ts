import type {
  AiUsageRecordCostTotal,
  AiUsageRecordDailyCost,
  AiUsageRecordGroupIdentity,
  AiUsageRecordStatsMetrics,
  AiUsageRecordTimelineBucket
} from '@shared/data/api/schemas/aiUsageRecords'
import type { Currency } from '@shared/data/types/model'
import { CURRENCY } from '@shared/data/types/model'

import {
  DEFAULT_COST_CURRENCY,
  endOfDayEpochMs,
  localDateOf,
  parseDateKey,
  startOfDayEpochMs,
  startOfLocalWeek,
  toDateKey
} from './usageDisplay'

export const WINDOW_KEYS = ['30d', '90d', '365d'] as const
export const GROUP_BY_KEYS = ['provider', 'model', 'apiKey', 'source'] as const
export const METRIC_KEYS = ['tokens', 'requests', 'cost'] as const
export const CHART_TYPE_KEYS = ['bar', 'line', 'pie'] as const
export const ROLLUP_KEYS = ['total', 'daily', 'weekly', 'monthly'] as const
export const TREND_ROLLUP_KEYS = ['daily', 'weekly', 'monthly'] as const
export const TOP_COUNT_KEYS = [5, 10, 20] as const

export type WindowKey = (typeof WINDOW_KEYS)[number]
export type GroupByKey = (typeof GROUP_BY_KEYS)[number]
export type UsageMetricKey = (typeof METRIC_KEYS)[number]
export type UsageChartType = (typeof CHART_TYPE_KEYS)[number]
export type UsageRollupKey = (typeof ROLLUP_KEYS)[number]
export type UsageTopCount = (typeof TOP_COUNT_KEYS)[number]

export const EMPTY_TIMELINE_BUCKETS: AiUsageRecordTimelineBucket[] = []
export const EMPTY_STATS_METRICS: AiUsageRecordStatsMetrics = {
  costCurrency: null,
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalNoCacheTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  recordCount: 0,
  requestCount: 0,
  estimatedRequestCount: 0,
  unpricedRequestCount: 0
}

export function selectCostTotal(
  costTotals: AiUsageRecordCostTotal[],
  selectedCurrency?: Currency
): AiUsageRecordCostTotal | undefined {
  return (
    costTotals.find((item) => item.currency === selectedCurrency) ??
    costTotals.find((item) => item.currency === CURRENCY.USD) ??
    costTotals[0]
  )
}

export const WINDOW_LABEL_KEYS: Record<WindowKey, string> = {
  '30d': 'settings.usage.window.30d',
  '90d': 'settings.usage.window.90d',
  '365d': 'settings.usage.window.365d'
}

export const GROUP_BY_LABEL_KEYS: Record<GroupByKey, string> = {
  provider: 'settings.usage.groupBy.provider',
  model: 'settings.usage.groupBy.model',
  apiKey: 'settings.usage.groupBy.apiKey',
  source: 'settings.usage.groupBy.source'
}

export const METRIC_LABEL_KEYS: Record<UsageMetricKey, string> = {
  tokens: 'settings.usage.metric.tokens',
  requests: 'settings.usage.metric.requests',
  cost: 'settings.usage.metric.cost'
}

export const CHART_TYPE_LABEL_KEYS: Record<UsageChartType, string> = {
  bar: 'settings.usage.chart.bar',
  line: 'settings.usage.chart.line',
  pie: 'settings.usage.chart.pie'
}

export const ROLLUP_LABEL_KEYS: Record<UsageRollupKey, string> = {
  total: 'settings.usage.rollup.total',
  daily: 'settings.usage.rollup.daily',
  weekly: 'settings.usage.rollup.weekly',
  monthly: 'settings.usage.rollup.monthly'
}

export interface TimeRange {
  from?: number
  to?: number
}

export interface BoundedTimeRange {
  from: number
  to: number
}

function getWindowDays(windowKey: WindowKey): number {
  return windowKey === '30d' ? 30 : windowKey === '90d' ? 90 : 365
}

export function getWindowRange(windowKey: WindowKey): BoundedTimeRange {
  const days = getWindowDays(windowKey)
  const today = Temporal.Now.plainDateISO()
  const from = today.subtract({ days: days - 1 })

  return {
    from: startOfDayEpochMs(from),
    to: endOfDayEpochMs(today)
  }
}

export function getPreviousWindowRange(windowKey: WindowKey): BoundedTimeRange {
  const days = getWindowDays(windowKey)
  const currentFrom = Temporal.Now.plainDateISO().subtract({ days: days - 1 })
  const previousFrom = currentFrom.subtract({ days })
  const previousTo = currentFrom.subtract({ days: 1 })

  return {
    from: startOfDayEpochMs(previousFrom),
    to: endOfDayEpochMs(previousTo)
  }
}

export function displayModelId(modelId: string | null | undefined): string {
  if (!modelId) return ''
  const separatorIndex = modelId.indexOf('::')
  return separatorIndex >= 0 ? modelId.slice(separatorIndex + 2) : modelId
}

export function applyTimelineCurrency(
  buckets: AiUsageRecordTimelineBucket[],
  dailyCosts: AiUsageRecordDailyCost[],
  currency: Currency | undefined
): AiUsageRecordTimelineBucket[] {
  const costs = new Map(
    dailyCosts.filter((item) => item.currency === currency).map((item) => [item.date, item.total] as const)
  )
  return buckets.map((bucket) => ({
    ...bucket,
    costCurrency: currency ?? null,
    totalCost: costs.get(bucket.date) ?? 0
  }))
}

export function getCacheUsageMetrics(
  buckets: Array<{
    totalNoCacheTokens?: number
    totalCacheReadTokens?: number
    totalCacheWriteTokens?: number
  }>
) {
  const noCacheTokens = buckets.reduce((sum, bucket) => sum + (bucket.totalNoCacheTokens ?? 0), 0)
  const cacheReadTokens = buckets.reduce((sum, bucket) => sum + (bucket.totalCacheReadTokens ?? 0), 0)
  const cacheWriteTokens = buckets.reduce((sum, bucket) => sum + (bucket.totalCacheWriteTokens ?? 0), 0)
  const observableTokens = noCacheTokens + cacheReadTokens + cacheWriteTokens

  return {
    noCacheTokens,
    cacheReadTokens,
    cacheWriteTokens,
    observableTokens,
    hitRate: observableTokens > 0 ? cacheReadTokens / observableTokens : undefined
  }
}

export function getBucketKey(bucket: AiUsageRecordGroupIdentity & { isOther?: true }): string {
  if (bucket.isOther) return 'other'
  const apiKeyIdentity = [bucket.apiKeyId ?? '', bucket.apiKeyAttribution ?? '', bucket.authMethod ?? ''].join(':')
  return `${bucket.providerId ?? ''}-${bucket.sourceType ?? ''}-${bucket.sourceId ?? ''}-${apiKeyIdentity}-${bucket.modelId ?? ''}`
}

export function getMetricValue(
  bucket: { totalTokens: number; totalCost: number; requestCount: number },
  metric: UsageMetricKey
): number {
  if (metric === 'requests') return bucket.requestCount
  if (metric === 'cost') return bucket.totalCost
  return bucket.totalTokens
}

export function getGenerationTokensPerSecond(entry: {
  outputTokens: number | null
  timeFirstTokenMs: number | null
  timeCompletionMs: number | null
}): number | undefined {
  if (!entry.outputTokens || !entry.timeCompletionMs) return undefined
  const ttftMs = entry.timeFirstTokenMs
  const generationMs =
    ttftMs !== null && ttftMs < entry.timeCompletionMs ? entry.timeCompletionMs - ttftMs : entry.timeCompletionMs
  return generationMs > 0 ? entry.outputTokens / (generationMs / 1000) : undefined
}

export function getLongestStreak(dateKeys: string[]): number {
  const sorted = [...dateKeys].sort()
  let longest = 0
  let current = 0
  let previous: Temporal.PlainDate | undefined

  for (const key of sorted) {
    const isConsecutive = previous !== undefined && toDateKey(previous.add({ days: 1 })) === key
    current = isConsecutive ? current + 1 : 1
    longest = Math.max(longest, current)
    previous = parseDateKey(key)
  }

  return longest
}

export function toQueryRange(range: BoundedTimeRange): BoundedTimeRange {
  return range
}

export function getTimelinePoints(
  buckets: AiUsageRecordTimelineBucket[],
  range: TimeRange,
  getValue: (bucket: AiUsageRecordTimelineBucket) => number
): Array<{ date: string; value: number }> {
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const from = range.from !== undefined ? localDateOf(range.from) : first ? parseDateKey(first.date) : undefined
  const to = range.to !== undefined ? localDateOf(range.to) : last ? parseDateKey(last.date) : undefined
  if (!from || !to) return []

  const byDate = new Map(buckets.map((bucket) => [bucket.date, getValue(bucket)]))
  const points: Array<{ date: string; value: number }> = []
  for (let cursor = from; Temporal.PlainDate.compare(cursor, to) <= 0; cursor = cursor.add({ days: 1 })) {
    const date = toDateKey(cursor)
    points.push({ date, value: byDate.get(date) ?? 0 })
  }
  return points
}

export function toPeriodKey(dateKey: string, rollup: UsageRollupKey, firstDayOfWeek: number): string {
  if (rollup === 'monthly') return `${dateKey.slice(0, 7)}-01`
  if (rollup === 'weekly') return toDateKey(startOfLocalWeek(parseDateKey(dateKey), firstDayOfWeek))
  return dateKey
}

export interface HeatmapDay {
  date: Temporal.PlainDate
  key: string
  isOutsideRange: boolean
}

const MIN_HEATMAP_DAYS = 365

export function buildHeatmapDays(
  buckets: AiUsageRecordTimelineBucket[],
  range: { from?: number; to?: number } | undefined,
  firstDayOfWeek: number
): HeatmapDay[] {
  const today = Temporal.Now.plainDateISO()
  let rangeFirstDay: Temporal.PlainDate
  let rangeLastDay: Temporal.PlainDate

  if (range?.from !== undefined) {
    rangeFirstDay = localDateOf(range.from) ?? today
    rangeLastDay = localDateOf(range.to ?? Date.now()) ?? today
  } else if (buckets.length > 0) {
    rangeFirstDay = buckets
      .map((bucket) => parseDateKey(bucket.date))
      .reduce((earliest, date) => (Temporal.PlainDate.compare(date, earliest) < 0 ? date : earliest))
    rangeLastDay = today
  } else {
    rangeLastDay = today
    rangeFirstDay = today.subtract({ days: 29 })
  }

  const minimumFirstDay = rangeLastDay.subtract({ days: MIN_HEATMAP_DAYS - 1 })
  const displayFirstDay =
    Temporal.PlainDate.compare(rangeFirstDay, minimumFirstDay) < 0 ? rangeFirstDay : minimumFirstDay
  const firstWeekDay = startOfLocalWeek(displayFirstDay, firstDayOfWeek)
  const lastWeekDay = startOfLocalWeek(rangeLastDay, firstDayOfWeek).add({ days: 6 })

  // Step by calendar day, never by DAY_MS: DST days are 23h/25h long, so millisecond
  // arithmetic would duplicate or skip a local date around a transition.
  const days: HeatmapDay[] = []
  for (
    let cursor = firstWeekDay;
    Temporal.PlainDate.compare(cursor, lastWeekDay) <= 0;
    cursor = cursor.add({ days: 1 })
  ) {
    days.push({
      date: cursor,
      key: toDateKey(cursor),
      isOutsideRange:
        Temporal.PlainDate.compare(cursor, rangeFirstDay) < 0 || Temporal.PlainDate.compare(cursor, rangeLastDay) > 0
    })
  }

  return days
}

export interface UsageChartSeries {
  key: string
  identity?: AiUsageRecordGroupIdentity
  values: number[]
  total: number
}

function getScopedCost(bucket: { costCurrency: Currency | null; totalCost: number }, currency?: Currency): number {
  return currency !== undefined && (bucket.costCurrency ?? DEFAULT_COST_CURRENCY) === currency ? bucket.totalCost : 0
}

export function buildChartSeries(
  buckets: AiUsageRecordTimelineBucket[],
  periodKeys: string[],
  options: {
    rollup: UsageRollupKey
    metric: UsageMetricKey
    currency?: Currency
    topCount: number
    firstDayOfWeek: number
  }
): UsageChartSeries[] {
  const positions = new Map(periodKeys.map((key, index) => [key, index]))
  const groups = new Map<string, UsageChartSeries>()

  for (const bucket of buckets) {
    const position = positions.get(toPeriodKey(bucket.date, options.rollup, options.firstDayOfWeek))
    if (position === undefined) continue
    const value = getMetricValue(
      {
        totalTokens: bucket.totalTokens,
        totalCost: getScopedCost(bucket, options.currency),
        requestCount: bucket.requestCount
      },
      options.metric
    )
    if (value <= 0) continue

    const key = getBucketKey(bucket)
    let series = groups.get(key)
    if (!series) {
      series = {
        key,
        ...(bucket.isOther ? {} : { identity: { ...bucket } }),
        values: periodKeys.map(() => 0),
        total: 0
      }
      groups.set(key, series)
    }
    series.values[position] += value
    series.total += value
  }

  const serverOther = groups.get('other')
  const ranked = Array.from(groups.values())
    .filter((series) => series.key !== 'other')
    .sort((a, b) => b.total - a.total)
  const other: UsageChartSeries = serverOther ?? { key: 'other', values: periodKeys.map(() => 0), total: 0 }
  for (const series of ranked.slice(options.topCount)) {
    for (const [index, value] of series.values.entries()) other.values[index] += value
    other.total += series.total
  }
  return other.total > 0 ? [...ranked.slice(0, options.topCount), other] : ranked.slice(0, options.topCount)
}

export function getTimelineSeries(
  buckets: AiUsageRecordTimelineBucket[],
  range: TimeRange,
  getValue: (bucket: AiUsageRecordTimelineBucket) => number
): number[] {
  const points = getTimelinePoints(buckets, range, getValue)
  return (range.from !== undefined && range.to !== undefined ? points : points.slice(-64)).map((point) => point.value)
}

export function getRatioChange(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous <= 0) return undefined
  return (current - previous) / previous
}
