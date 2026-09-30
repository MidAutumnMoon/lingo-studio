import { Lexer } from 'marked'
import remarkParse from 'remark-parse'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

import { remarkLatexMath } from '@renderer/utils/remarkLatexMath'

const parser = unified().use(remarkParse).use(remarkLatexMath).freeze()

/**
 * Pinned copies of streamdown's splitter footnote checks: a footnote-bearing document
 * collapses to a single block there because refs and defs must share one parse tree
 * for footnotes to render. The cross-check test fails on a streamdown bump that
 * changes these semantics.
 */
const FOOTNOTE_REF_REGEX = /\[\^[\w-]{1,200}\](?!:)/
const FOOTNOTE_DEF_REGEX = /\[\^[\w-]{1,200}\]:/

/**
 * Frozen-prefix block split. Appended text can reshape the trailing blocks
 * (setext underlines, lazy list continuations, a paragraph merging with the
 * next) and can even reopen a closed block — an ordered list split by a blank
 * line re-merges when the next bare `N` gains its dot — so the re-lexed region
 * each tick includes the last frozen block plus everything after it.
 */
const RELEX_TAIL_BLOCKS = 3

export function createLatexMarkdownBlockParser(): (source: string) => string[] {
  let cachedSource = ''
  let ranges: Array<{ start: number; end: number }> = []

  // Frozen block prefix of the previous append-only tick (raw source coordinates).
  let frozenBlocks: string[] = []
  let frozenSource = ''

  return (source: string) => {
    const blocks = splitBlocks(source)
    if (!source.includes('\\[')) return blocks

    const normalized = blocks.join('')
    const closing = normalized.lastIndexOf('\\]')
    if (closing < 0) return blocks
    const lineEnd = normalized.indexOf('\n', closing)
    const mathSource = normalized.slice(0, lineEnd < 0 ? undefined : lineEnd + 1)

    // Later prose cannot change a closed formula; retain one result per message.
    if (mathSource !== cachedSource) {
      cachedSource = mathSource
      ranges = []
      visit(parser.parse(mathSource), 'math', (node) => {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined) ranges.push({ start, end })
      })
    }

    const result: string[] = []
    let offset = 0
    let rangeIndex = 0
    let pending = ''
    for (const block of blocks) {
      pending += block
      offset += block.length
      while (ranges[rangeIndex] && ranges[rangeIndex].end <= offset) rangeIndex += 1
      if (ranges[rangeIndex] && ranges[rangeIndex].start < offset) continue
      result.push(pending)
      pending = ''
    }
    if (pending) result.push(pending)
    return result
  }

  /**
   * Under append-only growth only the trailing region can change, so the frozen
   * block prefix is reused and just the suffix is re-lexed; non-append changes bail
   * to a full re-lex. Footnote-bearing sources keep every footnote token in a single
   * trailing block while the footnote-free region before it splits normally.
   */
  function splitBlocks(source: string): string[] {
    if (FOOTNOTE_REF_REGEX.test(source) || FOOTNOTE_DEF_REGEX.test(source)) {
      return splitFootnoteSource(source)
    }
    return splitIncremental(source)
  }

  function splitIncremental(source: string): string[] {
    const blocks =
      frozenSource && source.startsWith(frozenSource)
        ? [...frozenBlocks, ...parseMarkdownIntoBlocks(source.slice(frozenSource.length))]
        : parseMarkdownIntoBlocks(source)
    frozenBlocks = blocks.length > RELEX_TAIL_BLOCKS ? blocks.slice(0, -RELEX_TAIL_BLOCKS) : []
    frozenSource = frozenBlocks.join('')
    return blocks
  }

  function splitFootnoteSource(source: string): string[] {
    // marked normalizes \r\n to \n before lexing, so token offsets misalign with
    // raw CRLF sources — take streamdown's single-block behavior for those.
    if (source.includes('\r')) return [source]
    const splitAt = firstFootnoteTokenOffset(source)
    if (splitAt <= 0) return [source]
    // The pre-footnote region is footnote-free by construction and a prefix of every
    // later tick, so it goes through the same frozen-prefix path.
    const preBlocks = splitIncremental(source.slice(0, splitAt))
    return [...preBlocks, source.slice(splitAt)]
  }

  function firstFootnoteTokenOffset(source: string): number {
    // Top-level token raws tile the source; the first one containing a footnote
    // token is where the footnote region starts.
    let offset = 0
    for (const token of Lexer.lex(source, { gfm: true })) {
      if (FOOTNOTE_REF_REGEX.test(token.raw) || FOOTNOTE_DEF_REGEX.test(token.raw)) return offset
      offset += token.raw.length
    }
    return -1
  }
}
