import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { readUIMessageStream } from 'ai'
import { describe, expect, it } from 'vitest'

import { webSearchOutputSchema } from '@shared/ai/builtinTools'
import { PI_TOOL_CALL_TOOL_NAME } from '@shared/ai/piBuiltinTools'
import type { CherryUIMessage, CherryUIMessageChunk } from '@shared/data/types/message'

import { PI_TRANSPORT, PiStreamAdapter } from './piStreamAdapter'

function collect(events: AgentSessionEvent[]): CherryUIMessageChunk[] {
  const chunks: CherryUIMessageChunk[] = []
  const adapter = new PiStreamAdapter({ enqueue: (chunk) => chunks.push(chunk) })
  for (const event of events) adapter.handleEvent(event)
  return chunks
}

/** Feed the adapter chunks through the real AI SDK accumulator, as the host does. */
async function accumulate(chunks: CherryUIMessageChunk[]): Promise<CherryUIMessage> {
  const stream = new ReadableStream<CherryUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  let last: CherryUIMessage | undefined
  for await (const snapshot of readUIMessageStream<CherryUIMessage>({ stream })) last = snapshot
  if (!last) throw new Error('no message produced')
  return last
}

const assistantEvent = (inner: Record<string, unknown>): AgentSessionEvent =>
  ({ type: 'message_update', message: {} as never, assistantMessageEvent: inner }) as unknown as AgentSessionEvent

describe('PiStreamAdapter', () => {
  it('opens a step for assistant message starts only', () => {
    const chunks = collect([
      { type: 'message_start', message: { role: 'user', content: 'q' } } as unknown as AgentSessionEvent,
      { type: 'message_start', message: { role: 'assistant', content: [] } } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'a' }),
      assistantEvent({ type: 'text_end', contentIndex: 0 }),
      // A second assistant message in the same turn (the tool loop) opens another step.
      { type: 'message_start', message: { role: 'assistant', content: [] } } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_end', contentIndex: 0 }),
      { type: 'message_start', message: { role: 'toolResult', content: [] } } as unknown as AgentSessionEvent
    ])

    expect(chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(2)
    // Step boundaries precede their message's parts: the first chunk of each
    // assistant message group is the step marker, never content.
    expect(chunks[0].type).toBe('start-step')
  })

  it('maps a text + tool-call turn to the expected chunk sequence', () => {
    const chunks = collect([
      { type: 'message_start', message: {} } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'Hello' }),
      assistantEvent({ type: 'text_delta', contentIndex: 0, delta: ' world' }),
      assistantEvent({ type: 'text_end', contentIndex: 0 }),
      {
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'bash',
        args: { command: 'ls' }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: 'file.txt',
        isError: false
      },
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, reasoning: 1, totalTokens: 0 }
        },
        toolResults: []
      } as unknown as AgentSessionEvent
    ])

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'message-metadata'
    ])

    const toolInput = chunks.find((chunk) => chunk.type === 'tool-input-available')
    expect(toolInput).toMatchObject({
      toolCallId: 't1',
      toolName: 'bash',
      input: { command: 'ls' },
      providerMetadata: { cherry: { transport: PI_TRANSPORT } }
    })

    const meta = chunks.find((chunk) => chunk.type === 'message-metadata')
    expect(meta).toMatchObject({
      messageMetadata: {
        totalTokens: 20,
        stats: {
          inputTokens: 15,
          outputTokens: 5,
          totalTokens: 20,
          outputTokenDetails: { reasoningTokens: 1 }
        }
      }
    })
  })

  it('stamps the pi transport on tool error output', () => {
    const chunks = collect([
      { type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'e1',
        toolName: 'edit',
        result: { message: 'boom' },
        isError: true
      }
    ])
    const err = chunks.find((chunk) => chunk.type === 'tool-output-error')
    expect(err).toMatchObject({
      toolCallId: 'e1',
      errorText: JSON.stringify({ message: 'boom' }),
      providerMetadata: { cherry: { transport: PI_TRANSPORT } }
    })
  })

  it('keeps content-part ids unique across multiple assistant messages in one loop', () => {
    const chunks = collect([
      { type: 'message_start', message: {} } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_end', contentIndex: 0 }),
      { type: 'message_start', message: {} } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_end', contentIndex: 0 })
    ])
    const ids = chunks.filter((chunk) => chunk.type === 'text-start').map((chunk) => (chunk as { id: string }).id)
    expect(new Set(ids).size).toBe(2)
  })

  it('sums token usage across the multiple turn_ends of one turn', async () => {
    const turnEnd = (usage: Record<string, number>): AgentSessionEvent =>
      ({ type: 'turn_end', message: { role: 'assistant', usage }, toolResults: [] }) as unknown as AgentSessionEvent
    const chunks = collect([
      { type: 'agent_start' } as unknown as AgentSessionEvent,
      turnEnd({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
      turnEnd({ input: 120, output: 80, cacheRead: 0, cacheWrite: 0 })
    ])
    // Each turn_end emits a running total; the last-wins chunk carries the whole turn.
    const metas = chunks.filter((chunk) => chunk.type === 'message-metadata')
    expect(metas.at(-1)).toMatchObject({
      messageMetadata: { totalTokens: 350, stats: { inputTokens: 220, outputTokens: 130, totalTokens: 350 } }
    })
    const message = await accumulate(chunks)
    expect(message.metadata).toMatchObject({
      totalTokens: 350,
      stats: { inputTokens: 220, outputTokens: 130, totalTokens: 350 }
    })
  })

  it('resets the token accumulator when a new turn starts (agent_start)', () => {
    const turnEnd = (usage: Record<string, number>): AgentSessionEvent =>
      ({ type: 'turn_end', message: { role: 'assistant', usage }, toolResults: [] }) as unknown as AgentSessionEvent
    const chunks = collect([
      { type: 'agent_start' } as unknown as AgentSessionEvent,
      turnEnd({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
      { type: 'agent_start' } as unknown as AgentSessionEvent,
      turnEnd({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })
    ])
    const metas = chunks.filter((chunk) => chunk.type === 'message-metadata')
    expect(metas.at(-1)).toMatchObject({
      messageMetadata: { totalTokens: 15, stats: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    })
  })

  it('accumulates into a CherryUIMessage with text and tool parts', async () => {
    const chunks = collect([
      { type: 'message_start', message: {} } as unknown as AgentSessionEvent,
      assistantEvent({ type: 'text_start', contentIndex: 0 }),
      assistantEvent({ type: 'text_delta', contentIndex: 0, delta: 'done' }),
      assistantEvent({ type: 'text_end', contentIndex: 0 }),
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a' } },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        result: 'contents',
        isError: false
      }
    ])
    const message = await accumulate(chunks)
    const text = message.parts.find((part) => part.type === 'text')
    expect(text).toMatchObject({ text: 'done' })
    const tool = message.parts.find((part) => part.type === 'dynamic-tool')
    expect(tool).toMatchObject({ toolName: 'read', state: 'output-available', output: 'contents' })
  })

  it('projects code-mode details as the renderer-facing output', async () => {
    const details = { result: { total: 1 }, logs: ['searched'] }
    const message = await accumulate(
      collect([
        { type: 'tool_execution_start', toolCallId: 'code-1', toolName: 'tool_exec', args: { code: 'return 1' } },
        {
          type: 'tool_execution_end',
          toolCallId: 'code-1',
          toolName: 'tool_exec',
          result: { content: [{ type: 'text', text: '{"total":1}' }], details },
          isError: false
        }
      ] as AgentSessionEvent[])
    )

    expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName: 'tool_exec',
      state: 'output-available',
      output: details
    })
  })

  it('preserves a report_artifacts declaration for runtime-neutral renderer projection', async () => {
    const toolName = 'mcp__cherry-tools__report_artifacts'
    const input = {
      artifacts: [{ path: 'dist/report.md', description: 'Final report' }],
      summary: 'Created the report'
    }
    const message = await accumulate(
      collect([
        { type: 'tool_execution_start', toolCallId: 'artifact-1', toolName, args: input },
        {
          type: 'tool_execution_end',
          toolCallId: 'artifact-1',
          toolName,
          result: 'Recorded 1 artifact(s).',
          isError: false
        }
      ])
    )

    expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName,
      input,
      state: 'output-available'
    })
  })

  it('stamps MCP tools with type mcp, name, and serverName from the tool name', () => {
    const chunks = collect([
      { type: 'tool_execution_start', toolCallId: 'm1', toolName: 'mcp__exa__search', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'm1',
        toolName: 'mcp__exa__search',
        result: { content: [{ type: 'text', text: 'results' }] },
        isError: false
      }
    ])
    const toolOutput = chunks.find((chunk) => chunk.type === 'tool-output-available')
    expect(toolOutput).toMatchObject({
      providerMetadata: {
        cherry: { transport: PI_TRANSPORT, tool: { type: 'mcp', name: 'search', serverName: 'exa' } }
      }
    })
  })

  /**
   * pi's code mode is unconditional, so cherry-tools is never a tool name of its own — every call
   * arrives as `tool_call`, returning the target's MCP result verbatim. The renderer resolves
   * `[cite:id]` markers by validating that output against `webSearchOutputSchema`, which a content
   * block array never matches, so without the unwrap the markers stay literal.
   */
  it('unwraps a tool_call search result into the shape the citation resolver validates', async () => {
    const results = [{ id: '19ff9dcd-1', title: 'First', url: 'https://a.com', content: 'x' }]
    const message = await accumulate(
      collect([
        {
          type: 'tool_execution_start',
          toolCallId: 'm2',
          toolName: PI_TOOL_CALL_TOOL_NAME,
          args: { name: 'mcp__cherry-tools__web_search', params: { query: 'x' } }
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'm2',
          toolName: PI_TOOL_CALL_TOOL_NAME,
          result: { content: [{ type: 'text', text: JSON.stringify(results) }], details: null },
          isError: false
        }
      ] as AgentSessionEvent[])
    )
    const output = (message.parts.find((part) => part.type === 'dynamic-tool') as { output?: unknown }).output
    expect(webSearchOutputSchema.safeParse(output).success).toBe(true)
  })

  it('falls back to joined text when a tool_call result is not JSON', async () => {
    const message = await accumulate(
      collect([
        { type: 'tool_execution_start', toolCallId: 'm3', toolName: PI_TOOL_CALL_TOOL_NAME, args: {} },
        {
          type: 'tool_execution_end',
          toolCallId: 'm3',
          toolName: PI_TOOL_CALL_TOOL_NAME,
          result: { content: [{ type: 'text', text: 'plain results' }], details: null },
          isError: false
        }
      ] as AgentSessionEvent[])
    )
    expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName: PI_TOOL_CALL_TOOL_NAME,
      output: 'plain results'
    })
  })

  it('keeps non-text tool_call content blocks as blocks', async () => {
    const content = [
      { type: 'text', text: 'shot' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' }
    ]
    const message = await accumulate(
      collect([
        { type: 'tool_execution_start', toolCallId: 'm4', toolName: PI_TOOL_CALL_TOOL_NAME, args: {} },
        {
          type: 'tool_execution_end',
          toolCallId: 'm4',
          toolName: PI_TOOL_CALL_TOOL_NAME,
          result: { content, details: null },
          isError: false
        }
      ] as AgentSessionEvent[])
    )
    expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName: PI_TOOL_CALL_TOOL_NAME,
      output: content
    })
  })

  describe('replay signature persistence', () => {
    // `partial` is the live assistant message; by a block's *_end event its
    // content array carries the finished block with the provider signature.
    const partialWith = (blocks: unknown[]) => ({ role: 'assistant', content: blocks })

    it('persists thinking and text signatures from the finished blocks', async () => {
      const partial = partialWith([
        { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig-think' },
        { type: 'text', text: 'answer', textSignature: 'sig-text' }
      ])
      const chunks = collect([
        assistantEvent({ type: 'thinking_start', contentIndex: 0 }),
        assistantEvent({ type: 'thinking_end', contentIndex: 0, partial }),
        assistantEvent({ type: 'text_start', contentIndex: 1 }),
        assistantEvent({ type: 'text_end', contentIndex: 1, partial })
      ])

      expect(chunks.find((chunk) => chunk.type === 'reasoning-end')).toMatchObject({
        providerMetadata: { pi: { thinkingSignature: 'sig-think' } }
      })
      expect(chunks.find((chunk) => chunk.type === 'text-end')).toMatchObject({
        providerMetadata: { pi: { textSignature: 'sig-text' } }
      })

      // Through the real accumulator: the part carries what the converter reads back.
      const message = await accumulate(
        collect([
          { type: 'message_start', message: {} } as unknown as AgentSessionEvent,
          assistantEvent({ type: 'thinking_start', contentIndex: 0 }),
          assistantEvent({ type: 'thinking_end', contentIndex: 0, partial }),
          assistantEvent({ type: 'text_start', contentIndex: 1 }),
          assistantEvent({ type: 'text_end', contentIndex: 1, partial })
        ])
      )
      expect(message.parts.find((part) => part.type === 'reasoning')).toMatchObject({
        providerMetadata: { pi: { thinkingSignature: 'sig-think' } }
      })
      expect(message.parts.find((part) => part.type === 'text')).toMatchObject({
        providerMetadata: { pi: { textSignature: 'sig-text' } }
      })
    })

    it('omits the providerMetadata key when the block carries no signature', () => {
      const partial = partialWith([{ type: 'text', text: 'plain' }])
      const chunks = collect([assistantEvent({ type: 'text_end', contentIndex: 0, partial })])
      expect(chunks[0]).not.toHaveProperty('providerMetadata')
    })

    it('stamps a signed tool call captured from the finished tool-call block', () => {
      const partial = partialWith([
        { type: 'toolCall', id: 'call-9', name: 'bash', arguments: {}, thoughtSignature: 'sig-tool' }
      ])
      const chunks = collect([
        assistantEvent({ type: 'toolcall_end', contentIndex: 0, partial }),
        { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'bash', args: {} },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-9',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'ok' }], details: null },
          isError: false
        }
      ])

      expect(chunks.find((chunk) => chunk.type === 'tool-input-available')).toMatchObject({
        providerMetadata: { pi: { toolName: 'bash', thoughtSignature: 'sig-tool' } }
      })
      // The execution chunks follow the block, so the signature is in hand by then.
      expect(chunks.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({
        providerMetadata: { pi: { toolName: 'bash', thoughtSignature: 'sig-tool' } }
      })
    })

    it('leaves unsigned tool calls without a signature key', () => {
      const partial = partialWith([{ type: 'toolCall', id: 'call-10', name: 'edit', arguments: {} }])
      const chunks = collect([
        assistantEvent({ type: 'toolcall_end', contentIndex: 0, partial }),
        { type: 'tool_execution_start', toolCallId: 'call-10', toolName: 'edit', args: {} }
      ])
      expect(chunks.find((chunk) => chunk.type === 'tool-input-available')).toMatchObject({
        providerMetadata: { pi: { toolName: 'edit' } }
      })
    })
  })
})
