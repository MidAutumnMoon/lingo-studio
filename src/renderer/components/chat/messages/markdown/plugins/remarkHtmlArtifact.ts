import type { Code, Html, Root, RootContent } from 'mdast'
import remarkParse from 'remark-parse'
import type { Plugin } from 'unified'
import { unified } from 'unified'

const rangeParser = unified().use(remarkParse).freeze()

const LEADING_HTML_METADATA_REGEX = /^(?:\s*(?:<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[\s\S]*?\?>))*/i
const HTML_DOCUMENT_START_REGEX = /^<html(?:\s|>)/i
const HTML_DOCUMENT_END_REGEX = /<\/html\s*>/i
const HTML_LANGUAGE_REGEX = /^html?$/i
const PROTECTED_HTML_PLACEHOLDER_PREFIX = '__CHERRY_STUDIO_HTML_ARTIFACT_'
const LEADING_HTML_DOCTYPE_REGEX = /^(?:\s*(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>))*\s*<!doctype(?:\s|>)/i
// A *closed* opening tag, so a half-streamed `<div` never counts as a fragment.
const HTML_FRAGMENT_START_REGEX = /^<[a-z][a-z0-9-]*(?:\s[^>]*)?>/i

interface SourceRange {
  start: number
  end: number
}

function stripLeadingHtmlMetadata(value: string): string {
  return value.replace(LEADING_HTML_METADATA_REGEX, '').trimStart()
}

/**
 * A whole HTML document (rendered as source while streaming, then gated on safety) versus a
 * fragment embedded in prose (always rendered live in the script-less preview frame).
 */
export type HtmlArtifactKind = 'document' | 'fragment'

/**
 * Classifies a possibly-partial HTML source. Returns `undefined` while a streamed prefix is
 * still too short to tell — `<!doc` and `<di` are indistinguishable, and committing early
 * would swap the whole rendering surface a few characters later.
 */
export function classifyHtmlArtifactSource(value: string): HtmlArtifactKind | undefined {
  if (LEADING_HTML_DOCTYPE_REGEX.test(value)) return 'document'

  const content = stripLeadingHtmlMetadata(value)
  if (HTML_DOCUMENT_START_REGEX.test(content)) return 'document'

  return HTML_FRAGMENT_START_REGEX.test(content) ? 'fragment' : undefined
}

function isHtmlArtifact(node: Html): boolean {
  const content = stripLeadingHtmlMetadata(node.value)
  return content.length > 0 && !/^<svg[\s>]/i.test(content)
}

function isHtmlMetadataOnly(node: Html): boolean {
  return stripLeadingHtmlMetadata(node.value).length === 0
}

function isHtmlDocumentBoundary(node: Html): boolean {
  const content = stripLeadingHtmlMetadata(node.value)
  return HTML_DOCUMENT_START_REGEX.test(content) || HTML_DOCUMENT_END_REGEX.test(node.value)
}

function findHtmlDocumentEnd(children: readonly RootContent[], startIndex: number): number | undefined {
  let documentStartIndex = startIndex

  while (true) {
    const child = children[documentStartIndex]
    if (child?.type !== 'html' || !isHtmlMetadataOnly(child)) break
    documentStartIndex += 1
  }

  const documentStart = children[documentStartIndex]
  if (
    documentStart?.type !== 'html' ||
    !HTML_DOCUMENT_START_REGEX.test(stripLeadingHtmlMetadata(documentStart.value))
  ) {
    return undefined
  }

  for (let index = documentStartIndex; index < children.length; index += 1) {
    const child = children[index]
    if (child?.type === 'html' && HTML_DOCUMENT_END_REGEX.test(child.value)) return index
  }

  return undefined
}

function getSourceRange(nodes: readonly RootContent[]): SourceRange | undefined {
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const start = first?.position?.start.offset
  const end = last?.position?.end.offset
  return start !== undefined && end !== undefined ? { start, end } : undefined
}

function createHtmlDocumentCodeNode(nodes: readonly RootContent[], source: string): Code | undefined {
  const first = nodes[0]
  const last = nodes[nodes.length - 1] ?? first
  const range = getSourceRange(nodes)
  if (!first || !last || !range) return undefined

  const position =
    first.position && last.position ? { start: first.position.start, end: last.position.end } : first.position

  return {
    type: 'code',
    lang: 'html',
    value: source.slice(range.start, range.end),
    position
  }
}

function createHtmlCodeNode(node: Html): Code {
  return {
    type: 'code',
    lang: 'html',
    value: node.value,
    position: node.position
  }
}

function collectProtectedHtmlRanges(tree: Root): SourceRange[] {
  const ranges: SourceRange[] = []

  for (let index = 0; index < tree.children.length; index += 1) {
    const documentEndIndex = findHtmlDocumentEnd(tree.children, index)
    if (documentEndIndex !== undefined) {
      const range = getSourceRange(tree.children.slice(index, documentEndIndex + 1))
      if (range) ranges.push(range)
      index = documentEndIndex
      continue
    }

    const child = tree.children[index]
    const range = child ? getSourceRange([child]) : undefined
    if (!child || !range) continue

    if (child.type === 'code' && child.lang && HTML_LANGUAGE_REGEX.test(child.lang)) {
      ranges.push(range)
      continue
    }

    if (child.type === 'html' && isHtmlArtifact(child) && !isHtmlDocumentBoundary(child)) {
      ranges.push(range)
    }
  }

  return ranges
}

/**
 * Runs general Markdown preprocessing without changing the exact source of raw
 * or fenced HTML artifacts.
 *
 * Per-message factory: under append-only growth the protected ranges before the
 * streaming tail are re-derived from a cached prefix instead of re-parsing the
 * whole message each tick. Ranges stay unfrozen while an HTML document is still
 * open (`</html>` merges consecutive nodes arbitrarily far back into one range)
 * plus a one-range margin for other reshape-at-the-boundary cases.
 */
export function createTransformMarkdownOutsideHtmlArtifacts(): (
  source: string,
  transform: (markdown: string) => string
) => string {
  let frozenRanges: SourceRange[] = []
  let frozenPrefix = ''

  const parseRanges = (source: string, offset = 0): SourceRange[] =>
    collectProtectedHtmlRanges(rangeParser.parse(source)).map((range) => ({
      start: range.start + offset,
      end: range.end + offset
    }))

  return (source, transform) => {
    if (!source.includes('<')) {
      frozenRanges = []
      frozenPrefix = ''
      return transform(source)
    }

    let ranges: SourceRange[]
    if (frozenPrefix && source.startsWith(frozenPrefix)) {
      ranges = [...frozenRanges, ...parseRanges(source.slice(frozenPrefix.length), frozenPrefix.length)]
    } else {
      ranges = parseRanges(source)
    }

    // Advance the freeze boundary: everything strictly before an open `<html`
    // document can no longer merge, and the trailing range is never frozen
    // because its node still grows with appended text.
    const openDocumentStart = findOpenHtmlDocumentStart(source)
    let freezable = openDocumentStart < 0 ? ranges : ranges.filter((range) => range.end <= openDocumentStart)
    if (freezable.length > 0) freezable = freezable.slice(0, -1)
    frozenRanges = freezable
    frozenPrefix = freezable.length > 0 ? source.slice(0, freezable[freezable.length - 1].end) : ''

    return maskProtectedRanges(source, ranges, transform)
  }
}

/**
 * Offset of the earliest `<html …>` opener that has no `</html>` after it, or
 * -1 when every document is closed. Html-looking tokens inside code — backtick
 * or tilde fences, inline code spans, indented code lines — are ignored,
 * because remark sees those as code, not html, so they never close a real
 * streaming document. Erring toward "open" only skips caching; the parse
 * result itself is unaffected.
 */
function findOpenHtmlDocumentStart(source: string): number {
  const openers: number[] = []
  const closers: number[] = []
  let index = 0
  let atLineStart = true

  // Skip a backtick/tilde run and the span or fence it opens (closing run must
  // match the opening length). A missing closer consumes the rest — always the
  // conservative direction. Tilde runs only fence at 3+, so shorter ones just
  // consume the run itself.
  const skipCodeRun = () => {
    const marker = source[index]
    const runStart = index
    while (index < source.length && source[index] === marker) index += 1
    const runLength = index - runStart
    if (runLength < 3 && marker === '~') return
    while (index < source.length) {
      if (source[index] === marker) {
        const closingStart = index
        while (index < source.length && source[index] === marker) index += 1
        if (index - closingStart === runLength) return
      } else {
        index += 1
      }
    }
  }

  while (index < source.length) {
    const char = source[index]
    if (char === '\n') {
      index += 1
      atLineStart = true
      continue
    }
    if (atLineStart && (char === '\t' || source.startsWith('    ', index))) {
      // Indented lines are code blocks or nested content, never top-level html.
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline
      continue
    }
    atLineStart = false

    if (char === '`' || char === '~') {
      skipCodeRun()
      atLineStart = index === 0 || source[index - 1] === '\n'
      continue
    }
    if (char === '<' && isHtmlTagAt(source, index, '<html')) {
      openers.push(index)
      index += 5
      continue
    }
    if (char === '<' && isHtmlTagAt(source, index, '</html')) {
      closers.push(index)
      index += 6
      continue
    }
    index += 1
  }

  for (const start of openers) {
    if (!closers.some((close) => close > start)) return start
  }
  return -1
}

/** True when `tag` (e.g. `<html` / `</html`) sits at `index` followed by whitespace or `>`. */
function isHtmlTagAt(source: string, index: number, tag: string): boolean {
  if (!source.startsWith(tag, index)) return false
  const next = source[index + tag.length]
  return next === ' ' || next === '\t' || next === '\n' || next === '>'
}

function maskProtectedRanges(source: string, ranges: SourceRange[], transform: (markdown: string) => string): string {
  if (ranges.length === 0) return transform(source)

  let placeholderPrefix = PROTECTED_HTML_PLACEHOLDER_PREFIX
  while (source.includes(placeholderPrefix)) placeholderPrefix = `_${placeholderPrefix}`

  const protectedSources: string[] = []
  let cursor = 0
  let maskedSource = ''

  for (const range of ranges) {
    const index = protectedSources.length
    protectedSources.push(source.slice(range.start, range.end))
    maskedSource += `${source.slice(cursor, range.start)}${placeholderPrefix}${index}__`
    cursor = range.end
  }
  maskedSource += source.slice(cursor)

  let transformed = transform(maskedSource)
  protectedSources.forEach((protectedSource, index) => {
    transformed = transformed.replaceAll(`${placeholderPrefix}${index}__`, protectedSource)
  })
  return transformed
}

/**
 * Routes top-level raw HTML regions through the same renderer as fenced HTML.
 * Inline HTML stays in the Markdown tree so citations and text formatting keep
 * their existing behavior.
 */
export const remarkHtmlArtifact: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file)
  const children: RootContent[] = []

  for (let index = 0; index < tree.children.length; index += 1) {
    const documentEndIndex = findHtmlDocumentEnd(tree.children, index)
    if (documentEndIndex !== undefined) {
      const documentNodes = tree.children.slice(index, documentEndIndex + 1)
      const codeNode = createHtmlDocumentCodeNode(documentNodes, source)
      if (codeNode) {
        children.push(codeNode)
      } else {
        children.push(...documentNodes)
      }
      index = documentEndIndex
      continue
    }

    const child = tree.children[index]
    if (!child) continue
    children.push(
      child.type === 'html' && isHtmlArtifact(child) && !isHtmlDocumentBoundary(child)
        ? createHtmlCodeNode(child)
        : child
    )
  }

  tree.children = children
}
