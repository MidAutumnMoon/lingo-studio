import type { TranscriptContext } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readUIMessageStream } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import type { CherryUIMessage, CherryUIMessageChunk } from '@shared/data/types/message'

import { streamPiChatTurn, type PiChatProviderInvocation, type PiChatProviderSource } from './chatEngine'
import { toPiSessionEntries } from './historyConverter'

type Faux = Awaited<ReturnType<typeof importFaux>>
async function importFaux() {
  return import('@earendil-works/pi-ai/providers/faux')
}

async function drain(stream: ReadableStream<CherryUIMessageChunk>): Promise<CherryUIMessageChunk[]> {
  const reader = stream.getReader()
  const chunks: CherryUIMessageChunk[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

/** Feed engine chunks through the real AI SDK accumulator, as the trunk does. */
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

type FauxCore = ReturnType<Faux['createFauxCore']>

interface FauxState {
  core: FauxCore
  capturedContexts: TranscriptContext[]
}

const fauxStates = new Map<string, FauxState>()

/** A faux-backed provider source wired through the engine's real registration path. */
async function fauxProviderSource(
  faux: Faux,
  executionId: string,
  coreOptions: Parameters<Faux['createFauxCore']>[0] = {}
): Promise<PiChatProviderSource> {
  const core = faux.createFauxCore({ models: [{ id: 'faux-model', name: 'Faux Model' }], ...coreOptions })
  const state: FauxState = { core, capturedContexts: [] }
  fauxStates.set(executionId, state)
  return {
    name: 'faux-chat',
    apiKey: 'test-key',
    modelId: 'faux-model',
    config: {
      name: 'Faux Chat',
      api: core.api,
      models: [...core.models],
      streamSimple: (model, context, options) => {
        state.capturedContexts.push(context)
        return core.streamSimple(model, context, options)
      }
    }
  }
}

function echoTool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: 'echo',
    label: 'Echo',
    description: 'Echo the query back',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q']
    },
    execute
  }
}

describe('streamPiChatTurn', () => {
  it('streams a text turn as a chunk sequence with finish parity', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-text')
    fauxStates.get('exec-text')!.core.setResponses([faux.fauxAssistantMessage('Hello from pi')])

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-text', provider, history: [], prompt: { text: 'hi' } },
        new AbortController().signal
      )
    )

    const types = chunks.map((chunk) => chunk.type)
    expect(types.slice(0, 2)).toEqual(['start', 'start-step'])
    expect(types.at(-1)).toBe('finish')
    expect(types.filter((type) => type === 'text-start')).toHaveLength(1)
    expect(types.filter((type) => type === 'text-end')).toHaveLength(1)
    expect(types.filter((type) => type === 'message-metadata')).toHaveLength(1)
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { delta?: string }).delta)
      .join('')
    expect(text).toBe('Hello from pi')
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('uses the chat prompt as the sole system prompt', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-prompt')
    fauxStates.get('exec-prompt')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    await drain(
      await streamPiChatTurn(
        {
          executionId: 'exec-prompt',
          provider,
          systemPrompt: 'You are a chat assistant.',
          history: [],
          prompt: { text: 'hi' }
        },
        new AbortController().signal
      )
    )

    const piAi = await import('@earendil-works/pi-ai')
    const context = fauxStates.get('exec-prompt')!.capturedContexts[0]
    expect(piAi.getCurrentSystemPrompt(context.messages)).toBe('You are a chat assistant.')
  })

  it('suppresses the pi coding persona when chat has no prompt', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-noprompt')
    fauxStates.get('exec-noprompt')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    await drain(
      await streamPiChatTurn(
        { executionId: 'exec-noprompt', provider, history: [], prompt: { text: 'hi' } },
        new AbortController().signal
      )
    )

    const piAi = await import('@earendil-works/pi-ai')
    const prompt = piAi.getCurrentSystemPrompt(fauxStates.get('exec-noprompt')!.capturedContexts[0].messages)
    // The override returns '' — no fallback to pi's default coding prompt.
    expect(prompt ?? '').toBe('')
  })

  it('passes user text through verbatim (no pi command expansion)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-slash')
    fauxStates.get('exec-slash')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    await drain(
      await streamPiChatTurn(
        { executionId: 'exec-slash', provider, history: [], prompt: { text: '/help me' } },
        new AbortController().signal
      )
    )

    const context = fauxStates.get('exec-slash')!.capturedContexts[0]
    const lastUser = [...context.messages].reverse().find((message) => message.role === 'user')
    const userText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? (lastUser.content.find((block) => block.type === 'text') as { text?: string } | undefined)?.text
          : undefined
    expect(userText).toBe('/help me')
  })

  it('round-trips a tool call through a declared pi tool', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-tool')
    fauxStates
      .get('exec-tool')!
      .core.setResponses([
        faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
        faux.fauxAssistantMessage('Done')
      ])
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: 'text' as const, text: `echoed: ${(params as { q: string }).q}` }],
      details: null
    }))

    const chunks = await drain(
      await streamPiChatTurn(
        {
          executionId: 'exec-tool',
          provider,
          history: [],
          prompt: { text: 'echo hi' },
          tools: [echoTool(execute)]
        },
        new AbortController().signal
      )
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toEqual({ q: 'hi' })
    const message = await accumulate(chunks)
    const toolPart = message.parts.find((part) => part.type === 'dynamic-tool')
    expect(toolPart).toMatchObject({ toolName: 'echo', state: 'output-available' })
    expect((toolPart as { output?: unknown }).output).toMatchObject({ content: [{ type: 'text', text: 'echoed: hi' }] })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('aborts mid-stream with a clean close and no finish chunk', async () => {
    const faux = await importFaux()
    // Slow tokens so the abort lands while the turn is still streaming.
    const provider = await fauxProviderSource(faux, 'exec-abort', {
      tokensPerSecond: 20,
      tokenSize: { min: 30, max: 30 }
    })
    fauxStates.get('exec-abort')!.core.setResponses([faux.fauxAssistantMessage('slow answer that keeps streaming')])

    const controller = new AbortController()
    const stream = await streamPiChatTurn(
      { executionId: 'exec-abort', provider, history: [], prompt: { text: 'hi' } },
      controller.signal
    )
    const reader = stream.getReader()
    await reader.read() // 'start'
    controller.abort()
    const chunks: CherryUIMessageChunk[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
  })

  it('errors the stream for an errored provider turn', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-error')
    fauxStates
      .get('exec-error')!
      .core.setResponses([
        faux.fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: 'provider exploded' })
      ])

    const stream = await streamPiChatTurn(
      { executionId: 'exec-error', provider, history: [], prompt: { text: 'hi' } },
      new AbortController().signal
    )
    await expect(drain(stream)).rejects.toThrow('provider exploded')
  })

  it('reports one usage invocation per provider call with normalized token math', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-usage')
    fauxStates.get('exec-usage')!.core.setResponses([faux.fauxAssistantMessage('answer')])
    const invocations: PiChatProviderInvocation[] = []

    await drain(
      await streamPiChatTurn(
        {
          executionId: 'exec-usage',
          provider,
          history: [],
          prompt: { text: 'hi' },
          onInvocation: (invocation) => invocations.push(invocation)
        },
        new AbortController().signal
      )
    )

    expect(invocations).toHaveLength(1)
    expect(invocations[0].requestId).toMatch(/^pi-chat:exec-usage:/)
    expect(invocations[0].usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      totalTokens: expect.any(Number)
    })
  })

  it('replays history through the converter and round-trips its own output (W2 guard)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-roundtrip')
    fauxStates
      .get('exec-roundtrip')!
      .core.setResponses([faux.fauxAssistantMessage([faux.fauxThinking('plan'), faux.fauxText('Answer')])])

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-roundtrip', provider, history: [], prompt: { text: 'q' } },
        new AbortController().signal
      )
    )
    const message = await accumulate(chunks)

    const entries = toPiSessionEntries([message], {
      resolveHistoryModel: () => ({ api: 'openai-completions', provider: 'faux-chat', model: 'faux-model' })
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Answer' }
      ]
    })
    // Documented gap: pi emits no reasoning signature today, so replay carries none.
    const thinking = (entries[0].message as unknown as { content: Array<Record<string, unknown>> }).content[0]
    expect('thinkingSignature' in thinking).toBe(false)
  })
})
