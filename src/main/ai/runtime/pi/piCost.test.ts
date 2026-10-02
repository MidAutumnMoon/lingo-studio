import { describe, expect, it } from 'vitest'

import { toProviderCost } from './piCost'

describe('toProviderCost', () => {
  it('maps a known-price pi cost into a USD providerCost with the bucket breakdown', () => {
    expect(
      toProviderCost({ input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0004, total: 0.0035 })
    ).toEqual({
      amount: 0.0035,
      currency: 'USD',
      breakdown: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0004 }
    })
  })

  it('returns undefined for a zero total — no pricing known is not "free", the computed fallback applies', () => {
    expect(toProviderCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBeUndefined()
    expect(toProviderCost({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: Number.NaN })).toBeUndefined()
  })
})
