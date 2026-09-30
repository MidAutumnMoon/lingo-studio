import type * as Streamdown from 'streamdown'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLatexMarkdownBlockParser } from '../parseLatexMarkdownBlocks'

// Passthrough spy so the work-bound test can measure how many bytes each tick
// feeds to the full splitter (everything the frozen prefix saves).
const lexedBytes = { total: 0 }
vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof Streamdown>()
  const wrapped = (source: string) => {
    lexedBytes.total += source.length
    return actual.parseMarkdownIntoBlocks(source)
  }
  return { ...actual, parseMarkdownIntoBlocks: wrapped }
})

describe('LaTeX streaming blocks', () => {
  it('keeps newly closed formulas together as a message grows and is edited', () => {
    const parse = createLatexMarkdownBlockParser()
    const first = '\\[\nx\n=\n\ny\n\\]'
    const second = '\\[\na\n=\n\nb\n\\]'

    parse(`Intro\n\n${first.slice(0, -2)}`)
    for (const source of [
      `Intro\n\n${first}\n\nAfter`,
      `Intro\n\n${first}\n\nAfter more text`,
      `Intro\n\n${first}\n\n${second}\n\nAfter`,
      'Edited introduction\n\n' + `${first}\n\nAfter`
    ]) {
      const blocks = parse(source)
      expect(blocks.join('')).toBe(source)
      expect(blocks.some((block) => block.includes(first))).toBe(true)
      if (source.includes(second)) expect(blocks.some((block) => block.includes(second))).toBe(true)
    }
  })

  it('rechecks the closing line when appended text makes the delimiter inline', () => {
    const parse = createLatexMarkdownBlockParser()
    const formula = '\\[\nx\n=\n\ny\n\\]'

    expect(parse(formula)).toEqual([formula])
    const source = `${formula} ordinary text`
    const blocks = parse(source)
    expect(blocks.join('')).toBe(source)
    expect(blocks.some((block) => block.includes(formula))).toBe(false)
  })

  it('preserves Markdown containers and literal delimiters in fenced code', () => {
    const parse = createLatexMarkdownBlockParser()
    const quote = '> \\[\n> x\n> =\n> \n> y\n> \\]'
    const code = '```text\n\\[\nx\n=\n\ny\n\\]\n```'
    const source = `${quote}\n\n${code}\n\nAfter`
    const blocks = parse(source)

    expect(blocks.join('')).toBe(source)
    expect(blocks.some((block) => block.includes(quote))).toBe(true)
    expect(blocks.some((block) => block.includes(code))).toBe(true)
  })
})

describe('incremental block split', () => {
  beforeEach(() => {
    lexedBytes.total = 0
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  // Deterministic pseudo-random corpus: paragraphs, lists, fences, tables,
  // headings, setext tails, and $$ math.
  function buildCorpus(seed: number, chunkCount: number): string[] {
    let state = seed
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const parts: string[] = []
    for (let i = 0; i < chunkCount; i += 1) {
      const kind = Math.floor(rand() * 7)
      if (kind === 0) parts.push(`Paragraph ${i} with some **bold** and a [link](https://example.com/${i}).\n\n`)
      else if (kind === 1) parts.push(`- item ${i}.1\n- item ${i}.2\n\n`)
      else if (kind === 2) parts.push('```ts\n' + `const x${i} = ${i}\n`.repeat(1 + Math.floor(rand() * 3)) + '```\n\n')
      else if (kind === 3) parts.push(`## Heading ${i}\n\n| a | b |\n| - | - |\n| ${i} | ${i * 2} |\n\n`)
      else if (kind === 4) parts.push(`Setext heading ${i}\n===\n\n`)
      else if (kind === 5) parts.push(`Math ${i}\n\n$$\n${i} + ${i} = ${i * 2}\n$$\n\n`)
      else parts.push(`Plain continuation ${i} text.\n\n`)
    }
    return parts
  }

  // Streams `parts` grapheme-wise through `parse`, asserting per-tick equality
  // with the installed streamdown full split.
  function expectStreamMatchesFullSplit(parts: string[]) {
    const parse = createLatexMarkdownBlockParser()
    let settled = ''
    for (const part of parts) {
      for (let cut = 1; cut < 3; cut += 1) {
        const source = settled + part.slice(0, Math.ceil((part.length * cut) / 3))
        if (source === settled) continue
        expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
      }
      settled += part
      expect(parse(settled)).toEqual(parseMarkdownIntoBlocks(settled))
    }
  }

  it('matches the full splitter on every append-only tick', () => {
    expectStreamMatchesFullSplit(buildCorpus(7, 60))
  })

  it('matches the full splitter when a blank-separated ordered list reopens', () => {
    // A bare `3` after a closed list lexes as a paragraph; the completing `.`
    // re-merges it into the list — the re-lex region must reach back to the
    // list block behind the whitespace.
    const parse = createLatexMarkdownBlockParser()
    const stages = ['Intro.\n\n', '1. a\n2. b\n\n', '3', '3.', '3. c\n\n', '4', '4. d\n\n', 'Tail.\n']
    let source = ''
    for (const stage of stages) {
      source += stage
      expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
    }
  })

  it('matches the full splitter across setext and $$ tails', () => {
    expectStreamMatchesFullSplit([
      'Title line\n\n',
      '==\n\n',
      'Before math.\n\n',
      '$$\nx = 1\n\n',
      '$$\n\n',
      'After math.\n\n'
    ])
  })

  it('takes the single-block path for CRLF footnote sources', () => {
    const parse = createLatexMarkdownBlockParser()
    const source = 'Para one.\r\nPara two.\r\n\r\nClaim[^1] text.\r\n\r\n[^1]: Note.\r\n'
    // marked normalizes CR before lexing, so offsets cannot align — one block,
    // matching streamdown's whole-source footnote collapse.
    expect(parse(source)).toEqual([source])
  })

  it('self-heals to the full splitter after a non-append edit', () => {
    const parse = createLatexMarkdownBlockParser()
    const grown = 'Start\n\n' + 'Paragraph.\n\n'.repeat(10)
    let source = ''
    for (const chunk of grown.match(/.{1,12}/g) ?? []) {
      source += chunk
      parse(source)
    }

    const edited = 'REPLACED start\n\n' + source.slice('Start\n\n'.length)
    expect(parse(edited)).toEqual(parseMarkdownIntoBlocks(edited))
    // And keeps matching on further growth after the edit.
    source = edited + 'Tail paragraph.\n\n'
    expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
  })

  it('bounds re-lexed bytes over a whole stream', () => {
    const parse = createLatexMarkdownBlockParser()
    const parts = buildCorpus(11, 80)
    let source = ''
    for (const part of parts) {
      source += part
      parse(source)
    }
    // Every tick re-lexes at most the trailing unstable region: the accumulated input
    // across the whole stream must stay well under the quadratic full-lex baseline.
    expect(lexedBytes.total).toBeLessThan(source.length * 5)
  })

  it('keeps footnote refs and defs together while splitting the footnote-free prefix', () => {
    const parse = createLatexMarkdownBlockParser()
    const pre = 'First paragraph.\n\nSecond paragraph with prose.\n\n```js\nconst a = 1\n```\n\n'
    const footnotes = 'Claim[^1] and another[^2].\n\n[^1]: First note.\n\n[^2]: Second note.\n\nClosing.'

    const blocks = parse(pre + footnotes)
    const joined = blocks.join('')

    expect(joined).toBe(pre + footnotes)
    // The footnote-free prefix splits normally (streamdown emits inter-block
    // whitespace as its own blocks)…
    expect(blocks[0]).toBe('First paragraph.')
    expect(blocks.some((block) => block === '```js\nconst a = 1\n```')).toBe(true)
    // …and the whole footnote region stays one trailing block so refs render.
    const footnoteBlock = blocks.at(-1)
    expect(footnoteBlock).toContain('[^1]')
    expect(footnoteBlock).toContain('[^1]: First note.')
    expect(footnoteBlock).toContain('[^2]: Second note.')
  })

  it('collapses to a single block when the message starts with a footnote', () => {
    const parse = createLatexMarkdownBlockParser()
    const source = '[^1]: Note at the very top.\n\nThen prose using[^1] it.'
    // Matches streamdown's own single-block collapse for this shape.
    expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
    expect(parse(source)).toHaveLength(1)
  })

  it('treats footnote-looking text inside fences the same as streamdown (whole-source check)', () => {
    const parse = createLatexMarkdownBlockParser()
    const source = '```\n[^1]: not a real footnote\n```\n\nProse.'
    // Streamdown's regexes have no fence awareness; neither do ours — the
    // cross-check fails if streamdown ever grows fence awareness.
    expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
  })
})
