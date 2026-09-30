import dayjs from 'dayjs'

export type ResourceListGroup = {
  id: string
  label: string
  count?: number
}

/** Fixed recency tiers; anything older than the 30-day tier falls into calendar-month groups. */
export type ResourceListTimeTier = 'today' | 'yesterday' | 'seven-days' | 'thirty-days'

/**
 * One rung of the time ladder. Tier and month rungs are stable: a calendar month never re-buckets
 * an item as time passes, so group ids survive restarts and persisted UI state. The invalid rung is
 * the terminal catch-all for timestamps that carry no usable date.
 */
export type ResourceListTimeGroup =
  | { kind: 'tier'; id: string; rank: number; tier: ResourceListTimeTier }
  | { kind: 'month'; id: string; rank: number; monthKey: string }
  | { kind: 'invalid'; id: string; rank: number }

export type ResourceListGroupResolver<T> = (item: T) => ResourceListGroup | null

export type ResourceListItemReorderPayload = {
  type: 'item'
  activeId: string
  overId: string
  position: 'before' | 'after'
  overType: 'group' | 'item'
  sourceGroupId: string
  targetGroupId: string
  sourceIndex: number
  targetIndex: number
}

export type ResourceListGroupReorderPayload = {
  type: 'group'
  activeGroupId: string
  overGroupId: string
  overType: 'group' | 'item'
  sourceIndex: number
  targetIndex: number
}

type TimestampInput = dayjs.ConfigType
type GroupRankResolver<T> = (item: T) => number

const MS_PER_DAY = 86_400_000
/** Anything dated before this reads as corrupt data, not history — parked in the invalid rung. */
const MIN_PLAUSIBLE_YEAR = 2000

const TIER_GROUP_IDS: Record<ResourceListTimeTier, string> = {
  today: 'time:today',
  yesterday: 'time:yesterday',
  'seven-days': 'time:seven-days',
  'thirty-days': 'time:thirty-days'
}

const TIER_RANKS: Record<ResourceListTimeTier, number> = {
  today: 1,
  yesterday: 2,
  'seven-days': 3,
  'thirty-days': 4
}

// Descending by month age: a newer month must always rank lower (sort earlier) than an older one,
// and every month rank must stay above the 30-day tier. The base leaves room for any plausible year.
const MONTH_RANK_BASE = 100_000

const INVALID_TIME_GROUP_ID = 'time:invalid'

function createInvalidTimeGroup(): ResourceListTimeGroup {
  return { kind: 'invalid', id: INVALID_TIME_GROUP_ID, rank: Number.MAX_SAFE_INTEGER }
}

/**
 * The conversation-list time ladder: Today, Yesterday, 7 Days (2-7 days back), 30 Days (8-30 days
 * back), then one group per calendar month ("2026-08"). Day math uses rounded local-midnight deltas
 * so a DST transition (two local midnights 23h/25h apart) cannot merge two days into one bucket.
 * Future timestamps and pre-2000 dates land in the invalid rung instead of minting a phantom group.
 */
export function resolveResourceTimeGroup(timestamp: TimestampInput, now?: TimestampInput): ResourceListTimeGroup {
  if (timestamp === undefined) {
    return createInvalidTimeGroup()
  }

  const item = dayjs(timestamp)
  const current = now === undefined ? dayjs() : dayjs(now)
  if (!item.isValid() || !current.isValid() || item.year() < MIN_PLAUSIBLE_YEAR) {
    return createInvalidTimeGroup()
  }

  const itemStart = item.startOf('day')
  const todayStart = current.startOf('day')
  const ageInDays = Math.round((todayStart.valueOf() - itemStart.valueOf()) / MS_PER_DAY)

  // A negative age is a future timestamp (clock skew) — park it rather than minting a phantom group.
  if (ageInDays < 0) {
    return createInvalidTimeGroup()
  }

  if (ageInDays === 0) {
    return { kind: 'tier', id: TIER_GROUP_IDS.today, rank: TIER_RANKS.today, tier: 'today' }
  }

  if (ageInDays === 1) {
    return { kind: 'tier', id: TIER_GROUP_IDS.yesterday, rank: TIER_RANKS.yesterday, tier: 'yesterday' }
  }

  if (ageInDays <= 7) {
    return { kind: 'tier', id: TIER_GROUP_IDS['seven-days'], rank: TIER_RANKS['seven-days'], tier: 'seven-days' }
  }

  if (ageInDays <= 30) {
    return {
      kind: 'tier',
      id: TIER_GROUP_IDS['thirty-days'],
      rank: TIER_RANKS['thirty-days'],
      tier: 'thirty-days'
    }
  }

  // Anything past the 30-day tier always predates the current month (a month spans at most 30
  // same-month days), so month ranks never collide with the tiers above.
  const monthKey = item.format('YYYY-MM')
  const monthIndex = item.year() * 12 + item.month()
  return { kind: 'month', id: `time:${monthKey}`, rank: MONTH_RANK_BASE - monthIndex, monthKey }
}

export type ResourceListTimeGroupLabels = {
  tiers: Record<ResourceListTimeTier, string>
  /** Label of the terminal bucket for timestamps without a usable date. */
  invalid: string
}

export function composeResourceListGroupResolvers<T>(
  ...resolvers: Array<ResourceListGroupResolver<T>>
): ResourceListGroupResolver<T> {
  return (item) => {
    for (const resolver of resolvers) {
      const group = resolver(item)
      if (group) return group
    }
    return null
  }
}

export function createPinnedGroupResolver<T>({
  group,
  isPinned
}: {
  group: ResourceListGroup
  isPinned: (item: T) => boolean
}): ResourceListGroupResolver<T> {
  return (item) => (isPinned(item) ? group : null)
}

export function createTimeGroupResolver<T>({
  getTimestamp,
  labels,
  now
}: {
  getTimestamp: (item: T) => TimestampInput
  labels: ResourceListTimeGroupLabels
  now?: TimestampInput
}): ResourceListGroupResolver<T> {
  return (item) => {
    const group = resolveResourceTimeGroup(getTimestamp(item), now)
    switch (group.kind) {
      case 'tier':
        return { id: group.id, label: labels.tiers[group.tier] }
      case 'month':
        // Month labels are the literal numeric key ("2026-08") — deliberately unlocalized.
        return { id: group.id, label: group.monthKey }
      case 'invalid':
        return { id: group.id, label: labels.invalid }
    }
  }
}

export function createPinnedFirstSorter<T>({ isPinned }: { isPinned: (item: T) => boolean }): GroupRankResolver<T> {
  return (item) => (isPinned(item) ? 0 : 1)
}

export function sortByResourceGroupRank<T>(items: readonly T[], getGroupRank: GroupRankResolver<T>): T[] {
  return items
    .map((item, index) => ({ item, index, rank: getGroupRank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item)
}

export function sortRankedResourceItems<T>(
  items: readonly T[],
  {
    getRank,
    isPinned,
    compareWithinGroup
  }: {
    getRank: (item: T) => number
    isPinned: (item: T) => boolean
    compareWithinGroup: (a: T, b: T) => number
  }
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: getRank(item), pinned: isPinned(item) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      if (a.pinned || b.pinned) return a.index - b.index
      const withinDelta = compareWithinGroup(a.item, b.item)
      if (withinDelta !== 0) return withinDelta
      return a.index - b.index
    })
    .map(({ item }) => item)
}

export function compareResourceRecency<T>(getUpdatedAt: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const aMs = Date.parse(getUpdatedAt(a))
    const bMs = Date.parse(getUpdatedAt(b))
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs
    return 0
  }
}

export type ResourceListOrderAnchor = { before: string } | { after: string } | { position: 'last' }

export function compareResourceOrderKey(a?: string, b?: string) {
  if (a && b) {
    if (a < b) return -1
    if (a > b) return 1
  }

  return 0
}

export function buildResourceListItemDropAnchor(payload: ResourceListItemReorderPayload): ResourceListOrderAnchor {
  if (payload.overType === 'item') {
    return payload.position === 'before' ? { before: payload.overId } : { after: payload.overId }
  }

  return { position: 'last' }
}

export function buildResourceListGroupDropAnchor(
  payload: Pick<ResourceListGroupReorderPayload, 'sourceIndex' | 'targetIndex'>,
  overId: string
): ResourceListOrderAnchor {
  return payload.sourceIndex < payload.targetIndex ? { after: overId } : { before: overId }
}

export function moveResourceListStringGroupAfterDrop(
  ids: readonly string[],
  activeId: string,
  overId: string,
  payload: Pick<ResourceListGroupReorderPayload, 'sourceIndex' | 'targetIndex'>
): string[] {
  const activeIndex = ids.indexOf(activeId)
  const overIndex = ids.indexOf(overId)

  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...ids]
  }

  const next = ids.filter((id) => id !== activeId)
  const adjustedOverIndex = next.indexOf(overId)
  const insertIndex = payload.sourceIndex < payload.targetIndex ? adjustedOverIndex + 1 : adjustedOverIndex
  next.splice(insertIndex, 0, activeId)

  return next
}

/**
 * Time groups only carry meaning against each other: a list that falls entirely into one group
 * gains nothing from a header saying so. Blank the label in that case — {@link ResourceList} drops
 * headers without one — while keeping the group id so ordering stays intact.
 *
 * Any other group in the list — "Pinned" in particular — puts the label back to work: it now marks
 * where that group ends, so only a list that is ONE group top to bottom drops its header.
 * `ignoreGroupIds` names groups that must keep their label even alone ("Pinned" is a state, not a
 * point on the time axis, so it stays legible on its own).
 */
export function withSoleGroupLabelHidden<T>(
  resolver: ResourceListGroupResolver<T>,
  items: readonly T[],
  { ignoreGroupIds }: { ignoreGroupIds?: readonly string[] } = {}
): ResourceListGroupResolver<T> {
  const ignored = new Set(ignoreGroupIds ?? [])
  const groupIds = new Set<string>()
  for (const item of items) {
    const group = resolver(item)
    if (group) groupIds.add(group.id)
    if (groupIds.size > 1) return resolver
  }

  const [soleGroupId] = groupIds
  if (groupIds.size !== 1 || ignored.has(soleGroupId)) return resolver

  return (item) => {
    const group = resolver(item)
    if (!group) return null
    return { ...group, label: '' }
  }
}

export function withResourceListGroupIdPrefix<T>(
  prefix: string,
  resolver: ResourceListGroupResolver<T>
): ResourceListGroupResolver<T> {
  return (item) => {
    const group = resolver(item)
    if (!group) return null
    return { ...group, id: `${prefix}${group.id}` }
  }
}
