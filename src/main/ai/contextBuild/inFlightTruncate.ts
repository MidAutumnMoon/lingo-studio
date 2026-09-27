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
import { resolveRequestedMaxOutputTokens } from '@main/ai/contextBuild/resolveOutputReservation'
import { TOOL_OUTPUT_EXCERPT_HEAD_CHARS, TOOL_OUTPUT_EXCERPT_TAIL_CHARS } from '@shared/ai/transport'
import type { Model } from '@shared/data/types/model'

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

/**
 * The in-flight threshold for one chat turn — the ONE resolution both engines consume.
 * The output-cap reservation is deliberately computed WITHOUT the custom-params slot
 * (legacy lane semantics: the assistant's custom `maxOutputTokens` was never part of the
 * reservation), so callers must not "simplify" this by folding their already-resolved
 * request cap in — that would silently change the threshold.
 */
export function resolveTurnInFlightTruncateThreshold(input: {
  truncateThreshold: number
  contextWindow: number | undefined
  callOverrideMaxTokens: number | undefined
  assistant: Parameters<typeof resolveRequestedMaxOutputTokens>[2]
  model: Model
  endpointType: Parameters<typeof resolveRequestedMaxOutputTokens>[4]
}): number {
  return resolveInFlightTruncateThreshold(
    input.truncateThreshold,
    input.contextWindow,
    resolveRequestedMaxOutputTokens(
      input.callOverrideMaxTokens,
      undefined,
      input.assistant,
      input.model,
      input.endpointType
    )
  )
}

export interface InFlightTruncateOptions {
  thresholdChars: number
  /** Offload storage; absent ⇒ plain inline head/tail truncation, original discarded. */
  storage?: VFSStorageAdapter
}

/** The opaque truncation lane over one tool-result text. */
export async function truncateInFlightToolResultText(text: string, options: InFlightTruncateOptions): Promise<string> {
  const headChars = TOOL_OUTPUT_EXCERPT_HEAD_CHARS
  const tailChars = TOOL_OUTPUT_EXCERPT_TAIL_CHARS
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
