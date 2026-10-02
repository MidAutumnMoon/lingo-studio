import { describe, expect, it } from 'vitest'

import type { CherryMessagePart, CherryUIMessage, CherryUIMessageMetadata } from '@shared/data/types/message'

import { HISTORY_MODEL_PLACEHOLDER, toPiSessionEntries, type PiHistoryModelDescriptor } from './historyConverter'

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8='

function msg(
  role: CherryUIMessage['role'],
  parts: CherryMessagePart[],
  metadata?: CherryUIMessageMetadata,
  id = role === 'user' ? 'u1' : role === 'assistant' ? 'a1' : 's1'
): CherryUIMessage {
  return {
    id,
    role,
    parts,
    ...(metadata !== undefined ? { metadata } : {})
  }
}

const createdAt = (iso: string): CherryUIMessageMetadata => ({ createdAt: iso })

/** Terminal-state tool part fixture. */
function toolPart(overrides: Record<string, unknown> = {}): CherryMessagePart {
  return {
    type: 'tool-web_search',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { query: 'cherry studio' },
    output: { results: [{ title: 'Cherry', url: 'https://example.com' }] },
    ...overrides
  }
}

function assistantEntry(entries: ReturnType<typeof toPiSessionEntries>, index = 0) {
  const entry = entries[index]
  if (entry.message.role !== 'assistant') throw new Error(`expected assistant entry, got ${entry.message.role}`)
  return entry.message
}

describe('part corpus', () => {
  it('maps content parts: text, reasoning, inline image', () => {
    const entries = toPiSessionEntries([
      msg('user', [
        { type: 'text', text: 'hi' },
        { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL }
      ]),
      msg(
        'assistant',
        [
          { type: 'reasoning', text: 'thinking...', state: 'done' },
          { type: 'text', text: 'answer' }
        ],
        createdAt('2026-09-26T10:00:00.000Z')
      )
    ])

    expect(entries[0].message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
      ],
      timestamp: 0
    })
    expect(assistantEntry(entries, 1)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thinking...' },
        { type: 'text', text: 'answer' }
      ],
      api: HISTORY_MODEL_PLACEHOLDER.api,
      provider: HISTORY_MODEL_PLACEHOLDER.provider,
      model: HISTORY_MODEL_PLACEHOLDER.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.parse('2026-09-26T10:00:00.000Z')
    })
  })

  it('drops every hidden/control/UI-only part type', () => {
    const dropped: CherryMessagePart[] = [
      { type: 'step-start' },
      { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
      { type: 'source-document', sourceId: 's2', mediaType: 'application/pdf', title: 'doc' },
      { type: 'data-error', data: { message: 'boom' } },
      { type: 'data-translation', data: { content: 'hola', targetLanguage: 'es' } },
      { type: 'data-code', data: { content: 'x = 1', language: 'python' } },
      { type: 'data-compact', data: { content: 'c', compactedContent: 'cc' } },
      { type: 'data-compaction-anchor', data: { status: 'done', phase: 'turn-start' } },
      { type: 'data-video', data: { url: 'https://example.com/v.mp4' } },
      { type: 'data-agent-task-event', data: { event: 'started', taskId: 't1' } },
      { type: 'data-agent-session-fork', data: { sourceSessionId: 's' } },
      { type: 'data-knowledge-scope', data: { baseIds: ['kb1'] } },
      { type: 'data-clear', data: {} },
      { type: 'data-conversation-reset', data: {} }
    ]
    const entries = toPiSessionEntries([
      msg('user', [{ type: 'text', text: 'real' }, ...dropped]),
      msg('assistant', [{ type: 'text', text: 'ok' }, ...dropped])
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0].message).toEqual({ role: 'user', content: 'real', timestamp: 0 })
    expect(assistantEntry(entries, 1).content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('degrades non-inline and non-image files to text notes (lossy by design)', () => {
    const entries = toPiSessionEntries([
      msg('user', [
        { type: 'file', mediaType: 'image/png', url: 'https://cdn.example.com/pic.png', filename: 'pic.png' },
        { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,eA==', filename: 'doc.pdf' },
        { type: 'file', mediaType: 'audio/ogg', url: 'data:audio/ogg;base64,eA==' }
      ])
    ])

    expect(entries[0].message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[attachment: image pic.png]' },
        { type: 'text', text: '[attachment: doc.pdf (application/pdf)]' },
        { type: 'text', text: '[attachment: file (audio/ogg)]' }
      ],
      timestamp: 0
    })
  })

  it('replaces media the model cannot accept with the shared strip pass', () => {
    const entries = toPiSessionEntries(
      [msg('user', [{ type: 'file', mediaType: 'audio/ogg', url: 'data:audio/ogg;base64,eA==' }])],
      { mediaCapabilities: { image: true, video: false, audio: false } }
    )
    expect(entries[0].message).toEqual({
      role: 'user',
      content: '[audio attachment omitted: this model does not accept audio input]',
      timestamp: 0
    })
  })
})

describe('golden conversation', () => {
  it('converts a realistic topic into a linked entry chain', () => {
    const entries = toPiSessionEntries(
      [
        msg('system', [{ type: 'text', text: 'You are helpful.' }], createdAt('2026-09-26T09:00:00.000Z'), 'sys'),
        msg('user', [{ type: 'text', text: 'Search and summarize' }], createdAt('2026-09-26T09:00:01.000Z'), 'u1'),
        msg(
          'assistant',
          [
            { type: 'reasoning', text: 'plan', state: 'done' },
            toolPart(),
            { type: 'text', text: 'Summary: Cherry is a studio.' }
          ],
          { ...createdAt('2026-09-26T09:00:05.000Z'), stats: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
          'a1'
        ),
        msg('user', [{ type: 'text', text: 'thanks' }], createdAt('2026-09-26T09:01:00.000Z'), 'u2'),
        msg('assistant', [{ type: 'text', text: 'welcome' }], createdAt('2026-09-26T09:01:02.000Z'), 'a2')
      ],
      {
        resolveHistoryModel: () => ({ api: 'anthropic-messages', provider: 'cherry-anthropic', model: 'claude-x' })
      }
    )

    expect(entries).toHaveLength(7) // system, u1, a1 step 1 (+ tool result), a1 step 2, u2, a2

    // Chain integrity: linear, first parent null, unique ids.
    expect(entries[0].parentId).toBeNull()
    for (let i = 1; i < entries.length; i++) expect(entries[i].parentId).toBe(entries[i - 1].id)
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
    expect(entries.map((e) => e.id)).toEqual(['sys', 'u1', 'a1', 'a1#t0', 'a1#s1', 'u2', 'a2'])
    expect(entries.every((e) => e.type === 'message')).toBe(true)

    // The tool step and the post-tool continuation split into two assistant entries — the
    // boundaries legacy infers (restoreLegacyToolStepBoundaries) and pi writes natively.
    const assistant = assistantEntry(entries, 2)
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'plan' },
      { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'cherry studio' } }
    ])
    expect(assistant.api).toBe('anthropic-messages')
    expect(assistant.stopReason).toBe('toolUse')
    // The message's stats ride the LAST entry only — per-step copies stay zero.
    expect(assistant.usage.input).toBe(0)

    const toolResult = entries[3].message
    expect(toolResult).toEqual({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'web_search',
      content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Cherry', url: 'https://example.com' }] }) }],
      details: { results: [{ title: 'Cherry', url: 'https://example.com' }] },
      isError: false,
      timestamp: Date.parse('2026-09-26T09:00:05.000Z')
    })

    const continuation = assistantEntry(entries, 4)
    expect(continuation.content).toEqual([{ type: 'text', text: 'Summary: Cherry is a studio.' }])
    expect(continuation.stopReason).toBe('stop')
    expect(continuation.usage.input).toBe(100)
    expect(continuation.usage.totalTokens).toBe(150)
  })
})

describe('step boundaries', () => {
  it('splits a pi-written multi-step message at its step-start markers', () => {
    const entries = toPiSessionEntries([
      msg(
        'assistant',
        [
          { type: 'step-start' },
          { type: 'text', text: 'searching' },
          toolPart(),
          { type: 'step-start' },
          { type: 'text', text: 'found it' }
        ],
        createdAt('2026-09-26T09:00:05.000Z'),
        'a1'
      )
    ])

    expect(entries.map((e) => e.id)).toEqual(['a1', 'a1#t0', 'a1#s1'])
    expect(assistantEntry(entries, 0).content).toEqual([
      { type: 'text', text: 'searching' },
      { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'cherry studio' } }
    ])
    expect(assistantEntry(entries, 0).stopReason).toBe('toolUse')
    expect(assistantEntry(entries, 2).content).toEqual([{ type: 'text', text: 'found it' }])
    expect(assistantEntry(entries, 2).stopReason).toBe('stop')
  })

  it('drops a trailing empty step (a marker with nothing after it)', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [{ type: 'step-start' }, { type: 'text', text: 'only step' }, { type: 'step-start' }])
    ])
    expect(entries).toHaveLength(1)
  })

  it('keeps a tool-only message as one step even without markers', () => {
    // No continuation after the tool group ⇒ no inferable boundary ⇒ one entry.
    const entries = toPiSessionEntries([msg('assistant', [{ type: 'text', text: 'go' }, toolPart()])])
    expect(entries.map((e) => e.id)).toEqual(['a1', 'a1#t0'])
    expect(assistantEntry(entries, 0).stopReason).toBe('toolUse')
  })
})

describe('user thinking suffix (W5)', () => {
  it('suffixes every replayed user text part for the qwen scope', () => {
    const entries = toPiSessionEntries(
      [
        msg(
          'user',
          [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'already /no_think' }
          ],
          undefined,
          'u1'
        ),
        msg('assistant', [{ type: 'text', text: 'answer' }], undefined, 'a1'),
        msg('user', [{ type: 'text', text: 'second' }], undefined, 'u2')
      ],
      { userTextSuffix: { text: ' /think', scope: 'every-text-part' } }
    )
    const u1 = entries[0].message as { role: string; content: Array<{ type: string; text?: string }> }
    expect(u1.content).toEqual([
      { type: 'text', text: 'first /think' },
      { type: 'text', text: 'already /no_think' }
    ])
    const u2 = entries[2].message as { role: string; content: unknown }
    // Single-text messages collapse to a string — suffixed before the collapse.
    expect(u2.content).toBe('second /think')
  })

  it('suffixes only a text FINAL block for the ovms scope', () => {
    const image = { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aGk=' } as CherryMessagePart
    const entries = toPiSessionEntries([msg('user', [{ type: 'text', text: 'look' }, image], undefined, 'u1')], {
      userTextSuffix: { text: ' /no_think', scope: 'final-text-block' }
    })
    const u1 = entries[0].message as { role: string; content: Array<{ type: string; text?: string }> }
    // Final block is an image — legacy appends nothing rather than the text part.
    expect(u1.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' }
    ])

    const trailing = toPiSessionEntries([msg('user', [image, { type: 'text', text: 'describe' }], undefined, 'u2')], {
      userTextSuffix: { text: ' /no_think', scope: 'final-text-block' }
    })
    const u2 = trailing[0].message as { role: string; content: Array<{ type: string; text?: string }> }
    expect((u2.content.at(-1) as { text?: string }).text).toBe('describe /no_think')
  })

  it('leaves assistant and system messages unsuffixed', () => {
    const entries = toPiSessionEntries([msg('assistant', [{ type: 'text', text: 'answer' }], undefined, 'a1')], {
      userTextSuffix: { text: ' /think', scope: 'every-text-part' }
    })
    expect((entries[0].message as { content: unknown }).content).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('tool replay', () => {
  it('renders a declared builtin output through its model view, and keeps JSON when undeclared', () => {
    const readFileOutput = { text: 'page one', totalChars: 900, nextOffset: 2 }
    const declared = toPiSessionEntries(
      [msg('assistant', [toolPart({ type: 'dynamic-tool', toolName: 'read_file', output: readFileOutput })])],
      { declaredToolNames: new Set(['read_file']) }
    )
    const declaredResult = declared[1].message as { content: Array<{ type: string; text: string }> }
    expect(declaredResult.content[0].text).toBe(
      'page one\n\n[Showing 8 of 900 chars. Call read_file again with offset=2 for more.]'
    )

    const undeclared = toPiSessionEntries([
      msg('assistant', [toolPart({ type: 'dynamic-tool', toolName: 'read_file', output: readFileOutput })])
    ])
    const undeclaredResult = undeclared[1].message as { content: Array<{ type: string; text: string }> }
    expect(undeclaredResult.content[0].text).toBe(JSON.stringify(readFileOutput))
  })

  it('renders a declared web_search output as its JSON view and an fs_read page with its tail', () => {
    const results = [{ id: 'cite_ab_0', title: 'Cherry', url: 'https://example.com', content: 'hi' }]
    const web = toPiSessionEntries(
      [msg('assistant', [toolPart({ type: 'dynamic-tool', toolName: 'web_search', output: results })])],
      { declaredToolNames: new Set(['web_search']) }
    )
    const webResult = (web[1].message as { content: Array<{ text: string }> }).content[0]
    expect(webResult.text).toBe(JSON.stringify(results))

    const page = { kind: 'text', text: 'lines here', startLine: 1, endLine: 2, totalLines: 5 }
    const fs = toPiSessionEntries(
      [msg('assistant', [toolPart({ type: 'dynamic-tool', toolName: 'fs_read', output: page })])],
      { declaredToolNames: new Set(['fs_read']) }
    )
    const fsResult = (fs[1].message as { content: Array<{ text: string }> }).content[0]
    expect(fsResult.text).toBe('lines here\n\n[showing lines 1-2 of 5; 3 more — call again with offset=3 to continue]')
  })

  it('replays a legacy tool_invoke part as the inner tool it dispatched', () => {
    const results = [{ id: 'cite_ab_0', title: 'Cherry', url: 'https://example.com', content: 'hi' }]
    const entries = toPiSessionEntries(
      [
        msg('assistant', [
          toolPart({
            type: 'dynamic-tool',
            toolName: 'tool_invoke',
            input: { name: 'web_search', params: { query: 'cherry' } },
            output: results
          })
        ])
      ],
      { declaredToolNames: new Set(['web_search']) }
    )

    const assistant = assistantEntry(entries)
    expect(assistant.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'cherry' } }
    ])
    const result = entries[1].message as {
      toolName: string
      content: Array<{ type: string; text: string }>
    }
    expect(result.toolName).toBe('web_search')
    expect(result.content[0].text).toBe(JSON.stringify(results))
  })

  it('drops a tool_invoke part whose inner name is missing', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [toolPart({ type: 'dynamic-tool', toolName: 'tool_invoke', input: { params: {} } })])
    ])
    expect(entries).toHaveLength(0)
  })

  it('keeps string outputs as plain text', () => {
    const entries = toPiSessionEntries([msg('assistant', [toolPart({ output: 'plain result' })])])
    const result = entries[1].message
    expect(result).toMatchObject({
      role: 'toolResult',
      isError: false,
      content: [{ type: 'text', text: 'plain result' }]
    })
    expect('details' in result).toBe(false)
  })

  it('maps error and denied outcomes to isError results', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [
        toolPart({ toolCallId: 'e1', state: 'output-error', input: undefined, errorText: 'provider 500' }),
        toolPart({
          toolCallId: 'd1',
          state: 'output-denied',
          approval: { id: 'ap1', approved: false, reason: 'risky' }
        })
      ])
    ])
    expect(entries[1].message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'e1',
      isError: true,
      content: [{ type: 'text', text: 'provider 500' }]
    })
    expect(entries[2].message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'd1',
      isError: true,
      content: [{ type: 'text', text: '[tool call denied by the user: risky]' }]
    })
    // Error/denied calls still replay as calls with object arguments.
    expect(assistantEntry(entries).content).toEqual(
      expect.arrayContaining([
        { type: 'toolCall', id: 'e1', name: 'web_search', arguments: {} },
        { type: 'toolCall', id: 'd1', name: 'web_search', arguments: { query: 'cherry studio' } }
      ])
    )
  })

  it.each(['input-streaming', 'input-available', 'undefined-input', 'approval-responded'] as const)(
    'drops a dangling call in state %s together with its would-be result',
    (state) => {
      const part = toolPart({ state, ...(state === 'input-streaming' ? { input: undefined } : {}) })
      delete (part as Partial<Record<string, unknown>>).output
      const entries = toPiSessionEntries([msg('assistant', [{ type: 'text', text: 'partial' }, part])])
      expect(entries).toHaveLength(1)
      expect(assistantEntry(entries).content).toEqual([{ type: 'text', text: 'partial' }])
    }
  )

  it('drops approval-requested parts (abandoned approval cards)', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [toolPart({ state: 'approval-requested', approval: { id: 'ap1' } })])
    ])
    expect(entries).toHaveLength(0)
  })

  it('sanitizes wire-illegal tool names with the shared digest scheme', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [
        toolPart({ toolCallId: 'c1' }),
        {
          type: 'dynamic-tool',
          toolCallId: 'c2',
          state: 'output-available',
          toolName: 'weather.get_forecast',
          input: {},
          output: 'ok'
        },
        { type: 'tool-my tool', toolCallId: 'c3', state: 'output-available', input: {}, output: 'ok' }
      ] as CherryMessagePart[])
    ])
    const calls = assistantEntry(entries).content.filter((block) => block.type === 'toolCall')
    expect(calls.map((call) => call.name)).toEqual(['web_search', 'weather_get_forecast_62b9a3d1', 'my_tool_af998d1f'])
    // The sanitized name is shared by call and result so pairing survives name-based providers.
    const results = entries.slice(1).map((e) => e.message)
    expect(results.map((r) => r.role === 'toolResult' && r.toolName)).toEqual([
      'web_search',
      'weather_get_forecast_62b9a3d1',
      'my_tool_af998d1f'
    ])
  })

  it('replays declared tool names verbatim even when wire-illegal', () => {
    const entries = toPiSessionEntries(
      [
        msg('assistant', [
          {
            type: 'dynamic-tool',
            toolCallId: 'c1',
            state: 'output-available',
            toolName: 'weather.get_forecast',
            input: {},
            output: 'ok'
          }
        ])
      ],
      { declaredToolNames: new Set(['weather.get_forecast']) }
    )
    expect(assistantEntry(entries).content).toEqual([
      { type: 'toolCall', id: 'c1', name: 'weather.get_forecast', arguments: {} }
    ])
  })

  it('renders an MCP call result through the tool summary, never the raw payload', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [
        toolPart({
          type: 'dynamic-tool',
          toolName: 'mcp__browser__screenshot_0f1e2d3c',
          output: {
            content: [
              { type: 'image', data: 'cG5nLWJ5dGVz', mimeType: 'image/png' },
              { type: 'text', text: 'viewport 1280x800' }
            ],
            structuredContent: { viewport: '1280x800' }
          }
        })
      ])
    ])
    const result = entries[1].message
    expect(result).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: '[Image: image/png, delivered to user]\nviewport 1280x800' }],
      // The live pi MCP path keeps structured content in the sidecar, never the media payload.
      details: { viewport: '1280x800' }
    })
    expect(JSON.stringify(result)).not.toContain('cG5nLWJ5dGVz')
  })

  it('keeps JSON text for object outputs that are not MCP results', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [toolPart({ output: { content: [{ type: 'text', text: 'x' }], extra: 1 } })])
    ])
    expect(entries[1].message).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: '{"content":[{"type":"text","text":"x"}],"extra":1}' }],
      details: { content: [{ type: 'text', text: 'x' }], extra: 1 }
    })
  })

  it('keeps a non-object persisted input under `input`, an absent one as no argument', () => {
    const stringInput = toPiSessionEntries([msg('assistant', [toolPart({ input: 'raw query' })])])
    expect(assistantEntry(stringInput).content).toStrictEqual([
      { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { input: 'raw query' } }
    ])
    const noInput = toPiSessionEntries([msg('assistant', [toolPart({ input: undefined })])])
    expect(assistantEntry(noInput).content).toStrictEqual([
      { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: {} }
    ])
  })
})

describe('model identity and usage', () => {
  /** 1000 prompt tokens = 200 uncached + 500 read + 300 written, as `MessageStats` records them. */
  const stats = {
    inputTokens: 1000,
    outputTokens: 20,
    totalTokens: 1020,
    inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 300 },
    outputTokenDetails: { reasoningTokens: 8 }
  }

  it('replays a persisted provider signature only for the mapped api family', () => {
    const reasoning: CherryMessagePart = {
      type: 'reasoning',
      text: 'plan',
      state: 'done',
      providerMetadata: { anthropic: { signature: 'sig-abc' } }
    }
    const asAnthropic = toPiSessionEntries([msg('assistant', [reasoning])], {
      resolveHistoryModel: () => ({ api: 'anthropic-messages', provider: 'cherry-p', model: 'm1' })
    })
    expect(assistantEntry(asAnthropic).content).toEqual([
      { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-abc' }
    ])

    // Placeholder and other api families: pi degrades the unsigned block itself, so an
    // anthropic signature must not travel with a non-anthropic replay.
    for (const descriptor of [undefined, { api: 'openai-responses', provider: 'cherry-p', model: 'm1' } as const]) {
      const entries = toPiSessionEntries([msg('assistant', [reasoning])], {
        ...(descriptor && { resolveHistoryModel: () => descriptor })
      })
      expect(assistantEntry(entries).content).toEqual([{ type: 'thinking', thinking: 'plan' }])
    }
  })

  it('replays google thought signatures on reasoning, text, and tool-call parts', () => {
    const google: PiHistoryModelDescriptor = { api: 'google-generative-ai', provider: 'cherry-p', model: 'm1' }
    const entries = toPiSessionEntries(
      [
        msg('assistant', [
          {
            type: 'reasoning',
            text: 'plan',
            state: 'done',
            providerMetadata: { google: { thoughtSignature: 'sig-r' } }
          },
          { type: 'text', text: 'answer', providerMetadata: { google: { thoughtSignature: 'sig-t' } } },
          // Tool parts never carry plain `providerMetadata` — the accumulator files chunk
          // stamps under `callProviderMetadata` (input) / `resultProviderMetadata` (terminal).
          toolPart({ callProviderMetadata: { google: { thoughtSignature: 'sig-c' } } })
        ])
      ],
      { resolveHistoryModel: () => google }
    )

    expect(assistantEntry(entries).content).toEqual([
      { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-r' },
      { type: 'text', text: 'answer', textSignature: 'sig-t' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'web_search',
        arguments: { query: 'cherry studio' },
        thoughtSignature: 'sig-c'
      }
    ])
  })

  it('keeps a google text part that carries only a thought signature', () => {
    // Gemini can sign a part whose visible text is empty; pi keeps such parts, so
    // dropping one would break the replayed reasoning chain.
    const google: PiHistoryModelDescriptor = { api: 'google-generative-ai', provider: 'cherry-p', model: 'm1' }
    const entries = toPiSessionEntries(
      [msg('assistant', [{ type: 'text', text: '', providerMetadata: { google: { thoughtSignature: 'sig-only' } } }])],
      { resolveHistoryModel: () => google }
    )
    expect(assistantEntry(entries).content).toEqual([{ type: 'text', text: '', textSignature: 'sig-only' }])
  })

  it('reconstructs the openai-responses reasoning item from the persisted itemId blob', () => {
    const responses: PiHistoryModelDescriptor = { api: 'openai-responses', provider: 'cherry-p', model: 'm1' }
    const entries = toPiSessionEntries(
      [
        msg('assistant', [
          {
            type: 'reasoning',
            text: 'summary text',
            state: 'done',
            providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-blob' } }
          }
        ])
      ],
      { resolveHistoryModel: () => responses }
    )

    // pi stores the API's own output item as the block signature and replays it verbatim.
    expect(assistantEntry(entries).content).toEqual([
      {
        type: 'thinking',
        thinking: 'summary text',
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'summary text' }],
          encrypted_content: 'enc-blob'
        })
      }
    ])

    // Without encrypted content the item still replays with its summary (legacy parity).
    const unencrypted = toPiSessionEntries(
      [
        msg('assistant', [
          { type: 'reasoning', text: 'bare', state: 'done', providerMetadata: { openai: { itemId: 'rs_2' } } }
        ])
      ],
      { resolveHistoryModel: () => responses }
    )
    expect(assistantEntry(unencrypted).content).toEqual([
      {
        type: 'thinking',
        thinking: 'bare',
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_2',
          summary: [{ type: 'summary_text', text: 'bare' }]
        })
      }
    ])
  })

  it('replays pi-written signatures from the pi namespace for any mapped family', () => {
    // pi-engine turns persist pi's opaque replay strings; the descriptor family matches
    // by the same-model gate, so the value replays without family translation.
    for (const api of ['anthropic-messages', 'google-generative-ai', 'openai-responses'] as const) {
      const entries = toPiSessionEntries(
        [
          msg('assistant', [
            { type: 'reasoning', text: 'p', state: 'done', providerMetadata: { pi: { thinkingSignature: 'pi-sig' } } },
            { type: 'text', text: 'a', providerMetadata: { pi: { textSignature: 'pi-text' } } }
          ])
        ],
        { resolveHistoryModel: () => ({ api, provider: 'cherry-p', model: 'm1' }) }
      )
      expect(assistantEntry(entries).content).toEqual([
        { type: 'thinking', thinking: 'p', thinkingSignature: 'pi-sig' },
        { type: 'text', text: 'a', textSignature: 'pi-text' }
      ])
    }

    const signedTool = toPiSessionEntries(
      [
        msg('assistant', [
          toolPart({ callProviderMetadata: { pi: { thoughtSignature: 'pi-tool' } } }),
          toolPart({
            toolCallId: 'call-2',
            callProviderMetadata: {},
            resultProviderMetadata: { google: { thoughtSignature: 'late-tool' } }
          })
        ])
      ],
      { resolveHistoryModel: () => ({ api: 'google-generative-ai', provider: 'cherry-p', model: 'm1' }) }
    )
    expect(assistantEntry(signedTool).content[0]).toMatchObject({ thoughtSignature: 'pi-tool' })
    // The result home is the fallback when the input chunks carried no signature.
    expect(assistantEntry(signedTool).content[1]).toMatchObject({ thoughtSignature: 'late-tool' })
  })

  it('replays redacted thinking as a redacted block, from either writer', () => {
    const anthropic = { api: 'anthropic-messages', provider: 'cherry-p', model: 'm1' } as const
    // pi-written: pi keeps the payload in `thinkingSignature` and marks the block; the
    // serializer emits `redacted_thinking` only for a flagged block, and rejects the
    // payload as a normal thinking signature.
    const piWritten = toPiSessionEntries(
      [
        msg('assistant', [
          {
            type: 'reasoning',
            text: '[Reasoning redacted]',
            state: 'done',
            providerMetadata: { pi: { thinkingSignature: 'pi-payload', redacted: true } }
          }
        ])
      ],
      { resolveHistoryModel: () => anthropic }
    )
    expect(assistantEntry(piWritten).content).toEqual([
      { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'pi-payload', redacted: true }
    ])

    // Legacy AI SDK turn: the payload is `anthropic.redactedData` and there is no visible
    // text at all — a signature-only block must still survive.
    const legacyWritten = toPiSessionEntries(
      [
        msg('assistant', [
          {
            type: 'reasoning',
            text: '',
            state: 'done',
            providerMetadata: { anthropic: { redactedData: 'legacy-payload' } }
          }
        ])
      ],
      { resolveHistoryModel: () => anthropic }
    )
    expect(assistantEntry(legacyWritten).content).toEqual([
      { type: 'thinking', thinking: '', thinkingSignature: 'legacy-payload', redacted: true }
    ])
  })

  it('keeps a signature-only thinking block that is not redacted', () => {
    const entries = toPiSessionEntries(
      [
        msg('assistant', [
          { type: 'reasoning', text: '', state: 'done', providerMetadata: { pi: { thinkingSignature: 'pi-sig' } } }
        ])
      ],
      { resolveHistoryModel: () => ({ api: 'google-generative-ai', provider: 'cherry-p', model: 'm1' }) }
    )
    expect(assistantEntry(entries).content).toEqual([{ type: 'thinking', thinking: '', thinkingSignature: 'pi-sig' }])
  })

  it('uses the placeholder descriptor when no resolver resolves', () => {
    const entries = toPiSessionEntries([msg('assistant', [{ type: 'text', text: 'x' }])])
    const assistant = assistantEntry(entries)
    expect({ api: assistant.api, provider: assistant.provider, model: assistant.model }).toEqual({
      api: 'openai-completions',
      provider: 'cherry-history',
      model: 'history'
    })
  })

  it('resolves identity per message and maps persisted stats to usage', () => {
    const anthropic: PiHistoryModelDescriptor = { api: 'anthropic-messages', provider: 'cherry-p', model: 'm1' }
    const entries = toPiSessionEntries(
      [
        msg('assistant', [{ type: 'text', text: 'one' }], { ...createdAt('2026-09-26T10:00:00.000Z'), stats }, 'a1'),
        msg('assistant', [{ type: 'text', text: 'two' }], createdAt('2026-09-26T10:01:00.000Z'), 'a2')
      ],
      {
        resolveHistoryModel: (message) => (message.id === 'a1' ? anthropic : undefined)
      }
    )
    const first = assistantEntry(entries)
    expect({ api: first.api, provider: first.provider, model: first.model }).toEqual(anthropic)
    // pi's `input` excludes the cache buckets it carries separately; Cherry's total is inclusive.
    expect(first.usage).toEqual({
      input: 200,
      output: 20,
      cacheRead: 500,
      cacheWrite: 300,
      reasoning: 8,
      totalTokens: 1020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    })
    const second = assistantEntry(entries, 1)
    expect({ api: second.api, provider: second.provider, model: second.model }).toEqual(HISTORY_MODEL_PLACEHOLDER)
    // Missing stats fall back to zeros with input+output as the total.
    expect(second.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    })
  })

  it('derives the uncached input count when a row predates the breakdown', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [{ type: 'text', text: 'x' }], {
        stats: { inputTokens: 100, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 40 } }
      })
    ])
    expect(assistantEntry(entries).usage).toMatchObject({ input: 60, output: 5, cacheRead: 40, totalTokens: 105 })
  })
})

describe('message-level rules', () => {
  it('skips messages that convert to no content', () => {
    const entries = toPiSessionEntries([
      msg('user', [{ type: 'data-knowledge-scope', data: { baseIds: ['kb1'] } }]),
      msg('assistant', [{ type: 'data-error', data: { message: 'boom' } }]),
      msg('system', [])
    ])
    expect(entries).toHaveLength(0)
  })

  it('keeps partial text of an errored assistant turn', () => {
    const entries = toPiSessionEntries([
      msg('assistant', [
        { type: 'text', text: 'half an ans' },
        { type: 'data-error', data: { message: 'boom' } }
      ])
    ])
    expect(assistantEntry(entries).content).toEqual([{ type: 'text', text: 'half an ans' }])
  })

  it('maps system messages and joins their text parts', () => {
    const entries = toPiSessionEntries([
      msg(
        'system',
        [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' }
        ],
        createdAt('2026-09-26T08:00:00.000Z')
      )
    ])
    expect(entries[0].message).toEqual({
      role: 'system',
      content: 'one\n\ntwo',
      timestamp: Date.parse('2026-09-26T08:00:00.000Z')
    })
  })

  it('emits string content for a pure-text user message', () => {
    const entries = toPiSessionEntries([msg('user', [{ type: 'text', text: 'plain' }])])
    expect(entries[0].message).toEqual({ role: 'user', content: 'plain', timestamp: 0 })
  })

  it('drops empty text parts instead of empty content blocks', () => {
    const entries = toPiSessionEntries([msg('assistant', [{ type: 'text', text: '' }])])
    expect(entries).toHaveLength(0)
  })
})

describe('purity', () => {
  const conversation: CherryUIMessage[] = [
    msg('user', [
      { type: 'text', text: 'q' },
      { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL }
    ]),
    msg('assistant', [toolPart(), { type: 'text', text: 'a' }], createdAt('2026-09-26T10:00:00.000Z'))
  ]

  /** Deep freeze so any in-place mutation throws in strict mode. */
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key])
      }
      Object.freeze(value)
    }
    return value
  }

  it('leaves the input untouched and is deterministic', () => {
    const input = structuredClone(conversation)
    const frozen = deepFreeze(structuredClone(conversation))

    const first = toPiSessionEntries(input)
    const second = toPiSessionEntries(input)
    expect(second).toEqual(first) // same input → same output
    expect(input).toEqual(conversation) // input not mutated
    expect(() => toPiSessionEntries(frozen)).not.toThrow() // frozen input survives (no in-place edits)
    expect(toPiSessionEntries(frozen)).toEqual(first)
  })
})
