import { describe, expect, it } from 'vitest'

import {
  compareResourceRecency,
  composeResourceListGroupResolvers,
  createPinnedFirstSorter,
  createPinnedGroupResolver,
  createTimeGroupResolver,
  resolveResourceTimeGroup,
  sortByResourceGroupRank,
  sortRankedResourceItems,
  withSoleGroupLabelHidden
} from '../resourceListBase'
import { compareResourceOrderKey } from '../resourceListBase'

type TestItem = {
  id: string
  pinned?: boolean
  updatedAt: string
}

const TIER_LABELS = {
  tiers: {
    today: 'Today',
    yesterday: 'Yesterday',
    'seven-days': '7 Days',
    'thirty-days': '30 Days'
  },
  invalid: 'Earlier'
}

function localIso(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour).toISOString()
}

describe('resolveResourceTimeGroup', () => {
  it('walks the ladder by whole local days: today, yesterday, 7 days (2-7), 30 days (8-30), then months', () => {
    const now = new Date(2026, 4, 15, 12)

    expect(resolveResourceTimeGroup(localIso(2026, 5, 15, 9), now)).toMatchObject({ kind: 'tier', tier: 'today' })
    expect(resolveResourceTimeGroup(localIso(2026, 5, 14, 23), now)).toMatchObject({ kind: 'tier', tier: 'yesterday' })
    expect(resolveResourceTimeGroup(localIso(2026, 5, 13, 1), now)).toMatchObject({ kind: 'tier', tier: 'seven-days' })
    expect(resolveResourceTimeGroup(localIso(2026, 5, 8, 1), now)).toMatchObject({ kind: 'tier', tier: 'seven-days' })
    expect(resolveResourceTimeGroup(localIso(2026, 5, 7, 23), now)).toMatchObject({ kind: 'tier', tier: 'thirty-days' })
    expect(resolveResourceTimeGroup(localIso(2026, 4, 15, 23), now)).toMatchObject({
      kind: 'tier',
      tier: 'thirty-days'
    })
    expect(resolveResourceTimeGroup(localIso(2026, 4, 14, 23), now)).toMatchObject({
      kind: 'month',
      monthKey: '2026-04'
    })
  })

  it('never leaves a hole in the middle of the ladder, whatever day of the week it is', () => {
    // The old calendar-week bucket was empty by construction on the first day or two of the
    // locale's week, dumping everything older than yesterday into the terminal bucket. Rolling
    // tiers must classify a 3-day-old item identically every day of the week.
    const base = new Date(2026, 4, 10, 12)

    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const now = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, 12)
      const item = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12).toISOString()

      expect(resolveResourceTimeGroup(item, now), `now=${now.toDateString()}`).toMatchObject({
        kind: 'tier',
        tier: 'seven-days'
      })
    }
  })

  it('keeps adjacent local days apart even when they are less than 24h from each other', () => {
    const now = new Date(2026, 4, 15, 0, 1)
    const latePreviousDay = new Date(2026, 4, 14, 23, 59).toISOString()

    expect(resolveResourceTimeGroup(latePreviousDay, now)).toMatchObject({ kind: 'tier', tier: 'yesterday' })
  })

  it('buckets anything older than 30 days by its calendar month with a stable id', () => {
    const now = new Date(2026, 8, 30, 12)

    const august = resolveResourceTimeGroup(localIso(2026, 8, 16, 8), now)
    expect(august).toMatchObject({ kind: 'month', id: 'time:2026-08', monthKey: '2026-08' })

    const previousYear = resolveResourceTimeGroup(localIso(2025, 11, 1, 8), now)
    expect(previousYear).toMatchObject({ kind: 'month', id: 'time:2025-11', monthKey: '2025-11' })

    // The current month can never surface as a month group: anything older than the 30-day tier
    // always predates the current month.
    const earliestStillTier = resolveResourceTimeGroup(localIso(2026, 8, 31, 0), now)
    expect(earliestStillTier).toMatchObject({ kind: 'tier', tier: 'thirty-days' })
  })

  it('ranks tiers before months and newer months before older ones', () => {
    const now = new Date(2026, 8, 30, 12)
    const today = resolveResourceTimeGroup(localIso(2026, 9, 30, 8), now).rank
    const sevenDays = resolveResourceTimeGroup(localIso(2026, 9, 25, 8), now).rank
    const thirtyDays = resolveResourceTimeGroup(localIso(2026, 9, 5, 8), now).rank
    const august = resolveResourceTimeGroup(localIso(2026, 8, 16, 8), now).rank
    const july = resolveResourceTimeGroup(localIso(2026, 7, 1, 8), now).rank
    const lastYear = resolveResourceTimeGroup(localIso(2025, 3, 1, 8), now).rank
    const invalid = resolveResourceTimeGroup('not a date', now).rank

    expect(today).toBeLessThan(sevenDays)
    expect(sevenDays).toBeLessThan(thirtyDays)
    expect(thirtyDays).toBeLessThan(august)
    expect(august).toBeLessThan(july)
    expect(july).toBeLessThan(lastYear)
    expect(lastYear).toBeLessThan(invalid)
  })

  it('parks unusable timestamps in the invalid rung instead of minting phantom groups', () => {
    const now = new Date(2026, 8, 30, 12)

    expect(resolveResourceTimeGroup(undefined, now)).toMatchObject({ kind: 'invalid', id: 'time:invalid' })
    expect(resolveResourceTimeGroup('not a date', now)).toMatchObject({ kind: 'invalid', id: 'time:invalid' })
    // Clock skew can produce future timestamps; they must not create a visible future-month group.
    expect(resolveResourceTimeGroup(localIso(2026, 12, 1, 8), now)).toMatchObject({ kind: 'invalid' })
    // Epoch-zero and friends are corrupt data, not history.
    expect(resolveResourceTimeGroup(new Date(0).toISOString(), now)).toMatchObject({ kind: 'invalid' })
  })
})

describe('createTimeGroupResolver', () => {
  const resolver = createTimeGroupResolver<TestItem>({
    getTimestamp: (item) => item.updatedAt,
    labels: TIER_LABELS,
    now: new Date(2026, 8, 30, 12)
  })

  it('labels tiers from the record, months with their literal numeric key', () => {
    expect(resolver({ id: 'today', updatedAt: localIso(2026, 9, 30, 8) })).toEqual({
      id: 'time:today',
      label: 'Today'
    })
    expect(resolver({ id: 'month', updatedAt: localIso(2026, 8, 16, 8) })).toEqual({
      id: 'time:2026-08',
      label: '2026-08'
    })
  })

  it('composes with a pinned resolver, pinned winning', () => {
    const composed = composeResourceListGroupResolvers(
      createPinnedGroupResolver({
        isPinned: (item: TestItem) => item.pinned === true,
        group: { id: 'pinned', label: 'Pinned' }
      }),
      resolver
    )

    expect(composed({ id: 'p', pinned: true, updatedAt: localIso(2026, 8, 16, 8) })).toEqual({
      id: 'pinned',
      label: 'Pinned'
    })
    expect(composed({ id: 'n', updatedAt: localIso(2026, 8, 16, 8) })).toEqual({ id: 'time:2026-08', label: '2026-08' })
  })
})

describe('withSoleGroupLabelHidden', () => {
  const now = new Date(2026, 8, 30, 12)
  const resolver = createTimeGroupResolver<TestItem>({
    getTimestamp: (item) => item.updatedAt,
    labels: TIER_LABELS,
    now
  })

  it('blanks the header of a one-group list, but not when the group is ignored', () => {
    const soleMonth = [
      { id: 'a', updatedAt: localIso(2026, 8, 16, 8) },
      { id: 'b', updatedAt: localIso(2026, 8, 2, 8) }
    ]
    expect(withSoleGroupLabelHidden(resolver, soleMonth)({ ...soleMonth[0] })).toEqual({
      id: 'time:2026-08',
      label: ''
    })
    expect(
      withSoleGroupLabelHidden(resolver, soleMonth, { ignoreGroupIds: ['time:2026-08'] })({ ...soleMonth[0] })
    ).toEqual({ id: 'time:2026-08', label: '2026-08' })

    const mixed = [...soleMonth, { id: 'c', updatedAt: localIso(2026, 9, 30, 8) }]
    expect(withSoleGroupLabelHidden(resolver, mixed)({ ...soleMonth[0] })).toEqual({
      id: 'time:2026-08',
      label: '2026-08'
    })
  })
})

describe('ranked sorting', () => {
  it('sorts pinned items into a stable top layer before derived groups are rendered', () => {
    const items: TestItem[] = [
      { id: 'today', updatedAt: localIso(2026, 5, 12, 9) },
      { id: 'pinned-old', pinned: true, updatedAt: localIso(2026, 5, 4, 23) },
      { id: 'week', updatedAt: localIso(2026, 5, 6, 9) },
      { id: 'pinned-new', pinned: true, updatedAt: localIso(2026, 5, 12, 9) }
    ]

    expect(
      sortByResourceGroupRank(items, createPinnedFirstSorter({ isPinned: (item) => item.pinned === true })).map(
        (item) => item.id
      )
    ).toEqual(['pinned-old', 'pinned-new', 'today', 'week'])
  })

  it('keeps pinned in incoming order at the top, then orders the rest by the within-group key', () => {
    const items: TestItem[] = [
      { id: 'p-a', pinned: true, updatedAt: localIso(2026, 5, 1) },
      { id: 'n-old', updatedAt: localIso(2026, 5, 2) },
      { id: 'p-b', pinned: true, updatedAt: localIso(2026, 5, 20) },
      { id: 'n-new', updatedAt: localIso(2026, 5, 10) }
    ]

    const sorted = sortRankedResourceItems(items, {
      getRank: (item) => (item.pinned === true ? 0 : 1),
      isPinned: (item) => item.pinned === true,
      compareWithinGroup: compareResourceRecency((item) => item.updatedAt)
    })

    expect(sorted.map((item) => item.id)).toEqual(['p-a', 'p-b', 'n-new', 'n-old'])
  })

  it('separates groups by rank and falls back to a stable index tiebreak', () => {
    type OrderItem = { id: string; rank: number; orderKey: string }
    const items: OrderItem[] = [
      { id: 'g1-b', rank: 1, orderKey: 'a2' },
      { id: 'g0-x', rank: 0, orderKey: 'a9' },
      { id: 'g1-a', rank: 1, orderKey: 'a1' },
      { id: 'tie-1', rank: 1, orderKey: 'a5' },
      { id: 'tie-2', rank: 1, orderKey: 'a5' }
    ]

    const sorted = sortRankedResourceItems(items, {
      getRank: (item) => item.rank,
      isPinned: () => false,
      compareWithinGroup: (a, b) => compareResourceOrderKey(a.orderKey, b.orderKey)
    })

    expect(sorted.map((item) => item.id)).toEqual(['g0-x', 'g1-a', 'g1-b', 'tie-1', 'tie-2'])
  })

  it('compareResourceRecency ranks newer first and treats unparseable timestamps as equal', () => {
    const compare = compareResourceRecency<{ updatedAt: string }>((item) => item.updatedAt)

    expect(compare({ updatedAt: localIso(2026, 5, 10) }, { updatedAt: localIso(2026, 5, 1) })).toBeLessThan(0)
    expect(compare({ updatedAt: localIso(2026, 5, 1) }, { updatedAt: localIso(2026, 5, 10) })).toBeGreaterThan(0)
    expect(compare({ updatedAt: 'nonsense' }, { updatedAt: localIso(2026, 5, 1) })).toBe(0)
  })
})
