import { describe, expect, it } from 'vitest'

import { ageInDays, isRemovable } from '../logs'

// TZ=UTC in the test env, so an epoch `now` and its stamp land on the same calendar day rule everywhere.
const NOW = Date.UTC(2026, 6, 4, 10, 30)

describe('ageInDays', () => {
  it('counts calendar days between the stamp and today', () => {
    expect(ageInDays('app.2026-07-01.log', NOW)).toBe(3)
    expect(ageInDays('app.2026-07-04.log', NOW)).toBe(0)
  })

  it('returns null for undated and impossibly-dated names', () => {
    expect(ageInDays('app.log', NOW)).toBeNull()
    expect(ageInDays('app.2026-02-30.log', NOW)).toBeNull()
    expect(ageInDays('app.2026-13-01.log', NOW)).toBeNull()
  })
})

describe('isRemovable', () => {
  it('keeps files at or under the retention age and drops strictly older ones', () => {
    expect(isRemovable('app.2026-06-27.log', 7, NOW)).toBe(false) // exactly 7 days old — retained
    expect(isRemovable('app.2026-06-26.log', 7, NOW)).toBe(true)
  })

  it('never lets the retention sweep take undated or impossibly-dated files', () => {
    expect(isRemovable('app.log', 1, NOW)).toBe(false)
    expect(isRemovable('app.2026-02-30.log', 1, NOW)).toBe(false)
  })

  it('lets the manual sweep (minAgeDays 0) take undated files but keeps today’s', () => {
    expect(isRemovable('app.log', 0, NOW)).toBe(true)
    expect(isRemovable('app.2026-07-04.log', 0, NOW)).toBe(false)
  })

  it('applies to size-rolled and gzipped shards of a stamped day', () => {
    expect(isRemovable('app.2026-06-26.log.3.gz', 7, NOW)).toBe(true)
  })
})
