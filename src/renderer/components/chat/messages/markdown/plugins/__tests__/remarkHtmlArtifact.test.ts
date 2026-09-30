import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { remarkLatexMath } from '@renderer/utils/remarkLatexMath'

import {
  classifyHtmlArtifactSource,
  createTransformMarkdownOutsideHtmlArtifacts,
  remarkHtmlArtifact
} from '../remarkHtmlArtifact'

function parse(source: string, withLatexMath = false): Root {
  const processor = withLatexMath
    ? unified().use(remarkParse).use(remarkLatexMath).use(remarkHtmlArtifact)
    : unified().use(remarkParse).use(remarkHtmlArtifact)
  return processor.runSync(processor.parse(source), { value: source })
}

describe('remarkHtmlArtifact', () => {
  it('converts top-level raw HTML regions into HTML code nodes', () => {
    const tree = parse(`## Before

<div><strong>First preview</strong></div>

### Between

<div class="card">Second preview</div>

### After`)

    expect(tree.children.map((child) => child.type)).toEqual(['heading', 'code', 'heading', 'code', 'heading'])
    expect(tree.children[1]).toMatchObject({
      type: 'code',
      lang: 'html',
      value: '<div><strong>First preview</strong></div>'
    })
    expect(tree.children[3]).toMatchObject({
      type: 'code',
      lang: 'html',
      value: '<div class="card">Second preview</div>'
    })
  })

  it('converts an incomplete top-level HTML block while streaming', () => {
    const tree = parse('<div><span>Still generating')

    expect(tree.children[0]).toMatchObject({
      type: 'code',
      lang: 'html',
      value: '<div><span>Still generating'
    })
  })

  it('keeps a complete HTML document with blank lines in one code node', () => {
    const source = `<!doctype html>
<html>
<head>
  <title>Demo</title>

  <style>body { color: red; }</style>
</head>

<body>
  <h1>Hello</h1>
</body>
</html>`
    const tree = parse(source)

    expect(tree.children).toEqual([
      expect.objectContaining({
        type: 'code',
        lang: 'html',
        value: source
      })
    ])
  })

  it('keeps Markdown-shaped text inside a complete HTML document', () => {
    const source = `<!doctype html>
<html><body>

Hello

</body></html>`
    const tree = parse(source)

    expect(tree.children).toEqual([
      expect.objectContaining({
        type: 'code',
        lang: 'html',
        value: source
      })
    ])
  })

  it('keeps LaTeX delimiters inside HTML artifacts as source text', () => {
    const source = '<div>\\(html\\)</div>'
    const tree = parse(source, true)

    expect(tree.children).toEqual([
      expect.objectContaining({
        type: 'code',
        lang: 'html',
        value: source
      })
    ])
  })

  it('leaves an incomplete HTML document on the Markdown path', () => {
    const tree = parse(`<html><body>

Still generating`)

    expect(tree.children.some((child) => child.type === 'code')).toBe(false)
    expect(tree.children[0]).toMatchObject({ type: 'html', value: '<html><body>' })
  })

  it('leaves inline HTML inside Markdown paragraphs unchanged', () => {
    const tree = parse('Text with <span>inline HTML</span>.')

    expect(tree.children[0]).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'text' }, { type: 'html' }, { type: 'text' }, { type: 'html' }, { type: 'text' }]
    })
  })

  it('does not create a preview for comments or a standalone doctype', () => {
    const tree = parse('<!-- internal note -->\n\n<!doctype html>')

    expect(tree.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'html', value: '<!-- internal note -->' })])
    )
    expect(tree.children.every((child) => child.type === 'html')).toBe(true)
  })

  it('keeps SVG in the dedicated Markdown SVG renderer path', () => {
    const tree = parse('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" /></svg>')

    expect(tree.children).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'code' })]))
    expect(tree.children[0]).toMatchObject({
      type: 'paragraph',
      children: expect.arrayContaining([
        expect.objectContaining({ type: 'html', value: expect.stringContaining('<svg') })
      ])
    })
  })

  describe('classifyHtmlArtifactSource', () => {
    it.each([
      ['<div>Fragment</div>', 'fragment'],
      ['<section class="a b">Fragment</section>', 'fragment'],
      ['<!-- note --><section>Fragment</section>', 'fragment'],
      ['<html><body>Document</body></html>', 'document'],
      ['<html lang="en"><body>Document</body></html>', 'document'],
      ['<!doctype html><html><body>Document</body></html>', 'document'],
      ['<!-- note --><!DOCTYPE html><html><body>Document</body></html>', 'document']
    ])('classifies complete HTML source: %s', (source, expected) => {
      expect(classifyHtmlArtifactSource(source)).toBe(expected)
    })

    it.each([
      ['', 'empty fence'],
      ['<', 'bare angle bracket'],
      ['<!doc', 'partial doctype'],
      ['<htm', 'partial html tag'],
      ['<di', 'partial fragment tag'],
      ['<div class="unfinished', 'unterminated attribute list']
    ])('withholds a verdict while the source is unclassifiable (%s)', (source) => {
      expect(classifyHtmlArtifactSource(source)).toBeUndefined()
    })

    it('never flips its verdict once a streamed document becomes classifiable', () => {
      const full = '<!doctype html>\n<html>\n<body><h1>Hi</h1></body>\n</html>'
      const verdicts = Array.from({ length: full.length }, (_, index) =>
        classifyHtmlArtifactSource(full.slice(0, index + 1))
      ).filter((verdict) => verdict !== undefined)

      expect(verdicts.length).toBeGreaterThan(0)
      expect(new Set(verdicts)).toEqual(new Set(['document']))
    })

    it('never flips its verdict once a streamed fragment becomes classifiable', () => {
      const full = '<div class="card"><h1>Hi</h1></div>'
      const verdicts = Array.from({ length: full.length }, (_, index) =>
        classifyHtmlArtifactSource(full.slice(0, index + 1))
      ).filter((verdict) => verdict !== undefined)

      expect(verdicts.length).toBeGreaterThan(0)
      expect(new Set(verdicts)).toEqual(new Set(['fragment']))
    })
  })
})

describe('createTransformMarkdownOutsideHtmlArtifacts', () => {
  // A visible transform so misplaced range masking cannot pass by accident.
  const upper = (markdown: string) => markdown.toUpperCase()

  const expectMatchesOneShot = (parts: string[]) => {
    const cached = createTransformMarkdownOutsideHtmlArtifacts()
    const oneShot = (source: string) => createTransformMarkdownOutsideHtmlArtifacts()(source, upper)
    let settled = ''
    for (const part of parts) {
      for (let cut = 1; cut < 3; cut += 1) {
        const source = settled + part.slice(0, Math.ceil((part.length * cut) / 3))
        if (source === settled) continue
        expect(cached(source, upper)).toBe(oneShot(source))
      }
      settled += part
      expect(cached(settled, upper)).toBe(oneShot(settled))
    }
  }

  it('matches a one-shot parse on every append-only tick', () => {
    expectMatchesOneShot([
      'Intro prose with **bold**.\n\n',
      '<div class="fragment">live</div>\n\n',
      '```html\n<span>fenced</span>\n```\n\n',
      'Middle prose.\n\n',
      '<!doctype html>\n<html>\n<body>\n<p>One</p>\n</body>\n</html>\n\n',
      'After the document.\n\n',
      '<html>\n<body><p>Two</p></body>\n</html>\n\n',
      'Tail prose.\n\n'
    ])
  })

  it('matches one-shot while an HTML document streams open and then merges on close', () => {
    // Blank lines split the streaming document into separate raw-HTML nodes; the
    // closing </html> merges them all into one protected range — the cached path
    // must not have frozen anything inside the open document.
    expectMatchesOneShot([
      'Before.\n\n',
      '<html>\n<head><title>t</title></head>\n\n',
      '<body>\n<p>a</p>\n\n',
      '<p>b</p>\n</body>\n\n',
      '</html>\n\n',
      'After close.\n\n'
    ])
  })

  it('does not let a literal </html> inside fenced code close a streaming document', () => {
    // remark sees the fenced sample as code, not html — the document stays open
    // until its real closer arrives, and the merge must reach the real opener.
    expectMatchesOneShot([
      'Intro.\n\n',
      '<!doctype html>\n<html>\n<body>\n\n',
      '<p>a</p>\n\n',
      '<div>b</div>\n\n',
      '```\ncode with </html> inside\n```\n\n',
      'tail content\n\n',
      '</body>\n</html>\n',
      'After close.\n\n'
    ])
  })

  it('does not let a literal </html> in inline code close a streaming document', () => {
    expectMatchesOneShot([
      'Intro.\n\n',
      '<html>\n<body>\n\n',
      '<p>see `</html>` inline</p>\n\n',
      '<p>more prose</p>\n\n',
      '</body>\n</html>\n\n',
      'After.\n\n'
    ])
  })

  it('does not let a literal </html> in tilde fences or indented code close a streaming document', () => {
    expectMatchesOneShot([
      'Intro.\n\n',
      '<html>\n<body>\n\n',
      '<p>a</p>\n\n',
      '~~~\ncode with </html> inside\n~~~\n\n',
      '<p>between samples</p>\n\n',
      '    indented </html> sample\n\n',
      '<p>after samples</p>\n\n',
      '</body>\n</html>\n',
      'After close.\n\n'
    ])
  })

  it('self-heals after a non-append edit', () => {
    const cached = createTransformMarkdownOutsideHtmlArtifacts()
    cached('Intro.\n\n<div>frag</div>\n\nMore prose.\n\n', upper)

    const edited = 'REWRITTEN.\n\n<div>frag</div>\n\nMore prose.\n\n'
    expect(cached(edited, upper)).toBe(createTransformMarkdownOutsideHtmlArtifacts()(edited, upper))
  })
})
