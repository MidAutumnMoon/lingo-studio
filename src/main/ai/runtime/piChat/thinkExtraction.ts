/**
 * Inline reasoning-tag extraction for the pi chat engine (W5 register row
 * "Inline `<think>` reasoning extraction").
 *
 * Some openai-completions servers emit reasoning as `<think>…</think>` markup inside
 * plain text; pi-ai reads structured `reasoning_content` fields but does not extract
 * inline tags, so without this the tags stream to the user as content. The legacy engine
 * used the AI SDK's `extractReasoningMiddleware` at the provider-stream level; this is
 * its chunk-level twin, consuming `text-*` chunks on the engine's enqueue path.
 *
 * Semantics copied from the SDK middleware verbatim (ai@6 extract-reasoning-middleware):
 * - `text-start` is delayed until either text actually publishes or `text-end` flushes it
 *   (a fully-reasoning block leaves an orphan empty text pair, as on legacy).
 * - Non-text chunks pass through statelessly and may overtake a delayed `text-start`
 *   (the SDK's own ordering).
 * - An unclosed tag keeps streaming reasoning with no synthetic `reasoning-end`; a
 *   trailing PARTIAL tag prefix is held and silently dropped.
 * - A `"\n"` separator is inserted between alternating reasoning/text segments.
 * - The one deviation: synthetic reasoning part ids are namespaced off the source text
 *   id (`${textId}-reasoning-${n}`) — the SDK's bare `reasoning-${n}` restarts per text
 *   block, and pi messages genuinely carry multiple text blocks per message.
 *
 * Known delta (W5 review, recorded in the plan's register): this rewrites the UI dialect
 * only — pi's settled AssistantMessage keeps the raw tags, so a within-turn continuation
 * re-sends them as visible assistant text. Closing that needs a settled-message rewrite
 * (the DSML-row class of port); the chunk twin cannot.
 */
import type { CherryUIMessageChunk } from '@shared/data/types/message'

const SEPARATOR = '\n'

interface ExtractionState {
  isFirstReasoning: boolean
  isFirstText: boolean
  afterSwitch: boolean
  isReasoning: boolean
  buffer: string
  idCounter: number
  textId: string
}

/** The earliest index of `tag`, or of a trailing partial prefix of it (hold-back start). */
function getPotentialStartIndex(text: string, tag: string): number | null {
  if (tag.length === 0) return null
  const directIndex = text.indexOf(tag)
  if (directIndex !== -1) return directIndex
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (tag.startsWith(text.substring(i))) return i
  }
  return null
}

/**
 * Wrap the engine's enqueue path so tag-bounded text re-routes into reasoning chunks.
 * Every other chunk type passes through untouched.
 */
export function createThinkExtractionSink(
  next: (chunk: CherryUIMessageChunk) => void,
  tagName: string
): (chunk: CherryUIMessageChunk) => void {
  const openingTag = `<${tagName}>`
  const closingTag = `</${tagName}>`
  const extractions = new Map<string, ExtractionState>()
  let delayedTextStart: CherryUIMessageChunk | undefined

  return (chunk) => {
    if (chunk.type === 'text-start') {
      delayedTextStart = chunk
      return
    }
    if (chunk.type === 'text-end') {
      if (delayedTextStart) {
        next(delayedTextStart)
        delayedTextStart = undefined
      }
      next(chunk)
      return
    }
    if (chunk.type !== 'text-delta') {
      next(chunk)
      return
    }

    let state = extractions.get(chunk.id)
    if (state === undefined) {
      state = {
        isFirstReasoning: true,
        isFirstText: true,
        afterSwitch: false,
        isReasoning: false,
        buffer: '',
        idCounter: 0,
        textId: chunk.id
      }
      extractions.set(chunk.id, state)
    }
    state.buffer += chunk.delta

    const publish = (text: string): void => {
      if (text.length === 0) return
      const prefix =
        state.afterSwitch && (state.isReasoning ? !state.isFirstReasoning : !state.isFirstText) ? SEPARATOR : ''
      const reasoningId = `${state.textId}-reasoning-${state.idCounter}`
      if (state.isReasoning && (state.afterSwitch || state.isFirstReasoning)) {
        next({ type: 'reasoning-start', id: reasoningId })
      }
      if (state.isReasoning) {
        next({ type: 'reasoning-delta', id: reasoningId, delta: prefix + text })
      } else {
        if (delayedTextStart) {
          next(delayedTextStart)
          delayedTextStart = undefined
        }
        next({ type: 'text-delta', id: state.textId, delta: prefix + text })
      }
      state.afterSwitch = false
      if (state.isReasoning) {
        state.isFirstReasoning = false
      } else {
        state.isFirstText = false
      }
    }

    for (;;) {
      const nextTag = state.isReasoning ? closingTag : openingTag
      const startIndex = getPotentialStartIndex(state.buffer, nextTag)
      if (startIndex === null) {
        publish(state.buffer)
        state.buffer = ''
        break
      }
      publish(state.buffer.slice(0, startIndex))
      if (startIndex + nextTag.length <= state.buffer.length) {
        state.buffer = state.buffer.slice(startIndex + nextTag.length)
        if (state.isReasoning) {
          if (state.isFirstReasoning) {
            next({ type: 'reasoning-start', id: `${state.textId}-reasoning-${state.idCounter}` })
          }
          next({ type: 'reasoning-end', id: `${state.textId}-reasoning-${state.idCounter}` })
          state.idCounter += 1
        }
        state.isReasoning = !state.isReasoning
        state.afterSwitch = true
      } else {
        state.buffer = state.buffer.slice(startIndex)
        break
      }
    }
  }
}
