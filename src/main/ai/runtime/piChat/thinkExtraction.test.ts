import { describe, expect, it } from 'vitest'

import type { CherryUIMessageChunk } from '@shared/data/types/message'

import { createThinkExtractionSink } from './thinkExtraction'

type Textish =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }

function harness(tagName = 'think') {
  const out: CherryUIMessageChunk[] = []
  const sink = createThinkExtractionSink((chunk) => out.push(chunk), tagName)
  return {
    out,
    sink,
    textish: () => out.filter((chunk) => /text-|reasoning-/.test(chunk.type)) as unknown as Textish[],
    feed: (...chunks: Textish[]) => chunks.forEach(sink)
  }
}

describe('createThinkExtractionSink', () => {
  it('routes tag-bounded content into reasoning chunks, splitting tags across deltas', () => {
    const { sink, textish } = harness()
    sink({ type: 'text-start', id: 'pi-1-text-0' })
    sink({ type: 'text-delta', id: 'pi-1-text-0', delta: '<thi' })
    sink({ type: 'text-delta', id: 'pi-1-text-0', delta: 'nk>plan' })
    sink({ type: 'text-delta', id: 'pi-1-text-0', delta: 'ning</th' })
    sink({ type: 'text-delta', id: 'pi-1-text-0', delta: 'ink>answer' })
    sink({ type: 'text-end', id: 'pi-1-text-0' })

    expect(textish()).toEqual([
      { type: 'reasoning-start', id: 'pi-1-text-0-reasoning-0' },
      { type: 'reasoning-delta', id: 'pi-1-text-0-reasoning-0', delta: 'plan' },
      { type: 'reasoning-delta', id: 'pi-1-text-0-reasoning-0', delta: 'ning' },
      { type: 'reasoning-end', id: 'pi-1-text-0-reasoning-0' },
      { type: 'text-start', id: 'pi-1-text-0' },
      { type: 'text-delta', id: 'pi-1-text-0', delta: 'answer' },
      { type: 'text-end', id: 'pi-1-text-0' }
    ])
  })

  it('passes plain text through with the delayed start flushed on the first delta', () => {
    const { sink, textish } = harness()
    sink({ type: 'text-start', id: 't' })
    sink({ type: 'text-delta', id: 't', delta: 'hello world' })
    sink({ type: 'text-end', id: 't' })
    expect(textish()).toEqual([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hello world' },
      { type: 'text-end', id: 't' }
    ])
  })

  it('keeps an unclosed tag as reasoning with no reasoning-end; holds only prefixes of the next tag', () => {
    const { sink, textish } = harness()
    sink({ type: 'text-start', id: 't' })
    sink({ type: 'text-delta', id: 't', delta: 'before <think>still thinking <thi' })
    sink({ type: 'text-end', id: 't' })

    // SDK parity: reasoning streams with no synthetic end; the orphan text-start is
    // flushed before the text it delays; `<thi` is no prefix of `</think>`, so it rides
    // as reasoning content — only a true trailing prefix of the NEXT tag is held back.
    expect(textish()).toEqual([
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'before ' },
      { type: 'reasoning-start', id: 't-reasoning-0' },
      { type: 'reasoning-delta', id: 't-reasoning-0', delta: 'still thinking <thi' },
      { type: 'text-end', id: 't' }
    ])
  })

  it('inserts the SDK separator between alternating segments', () => {
    const { sink, textish } = harness()
    sink({ type: 'text-start', id: 't' })
    sink({ type: 'text-delta', id: 't', delta: '<think>a</think>b<think>c</think>d' })
    sink({ type: 'text-end', id: 't' })
    const deltas = textish().filter((chunk) => chunk.type.endsWith('-delta'))
    expect(deltas.map((chunk) => ('delta' in chunk ? chunk.delta : ''))).toEqual(['a', 'b', '\nc', '\nd'])
  })

  it('passes non-text chunks through statelessly, ahead of a delayed text-start', () => {
    const { sink, out, textish } = harness()
    sink({ type: 'text-start', id: 't' })
    sink({ type: 'start-step' })
    sink({ type: 'text-delta', id: 't', delta: 'goes last' })
    expect(out[0]).toEqual({ type: 'start-step' })
    expect(textish()[0]).toEqual({ type: 'text-start', id: 't' })
  })

  it('keeps synthetic reasoning ids distinct across multiple text blocks', () => {
    const { sink, textish } = harness()
    for (const [id, delta] of [
      ['pi-2-text-0', '<think>one'],
      ['pi-2-text-1', '<think>two']
    ] as const) {
      sink({ type: 'text-start', id })
      sink({ type: 'text-delta', id, delta })
      sink({ type: 'text-end', id })
    }
    const ids = textish()
      .filter((chunk) => chunk.type.startsWith('reasoning-'))
      .map((chunk) => chunk.id)
    // Unclosed tags → start+delta per block; both blocks' parts carry DISTINCT ids
    // (the SDK's bare `reasoning-0` would collide here — pi messages are multi-block).
    expect(ids).toEqual([
      'pi-2-text-0-reasoning-0',
      'pi-2-text-0-reasoning-0',
      'pi-2-text-1-reasoning-0',
      'pi-2-text-1-reasoning-0'
    ])
    expect(new Set(ids).size).toBe(2)
  })
})
