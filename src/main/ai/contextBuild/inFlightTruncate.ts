/**
 * In-flight tool-result truncation, engine-neutral (W5).
 *
 * Legacy reshapes what the model sees per model call through aiCore's context
 * middleware; the pi engine applies the SAME treatment at the registry tool-result
 * boundary (`chatToolAdapter`). The opaque lane's exact semantics live here so both
 * engines share one source: threshold check → never re-truncate a marker → offload with
 * the Offloader (byte-identical `<persisted-output>` markers) → plain head/tail notice.
 *
 * The per-entity codec lane is NOT ported (register row): pi v1 truncates an oversized
 * web_fetch page as broken-JSON head/tail instead of per-entity trimming.
 */
import { Offloader, PERSISTED_OUTPUT_TAG, type VFSStorageAdapter } from '@cherrystudio/ai-core'
import {
  APPROX_CHARS_PER_TOKEN,
  IN_FLIGHT_TOOL_OUTPUT_WINDOW_RATIO,
  MIN_IN_FLIGHT_TRUNCATE_THRESHOLD
} from '@main/ai/constants'
import { resolveContextWindow } from '@main/ai/contextBuild/resolveContextWindow'
import { resolveInputRoom } from '@main/ai/contextBuild/resolveInputRoom'

/** head/tail kept inline around a truncation marker (carried from P1 / #14916). */
export const IN_FLIGHT_HEAD_CHARS = 500
export const IN_FLIGHT_TAIL_CHARS = 1_000

/**
 * In-flight trim threshold for a request: the smaller of the user's character setting
 * and a share of the model's context window (a fixed char count means wildly different
 * things per model — on small windows it must fire EARLIER, not never). A model with no
 * known window gets the absolute setting alone, never a computed `NaN`.
 */
export function resolveInFlightTruncateThreshold(
  configuredChars: number,
  contextWindow: number | undefined,
  outputReservation?: number
): number {
  const window = resolveContextWindow(contextWindow)
  if (window === null) return configuredChars
  const inputRoom = resolveInputRoom(window, outputReservation)
  const windowBudget = Math.floor(inputRoom * IN_FLIGHT_TOOL_OUTPUT_WINDOW_RATIO * APPROX_CHARS_PER_TOKEN)
  return Math.max(MIN_IN_FLIGHT_TRUNCATE_THRESHOLD, Math.min(configuredChars, windowBudget))
}

export interface InFlightTruncateOptions {
  thresholdChars: number
  /** Offload storage; absent ⇒ plain inline head/tail truncation, original discarded. */
  storage?: VFSStorageAdapter
}

/** The opaque truncation lane over one tool-result text. */
export async function truncateInFlightToolResultText(text: string, options: InFlightTruncateOptions): Promise<string> {
  const headChars = IN_FLIGHT_HEAD_CHARS
  const tailChars = IN_FLIGHT_TAIL_CHARS
  if (text.length <= options.thresholdChars || headChars + tailChars >= text.length) return text
  // Never re-truncate an already-persisted marker: with a threshold below the marker
  // size, the marker itself would be offloaded recursively — a marker pointing at one.
  if (text.includes(PERSISTED_OUTPUT_TAG)) return text

  if (options.storage) {
    try {
      const offloaded = await new Offloader({
        threshold: options.thresholdChars,
        adapter: options.storage
      }).offloadAsync(text, { threshold: options.thresholdChars, headChars, tailChars })
      return offloaded.content
    } catch {
      // Fall through to plain truncation — storage degradation never fails the tool.
    }
  }

  const head = text.slice(0, headChars)
  const tail = text.slice(text.length - tailChars)
  const totalLines = text.split('\n').length
  return [head, `\n--- truncated (${totalLines} lines, ${text.length} chars total) ---\n`, tail]
    .filter(Boolean)
    .join('')
    .trim()
}
