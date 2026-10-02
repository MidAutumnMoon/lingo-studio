/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/util/merge-objects.ts) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md). The upstream `ai` dep still serves aiCore.
 */
export function mergeObjects(
  base: Record<string, any> | undefined,
  overrides: Record<string, any> | undefined
): Record<string, any> | undefined {
  if (base === undefined && overrides === undefined) {
    return undefined
  }
  if (base === undefined) {
    return overrides
  }
  if (overrides === undefined) {
    return base
  }

  const result = { ...base }
  for (const key in overrides) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const overridesValue = overrides[key]
      if (overridesValue === undefined) continue
      const baseValue = key in base ? base[key] : undefined
      const isSourceObject =
        overridesValue !== null &&
        typeof overridesValue === 'object' &&
        !Array.isArray(overridesValue) &&
        !(overridesValue instanceof Date) &&
        !(overridesValue instanceof RegExp)
      const isTargetObject =
        baseValue !== null &&
        baseValue !== undefined &&
        typeof baseValue === 'object' &&
        !Array.isArray(baseValue) &&
        !(baseValue instanceof Date) &&
        !(baseValue instanceof RegExp)
      if (isSourceObject && isTargetObject) {
        result[key] = mergeObjects(baseValue, overridesValue)
      } else {
        result[key] = overridesValue
      }
    }
  }
  return result
}
