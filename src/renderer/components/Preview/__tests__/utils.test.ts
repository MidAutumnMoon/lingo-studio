import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderSvgInShadowHost } from '../utils'

describe('renderSvgInShadowHost', () => {
  let hostElement: HTMLElement

  beforeEach(() => {
    hostElement = document.createElement('div')
    document.body.appendChild(hostElement)
  })

  afterEach(() => {
    hostElement.remove()
  })

  it('renders into one shadow root and replaces the previous diagram', () => {
    renderSvgInShadowHost('<svg id="first" width="100" height="50"></svg>', hostElement)
    const shadowRoot = hostElement.shadowRoot!

    expect(shadowRoot.querySelector('style')).toBeInTheDocument()
    expect(shadowRoot.querySelector('#first')).toBeInTheDocument()

    renderSvgInShadowHost('<svg id="second"></svg>', hostElement)

    expect(hostElement.shadowRoot).toBe(shadowRoot)
    expect(shadowRoot.querySelector('#first')).not.toBeInTheDocument()
    expect(shadowRoot.querySelector('#second')).toBeInTheDocument()
  })

  it('sanitizes executable SVG content before rendering', () => {
    // Split into two renders: happy-dom + DOMPurify drop every sibling after a
    // removed <script>, so each contract gets its own document.
    renderSvgInShadowHost('<svg><rect width="10" height="10" onload="alert(1)" /></svg>', hostElement)

    expect(hostElement.shadowRoot?.querySelector('rect')).toBeInTheDocument()
    expect(hostElement.shadowRoot?.querySelector('rect')).not.toHaveAttribute('onload')

    renderSvgInShadowHost('<svg><script>alert(1)</script></svg>', hostElement)

    expect(hostElement.shadowRoot?.querySelector('script')).not.toBeInTheDocument()
  })

  it('accepts malformed SVG that the browser can safely repair', () => {
    renderSvgInShadowHost('<svg><rect></svg>', hostElement)

    expect(hostElement.shadowRoot?.querySelector('svg')).toHaveAttribute('xmlns', 'http://www.w3.org/2000/svg')
    expect(hostElement.shadowRoot?.querySelector('rect')).toBeInTheDocument()
  })

  it('rejects content without an SVG document', () => {
    expect(() => renderSvgInShadowHost('<div>not an image</div>', hostElement)).toThrow(
      'Invalid SVG content: The provided string does not contain a valid SVG element.'
    )
  })
})
