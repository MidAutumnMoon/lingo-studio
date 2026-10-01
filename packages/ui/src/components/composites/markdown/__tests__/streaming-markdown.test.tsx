// @vitest-environment jsdom

/**
 * Smoke tests for `<StreamingMarkdown>`. Load-bearing behaviour: appended
 * content shows up without re-rendering settled blocks, and streaming markup
 * (alerts, tables) survives the parse-incomplete pipeline.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import type { ExtraProps } from 'streamdown'
import { describe, expect, it } from 'vitest'

import { useMarkdownBlockContext } from '../context'
import { StreamingMarkdown } from '../streaming-markdown'

describe('StreamingMarkdown', () => {
  it('renders appended content on rerender', () => {
    const { container, rerender } = render(<StreamingMarkdown id="s1">{'Hello'}</StreamingMarkdown>)
    expect(container.innerHTML.length).toBeGreaterThan(0)

    rerender(<StreamingMarkdown id="s1">{'Hello world'}</StreamingMarkdown>)
    expect(container.innerHTML.length).toBeGreaterThan(0)
    // The growth must contain the new word somewhere in the DOM.
    expect(container.textContent).toContain('world')
  })

  it('emits no animate spans unless `animated` is passed', () => {
    const { container } = render(<StreamingMarkdown id="s2">{'run `npm i` now'}</StreamingMarkdown>)
    expect(container.querySelectorAll('[data-sd-animate]').length).toBe(0)
  })

  it('emits animate spans while `animated` is on', () => {
    // Streamdown needs both `animated` and `isAnimating`; the component
    // derives both from one flag, and this is the regression guard for that.
    const { container } = render(
      <StreamingMarkdown id="s3" animated>
        {'run `npm i` now'}
      </StreamingMarkdown>
    )
    expect(container.querySelectorAll('[data-sd-animate]').length).toBeGreaterThan(0)
  })

  it('preserves GitHub alert markup while streaming', () => {
    const { container } = render(
      <StreamingMarkdown id="alert-stream">{'> [!NOTE]\n> Streaming alert'}</StreamingMarkdown>
    )

    const alert = container.querySelector('.markdown-alert-note')
    expect(alert).not.toBeNull()
    expect(alert?.querySelector('.markdown-alert-title')?.textContent).toContain('NOTE')
    expect(alert?.textContent).toContain('Streaming alert')
  })

  it('provides each streaming block source to custom renderers', async () => {
    const user = userEvent.setup()
    const copied: string[] = []
    const tableMarkdown = `| Name | Type |
| :--- | ---: |
| Project A | In progress |`
    const content = `Intro paragraph\n\n${tableMarkdown}`

    function CopyableTable({ node, ...props }: JSX.IntrinsicElements['table'] & ExtraProps) {
      const markdownContext = useMarkdownBlockContext()
      const position = node?.position
      const source = position
        ? markdownContext?.content
            .split('\n')
            .slice(position.start.line - 1, position.end.line)
            .join('\n')
            .trim()
        : ''

      return (
        <div>
          <table {...props} />
          <button type="button" onClick={() => copied.push(source ?? '')}>
            Copy table
          </button>
        </div>
      )
    }

    render(
      <StreamingMarkdown id="table-source" components={{ table: CopyableTable }}>
        {content}
      </StreamingMarkdown>
    )

    await user.click(screen.getByRole('button', { name: 'Copy table' }))
    expect(copied).toEqual([tableMarkdown])
  })

  it('reuses memoized blocks when content grows but plugin values are unchanged', () => {
    // Catches: new-but-equal remark/rehype/components identities on each
    // streaming tick forcing Streamdown to re-parse every settled block
    // (JSON.stringify cache key + rehype walk) and freeze the renderer.
    const rendered: string[] = []
    function CountingParagraph({ children }: JSX.IntrinsicElements['p'] & ExtraProps) {
      rendered.push(String(children))
      return <p>{children}</p>
    }
    const remarkNoop = () => {}
    const rehypeNoop = () => {}
    const first = 'First paragraph\n\nSecond paragraph'
    const { rerender } = render(
      <StreamingMarkdown
        id="stable-blocks"
        components={{ p: CountingParagraph }}
        remarkPlugins={[remarkNoop]}
        rehypePlugins={[rehypeNoop]}>
        {first}
      </StreamingMarkdown>
    )
    expect(rendered).toEqual(['First paragraph', 'Second paragraph'])
    rendered.length = 0
    rerender(
      <StreamingMarkdown
        id="stable-blocks"
        components={{ p: CountingParagraph }}
        remarkPlugins={[remarkNoop]}
        rehypePlugins={[rehypeNoop]}>
        {`${first}\n\nThird paragraph`}
      </StreamingMarkdown>
    )
    expect(rendered).toEqual(['Third paragraph'])
  })
})
