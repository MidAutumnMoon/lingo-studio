/**
 * pi `Usage.cost` → the usage record's `providerCost`. pi computes the figure
 * from its bundled per-million USD rates (cache buckets and request-wide tiers
 * included) — the raw provider-reported cost the ai-sdk lane surfaced is gone,
 * so this is the serving runtime's cost of record. A zero total means "no
 * pricing known", not "free": returning undefined lets the app-side computed
 * fallback apply instead of pinning a bogus $0 provider row.
 */
import type { Currency } from '@shared/data/types/model'

export interface PiProviderCost {
  amount: number
  currency: Currency
  breakdown: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export function toProviderCost(cost: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}): PiProviderCost | undefined {
  if (!(cost.total > 0)) return undefined
  return {
    amount: cost.total,
    currency: 'USD',
    breakdown: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite }
  }
}
