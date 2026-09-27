/**
 * Where a TOOL part carries provider metadata. The AI SDK accumulator files chunk-level
 * `providerMetadata` on tool parts under `callProviderMetadata` (input chunks) or
 * `resultProviderMetadata` (terminal chunks) — never plain `providerMetadata`, which
 * belongs to content parts (text/reasoning/file). One home for that rule: the renderer's
 * stamp readers and the pi history converter's signature readers must agree on it or
 * each side silently certifies shapes the accumulator never produces.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Read a value off a tool part's metadata homes: `read` runs against the call home
 * first, then the result home, stopping at the first non-`undefined` value — an empty or
 * namespace-less home does not shadow the other (a call-home read that misses must fall
 * through, not short-circuit).
 */
export function readToolPartMetadataValue<T>(
  part: { callProviderMetadata?: unknown; resultProviderMetadata?: unknown },
  read: (envelope: Record<string, unknown>) => T | undefined
): T | undefined {
  const call = asRecord(part.callProviderMetadata)
  if (call !== undefined) {
    const value = read(call)
    if (value !== undefined) return value
  }
  const result = asRecord(part.resultProviderMetadata)
  if (result !== undefined) return read(result)
  return undefined
}
