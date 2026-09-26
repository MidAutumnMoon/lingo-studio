import { describe, expect, it } from 'vitest'

import { isMcpCallToolResult, mcpResultToTextSummary } from '../toolResultRendering'

describe('mcpResultToTextSummary', () => {
  it('returns JSON string for null / invalid shapes', () => {
    expect(mcpResultToTextSummary(null as never)).toBe('null')
    expect(mcpResultToTextSummary({} as never)).toBe('{}')
    expect(mcpResultToTextSummary({ content: 'not-an-array' } as never)).toContain('"not-an-array"')
  })

  it('joins text parts verbatim', () => {
    expect(
      mcpResultToTextSummary({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' }
        ]
      })
    ).toBe('hello\nworld')
  })

  it('turns media parts into placeholders instead of shipping their payload', () => {
    const out = mcpResultToTextSummary({
      content: [
        { type: 'image', data: 'cG5n', mimeType: 'image/png' },
        { type: 'audio', data: 'b2dn', mimeType: 'audio/ogg' }
      ]
    })
    expect(out).toBe('[Image: image/png, delivered to user]\n[Audio: audio/ogg, delivered to user]')
    expect(out).not.toContain('cG5n')
  })

  it('uses placeholder for blob resources, text for inline resources', () => {
    expect(
      mcpResultToTextSummary({
        content: [{ type: 'resource', resource: { uri: 'file://x.pdf', mimeType: 'application/pdf', blob: 'x' } }]
      })
    ).toBe('[Resource: application/pdf, uri=file://x.pdf, delivered to user]')
    expect(
      mcpResultToTextSummary({ content: [{ type: 'resource', resource: { uri: 'note://a', text: 'the body' } }] })
    ).toBe('the body')
  })

  it('mixes part types in declaration order', () => {
    expect(
      mcpResultToTextSummary({
        content: [
          { type: 'text', text: 'intro' },
          { type: 'image', data: 'x', mimeType: 'image/jpeg' },
          { type: 'text', text: 'outro' }
        ]
      })
    ).toBe('intro\n[Image: image/jpeg, delivered to user]\noutro')
  })

  it('defaults to JSON.stringify for unknown part types', () => {
    const out = mcpResultToTextSummary({ content: [{ type: 'future-kind', payload: 42 } as never] })
    expect(out).toContain('"future-kind"')
    expect(out).toContain('42')
  })
})

describe('isMcpCallToolResult', () => {
  it('accepts the protocol fields plus the tool-attached metadata sibling', () => {
    expect(
      isMcpCallToolResult({
        content: [{ type: 'text', text: 'hi' }],
        structuredContent: { ok: true },
        isError: false,
        metadata: { serverId: 's1' }
      })
    ).toBe(true)
    expect(isMcpCallToolResult({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe(true)
  })

  it('rejects anything the summary would not describe faithfully', () => {
    expect(isMcpCallToolResult(null)).toBe(false)
    expect(isMcpCallToolResult('text')).toBe(false)
    expect(isMcpCallToolResult([])).toBe(false)
    expect(isMcpCallToolResult({ content: [] })).toBe(false)
    expect(isMcpCallToolResult({ content: 'not-an-array' })).toBe(false)
    expect(isMcpCallToolResult({ content: [{ type: 'text', text: 'hi' }], extra: 1 })).toBe(false)
    expect(isMcpCallToolResult({ content: [{ type: 'future-kind' }] })).toBe(false)
    expect(isMcpCallToolResult({ content: [null] })).toBe(false)
  })
})
