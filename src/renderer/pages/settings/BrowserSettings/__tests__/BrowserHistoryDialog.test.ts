import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserVisit } from '@shared/data/api/schemas/browserVisits'

import { groupVisitsByDay } from '../browserHistoryGroups'

function visitAt(visitedAt: number): BrowserVisit {
  return { id: `v${visitedAt}`, url: 'https://example.com', title: 'Example', visitedAt } as BrowserVisit
}

afterEach(() => {
  vi.useRealTimers()
})

describe('groupVisitsByDay', () => {
  it('labels today and yesterday relatively and older days by date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 10)))

    const groups = groupVisitsByDay(
      [visitAt(Date.UTC(2026, 6, 20, 9)), visitAt(Date.UTC(2026, 6, 26, 9)), visitAt(Date.UTC(2026, 6, 27, 9))],
      'en'
    )

    // groups follow visit order (Map insertion), as the pre-Temporal implementation did
    expect(groups.map((group) => group.group)).toEqual(['2026-07-20', '2026-07-26', '2026-07-27'])
    expect(groups.map((group) => group.header)).toEqual(['July 20, 2026', 'yesterday', 'today'])
  })

  it('keeps visits of one calendar day in a single group', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 10)))

    const groups = groupVisitsByDay([visitAt(Date.UTC(2026, 6, 26, 1)), visitAt(Date.UTC(2026, 6, 26, 23))], 'en')

    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].header).toBe('yesterday')
  })
})
