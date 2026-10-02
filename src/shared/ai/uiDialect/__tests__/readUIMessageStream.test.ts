import { readUIMessageStream as aiReadUIMessageStream, type UIMessageChunk as AiUIMessageChunk } from 'ai'
import { describe, expect, it } from 'vitest'

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from '../index'

/**
 * Contract: the vendored accumulator produces byte-identical snapshots to the (locally patched)
 * `ai` package's accumulator on the same chunk stream. The wire format must not drift.
 */

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

async function collect(
  read: typeof readUIMessageStream,
  chunks: UIMessageChunk[],
  options?: { message?: UIMessage; onError?: (error: unknown) => void }
): Promise<UIMessage[]> {
  // The accumulator mutates the seed message in place (upstream behavior), so each run gets its
  // own deep copy — ours and the ai package's must not contaminate each other.
  const message = options?.message ? structuredClone(options.message) : undefined
  const stream = read({ stream: streamOf(chunks), message, onError: options?.onError })
  const reader = stream.getReader()
  const snapshots: UIMessage[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    snapshots.push(value)
  }
  return snapshots
}

async function expectSnapshotsEqual(chunks: UIMessageChunk[], options?: { message?: UIMessage }) {
  const [ours, theirs] = await Promise.all([
    collect(readUIMessageStream, chunks, options),
    collect(aiReadUIMessageStream as typeof readUIMessageStream, chunks, options)
  ])
  expect(ours).toEqual(theirs)
  return { ours, theirs }
}

describe('readUIMessageStream — vendored parity with ai@6.0.185 (patched)', () => {
  it('accumulates a text turn: start, step boundary, text deltas, finish', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello ' },
      { type: 'text-delta', id: 't1', delta: 'world' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' }
    ])

    const final = ours.at(-1)
    expect(final?.id).toBe('msg-1')
    expect(final?.role).toBe('assistant')
    expect(final?.parts).toEqual([{ type: 'step-start' }, { type: 'text', text: 'Hello world', state: 'done' }])
  })

  it('accumulates reasoning parts', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'reasoning-start', id: 'r1', providerMetadata: { anthropic: { a: 1 } } },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking…' },
      { type: 'reasoning-end', id: 'r1' }
    ])
    expect(ours.at(-1)?.parts).toEqual([
      { type: 'reasoning', text: 'thinking…', providerMetadata: { anthropic: { a: 1 } }, state: 'done' }
    ])
  })

  it('accumulates a streamed static tool call: input-start, partial-json deltas, input-available, output-available', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'web_search', title: 'Searching' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{"que' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: 'ry": "cats", "limit": 3}' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'web_search',
        input: { query: 'cats', limit: 3 }
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-1',
        output: { results: ['a', 'b'] },
        providerMetadata: { google: { x: 1 } }
      }
    ])

    const final = ours.at(-1)
    expect(final?.parts).toEqual([
      { type: 'step-start' },
      {
        type: 'tool-web_search',
        toolCallId: 'call-1',
        state: 'output-available',
        title: 'Searching',
        input: { query: 'cats', limit: 3 },
        output: { results: ['a', 'b'] },
        resultProviderMetadata: { google: { x: 1 } }
      }
    ])
  })

  it('accumulates a dynamic tool call and a tool input error', async () => {
    await expectSnapshotsEqual([
      { type: 'tool-input-start', toolCallId: 'call-d', toolName: 'dyn_tool', dynamic: true },
      { type: 'tool-input-available', toolCallId: 'call-d', toolName: 'dyn_tool', input: [1, 2], dynamic: true },
      { type: 'tool-output-available', toolCallId: 'call-d', output: 'ok', dynamic: true },
      {
        type: 'tool-input-error',
        toolCallId: 'call-e',
        toolName: 'broken_tool',
        input: 'not json at all',
        errorText: 'invalid tool input'
      }
    ])
  })

  it('routes approval request and denial chunks onto the tool part', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'tool-input-available', toolCallId: 'call-a', toolName: 'fs_read', input: { path: '/tmp' } },
      { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-a' },
      { type: 'tool-output-denied', toolCallId: 'call-a' }
    ])
    expect(ours.at(-1)?.parts).toEqual([
      {
        type: 'tool-fs_read',
        toolCallId: 'call-a',
        state: 'output-denied',
        input: { path: '/tmp' },
        approval: { id: 'appr-1' }
      }
    ])
  })

  it('accumulates file, source-url and source-document parts', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAA' },
      { type: 'source-url', sourceId: 's1', url: 'https://example.com', title: 'Example' },
      { type: 'source-document', sourceId: 's2', mediaType: 'application/pdf', title: 'Doc' }
    ])
    expect(ours.at(-1)?.parts).toHaveLength(3)
  })

  it('dedupes data parts by id, passes transient data through without a part, and keeps id-less data parts', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'data-progress', id: 'p1', data: { pct: 10 } },
      { type: 'data-progress', id: 'p1', data: { pct: 90 } },
      { type: 'data-heartbeat', data: { at: 1 }, transient: true },
      { type: 'data-note', data: 'plain' }
    ])

    const parts = ours.at(-1)?.parts as Array<{ type: string; id?: string; data: unknown }>
    expect(parts.map((p) => p.type)).toEqual(['data-progress', 'data-note'])
    expect(parts[0].data).toEqual({ pct: 90 })
  })

  it('reports error chunks via onError and still closes the stream (terminateOnError defaults to false)', async () => {
    const oursErrors: unknown[] = []
    const theirsErrors: unknown[] = []

    const chunks: UIMessageChunk[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'partial' },
      { type: 'error', errorText: 'provider exploded' },
      { type: 'text-end', id: 't1' }
    ]

    const [ours, theirs] = await Promise.all([
      collect(readUIMessageStream, chunks, { onError: (e) => oursErrors.push(e) }),
      collect(aiReadUIMessageStream as typeof readUIMessageStream, chunks, { onError: (e) => theirsErrors.push(e) })
    ])

    expect(ours).toEqual(theirs)
    expect(oursErrors.map((e) => (e as Error).message)).toEqual(['provider exploded'])
    expect(oursErrors.map((e) => (e as Error).message)).toEqual(theirsErrors.map((e) => (e as Error).message))
    expect(ours.at(-1)?.parts).toEqual([{ type: 'text', text: 'partial', state: 'done' }])
  })

  it('merges message-metadata chunks across start / finish / message-metadata', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'start', messageId: 'm1', messageMetadata: { a: 1 } },
      { type: 'message-metadata', messageMetadata: { b: { nested: true } } },
      { type: 'message-metadata', messageMetadata: { a: 2 } },
      { type: 'finish', messageMetadata: { c: 'x' }, finishReason: 'length' }
    ])
    expect(ours.at(-1)?.metadata).toEqual({ a: 2, b: { nested: true }, c: 'x' })
  })

  it('separates steps with step-start parts and resets active part tracking at finish-step', async () => {
    const { ours } = await expectSnapshotsEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'one' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'two' },
      { type: 'text-end', id: 't2' },
      { type: 'finish-step' }
    ])
    expect(ours.at(-1)?.parts.map((p) => p.type)).toEqual(['step-start', 'text', 'step-start', 'text'])
  })

  it('continues a seeded assistant message (resume path)', async () => {
    const seed: UIMessage = {
      id: 'msg-9',
      role: 'assistant',
      parts: [{ type: 'text', text: 'before', state: 'done' }]
    }
    const { ours } = await expectSnapshotsEqual(
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: ' after' },
        { type: 'text-end', id: 't1' }
      ],
      { message: seed }
    )
    const final = ours.at(-1)
    expect(final?.id).toBe('msg-9')
    expect(final?.parts.map((p) => (p.type === 'text' ? p.text : p.type))).toEqual(['before', ' after'])
  })

  it('keeps the cherrySnapshotUIMessage structural-sharing patch: deep part values are shared across snapshots', async () => {
    // The local patch (patches/ai@6.0.185.patch) replaced structuredClone with a structural-sharing
    // snapshot. Nested values inside parts must keep object identity between consecutive snapshots —
    // that identity is exactly what the unpatched structuredClone would break.
    const chunks: UIMessageChunk[] = [
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
      { type: 'tool-output-available', toolCallId: 'c1', output: { deep: { value: 1 } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'more' }
    ]
    const snapshots = await collect(readUIMessageStream, chunks)
    expect(snapshots.length).toBeGreaterThanOrEqual(3)

    const toolPartA = snapshots[1].parts[0] as { output: { deep: { value: number } } }
    const toolPartB = snapshots[2].parts[0] as { output: { deep: { value: number } } }
    expect(toolPartA).not.toBe(toolPartB) // each snapshot copies the part itself…
    expect(toolPartA.output).toBe(toolPartB.output) // …but shares nested values

    const theirs = await collect(aiReadUIMessageStream as typeof readUIMessageStream, chunks)
    const theirsA = theirs[1].parts[0] as { output: unknown }
    const theirsB = theirs[2].parts[0] as { output: unknown }
    expect(theirsA.output).toBe(theirsB.output) // the installed package carries the same patch
  })

  it('reports a UIMessageStreamError via onError for a text-delta without text-start, then closes (terminateOnError defaults to false)', async () => {
    const chunks: UIMessageChunk[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'ok' },
      { type: 'text-end', id: 't1' },
      { type: 'text-delta', id: 'ghost', delta: 'x' }
    ]

    const run = async (read: typeof readUIMessageStream) => {
      const errors: unknown[] = []
      const snapshots = await collect(read, chunks, { onError: (e) => errors.push(e) })
      return {
        errors: errors.map((e) => ({ message: (e as Error).message, name: (e as Error).name })),
        snapshots
      }
    }

    const ours = await run(readUIMessageStream)
    const theirs = await run(aiReadUIMessageStream as typeof readUIMessageStream)

    expect(ours).toEqual(theirs)
    expect(ours.errors).toEqual([
      {
        message:
          'Received text-delta for missing text part with ID "ghost". Ensure a "text-start" chunk is sent before any "text-delta" chunks.',
        name: 'AI_UIMessageStreamError'
      }
    ])
    // snapshots emitted before the failing chunk were still delivered; the stream closed normally
    expect(ours.snapshots.length).toBeGreaterThan(0)
  })

  it('fails the output stream on a stream error when terminateOnError is true, matching the ai package', async () => {
    const chunks: UIMessageChunk[] = [{ type: 'text-delta', id: 'ghost', delta: 'x' }]

    const run = async (read: typeof readUIMessageStream) => {
      const stream = read({ stream: streamOf(chunks), terminateOnError: true })
      const reader = stream.getReader()
      await reader.read()
    }

    await expect(run(readUIMessageStream)).rejects.toThrow('Received text-delta for missing text part with ID "ghost"')
    await expect(run(aiReadUIMessageStream as typeof readUIMessageStream)).rejects.toThrow(
      'Received text-delta for missing text part with ID "ghost"'
    )
  })

  it('accepts every chunk type the trunk emits (typed pass-through of the chunk itself)', async () => {
    // The transform re-enqueues every chunk; consumers rely on the chunk stream being unchanged.
    const chunks: AiUIMessageChunk[] = [
      { type: 'abort', reason: 'user' },
      { type: 'start' },
      { type: 'tool-output-error', toolCallId: 'c', errorText: 'boom' }
    ]
    await expectSnapshotsEqual(chunks)
  })
})
