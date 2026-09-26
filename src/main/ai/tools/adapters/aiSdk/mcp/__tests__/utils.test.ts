import { describe, expect, it } from 'vitest'

import type { McpCallToolResponse } from '@main/ai/mcp/types'

import { hasMultimodalContent } from '../utils'

describe('hasMultimodalContent', () => {
  it('false for pure text', () => {
    expect(
      hasMultimodalContent({
        content: [{ type: 'text', text: 'hi' }]
      })
    ).toBe(false)
  })

  it('true when an image part exists', () => {
    expect(
      hasMultimodalContent({
        content: [{ type: 'image', data: 'x', mimeType: 'image/png' }]
      })
    ).toBe(true)
  })

  it('true when an audio part exists', () => {
    expect(
      hasMultimodalContent({
        content: [{ type: 'audio', data: 'x', mimeType: 'audio/wav' }]
      })
    ).toBe(true)
  })

  it('true only for blob-backed resources, not text-backed', () => {
    expect(
      hasMultimodalContent({
        content: [{ type: 'resource', resource: { uri: 'u', text: 'body' } }]
      })
    ).toBe(false)
    expect(
      hasMultimodalContent({
        content: [{ type: 'resource', resource: { uri: 'u', blob: 'b' } }]
      })
    ).toBe(true)
  })

  it('false for empty or malformed input', () => {
    expect(hasMultimodalContent({ content: [] })).toBe(false)
    expect(hasMultimodalContent(null as unknown as McpCallToolResponse)).toBe(false)
  })
})
