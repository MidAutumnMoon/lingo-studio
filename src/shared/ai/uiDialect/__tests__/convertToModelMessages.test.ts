import { convertToModelMessages as aiConvertToModelMessages } from 'ai'
import { describe, expect, it } from 'vitest'

import { convertToModelMessages, type UIMessage } from '../index'

/**
 * Contract: the vendored converter produces the same ModelMessage[] as the `ai` package's on the
 * same UIMessage inputs — including the failure modes (Phase-2 D3 wire-format freeze).
 */

async function expectConversionEqual(messages: UIMessage[], options?: Parameters<typeof convertToModelMessages>[1]) {
  const [ours, theirs] = await Promise.all([
    convertToModelMessages(messages as any, options as any),
    aiConvertToModelMessages(messages as any, options as any)
  ])
  expect(ours).toEqual(theirs)
  return ours
}

const assistant = (parts: UIMessage['parts']): UIMessage => ({ id: 'a1', role: 'assistant', parts })

describe('convertToModelMessages — vendored parity with ai@6.0.185', () => {
  it('converts system and user messages (text + file parts, providerOptions merge)', async () => {
    const ours = await expectConversionEqual([
      {
        id: 's',
        role: 'system',
        parts: [
          { type: 'text', text: 'You are ', providerMetadata: { openai: { a: 1 } } },
          { type: 'text', text: 'helpful.', providerMetadata: { anthropic: { b: 2 } } }
        ]
      },
      {
        id: 'u',
        role: 'user',
        parts: [
          { type: 'text', text: 'look at this', providerMetadata: { openai: { c: 3 } } },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAA' }
        ]
      }
    ])
    expect(ours).toEqual([
      { role: 'system', content: 'You are helpful.', providerOptions: { openai: { a: 1 }, anthropic: { b: 2 } } },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this', providerOptions: { openai: { c: 3 } } },
          { type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,AAA' }
        ]
      }
    ])
  })

  it('converts an assistant turn with text, reasoning, and completed static tool calls', async () => {
    const ours = await expectConversionEqual([
      assistant([
        { type: 'step-start' },
        { type: 'reasoning', text: 'hm', providerMetadata: { anthropic: { r: 1 } } },
        { type: 'text', text: 'Let me search.' },
        {
          type: 'tool-web_search',
          toolCallId: 'c1',
          state: 'output-available',
          input: { query: 'cats' },
          output: { hits: 2 },
          callProviderMetadata: { openai: { call: 1 } },
          resultProviderMetadata: { openai: { result: 1 } }
        },
        {
          type: 'tool-fs_read',
          toolCallId: 'c2',
          state: 'output-available',
          input: { path: '/x' },
          output: 'file body'
        }
      ])
    ])
    expect(ours).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hm', providerOptions: { anthropic: { r: 1 } } },
          { type: 'text', text: 'Let me search.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'web_search',
            input: { query: 'cats' },
            providerOptions: { openai: { call: 1 } }
          },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'fs_read', input: { path: '/x' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'web_search',
            output: { type: 'json', value: { hits: 2 } },
            providerOptions: { openai: { call: 1 } }
          },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'fs_read', output: { type: 'text', value: 'file body' } }
        ]
      }
    ])
  })

  it('converts dynamic tool calls', async () => {
    await expectConversionEqual([
      assistant([
        {
          type: 'dynamic-tool',
          toolCallId: 'd1',
          toolName: 'custom_tool',
          state: 'output-available',
          input: { a: 1 },
          output: [1, 2]
        }
      ])
    ])
  })

  it('maps tool errors: output-error becomes error-json output in the tool-call input and error-text in the tool result', async () => {
    const ours = await expectConversionEqual([
      assistant([
        {
          type: 'tool-broken',
          toolCallId: 'c3',
          state: 'output-error',
          input: undefined,
          rawInput: { raw: true },
          errorText: 'it failed'
        }
      ])
    ])
    expect(ours).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'broken', input: { raw: true } }]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c3',
            toolName: 'broken',
            output: { type: 'error-text', value: 'it failed' }
          }
        ]
      }
    ])
  })

  it('maps approval flows: requested, responded, denied', async () => {
    const ours = await expectConversionEqual([
      assistant([
        {
          type: 'tool-fs_write',
          toolCallId: 'c4',
          state: 'output-denied',
          input: { path: '/etc' },
          approval: { id: 'ap1', approved: false, reason: 'not allowed' }
        },
        {
          type: 'tool-fs_write',
          toolCallId: 'c5',
          state: 'output-available',
          input: { path: '/tmp' },
          output: 'written',
          approval: { id: 'ap2', approved: true }
        }
      ])
    ])
    expect(ours).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c4', toolName: 'fs_write', input: { path: '/etc' } },
          { type: 'tool-approval-request', approvalId: 'ap1', toolCallId: 'c4' },
          { type: 'tool-call', toolCallId: 'c5', toolName: 'fs_write', input: { path: '/tmp' } },
          { type: 'tool-approval-request', approvalId: 'ap2', toolCallId: 'c5' }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'ap1',
            approved: false,
            reason: 'not allowed'
          },
          {
            type: 'tool-result',
            toolCallId: 'c4',
            toolName: 'fs_write',
            output: { type: 'error-text', value: 'not allowed' }
          },
          { type: 'tool-approval-response', approvalId: 'ap2', approved: true },
          { type: 'tool-result', toolCallId: 'c5', toolName: 'fs_write', output: { type: 'text', value: 'written' } }
        ]
      }
    ])
  })

  it('maps provider-executed tool calls to in-assistant tool results', async () => {
    const ours = await expectConversionEqual([
      assistant([
        {
          type: 'tool-web_search',
          toolCallId: 'c6',
          state: 'output-available',
          input: { q: 'x' },
          output: { ok: true },
          providerExecuted: true,
          callProviderMetadata: { openai: { call: 1 } },
          resultProviderMetadata: { openai: { result: 1 } }
        }
      ])
    ])
    expect(ours).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c6',
            toolName: 'web_search',
            input: { q: 'x' },
            providerExecuted: true,
            providerOptions: { openai: { call: 1 } }
          },
          {
            type: 'tool-result',
            toolCallId: 'c6',
            toolName: 'web_search',
            output: { type: 'json', value: { ok: true } },
            providerOptions: { openai: { result: 1 } }
          }
        ]
      }
    ])
  })

  it('drops incomplete tool calls when ignoreIncompleteToolCalls is set', async () => {
    const messages = [
      assistant([
        {
          type: 'tool-web_search',
          toolCallId: 'c7',
          state: 'input-available',
          input: { q: 'x' }
        },
        { type: 'text', text: 'partial turn' }
      ])
    ]
    const ours = await expectConversionEqual(messages, { ignoreIncompleteToolCalls: true })
    expect(ours).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'partial turn' }] }])
  })

  it('runs tools.toModelOutput for tool results when provided', async () => {
    const tools = {
      web_search: {
        toModelOutput: async ({ output }: { output: unknown }) => ({ type: 'json', value: { wrapped: output } })
      }
    } as any
    const messages = [
      assistant([
        {
          type: 'tool-web_search',
          toolCallId: 'c8',
          state: 'output-available',
          input: { q: 'x' },
          output: { raw: 1 }
        }
      ])
    ]
    const ours = await expectConversionEqual(messages, { tools })
    expect(ours[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c8',
          toolName: 'web_search',
          output: { type: 'json', value: { wrapped: { raw: 1 } } }
        }
      ]
    })
  })

  it('converts data parts only through convertDataPart', async () => {
    const messages = [
      { id: 'u', role: 'user', parts: [{ type: 'data-progress', id: 'p', data: { pct: 1 } }] } as unknown as UIMessage
    ]

    const without = await expectConversionEqual(messages)
    expect(without).toEqual([{ role: 'user', content: [] }])

    const withConverter = await expectConversionEqual(messages, {
      convertDataPart: (part: any) => ({ type: 'text', text: `progress ${part.data.pct}` })
    })
    expect(withConverter).toEqual([{ role: 'user', content: [{ type: 'text', text: 'progress 1' }] }])
  })

  it('throws MessageConversionError for unsupported roles, with the same message as the ai package', async () => {
    const bad = { id: 'x', role: 'tool', parts: [] } as unknown as UIMessage

    await expect(convertToModelMessages([bad] as any)).rejects.toThrow('Unsupported role: tool')
    await expect(aiConvertToModelMessages([bad] as any)).rejects.toThrow('Unsupported role: tool')
  })
})
