import type { TranscriptContext } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readUIMessageStream } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import type { CherryUIMessage, CherryUIMessageChunk } from '@shared/data/types/message'

import type { AgentRuntimeUsageInvocation } from '../types'
import { streamPiChatTurn, type PiChatProviderSource } from './chatEngine'
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

/** Real Anthropic-family api behind a recording fetch, so the wire payload is the assertion target. */
async function anthropicProviderSource(bodies: unknown[]): Promise<PiChatProviderSource> {
  const anthropic = await import('@earendil-works/pi-ai/api/anthropic-messages')
  const config = {
    name: 'Anthropic Probe',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'placeholder',
    models: [
      {
        id: 'claude-x',
        name: 'Claude X',
        api: 'anthropic-messages',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_000
      }
    ],
    streamSimple: (model: never, context: never, options: { [key: string]: unknown } | undefined) =>
      anthropic.streamSimple(model, context, {
        ...options,
        apiKey: 'test-key',
        maxRetries: 0,
        fetch: async (_input: unknown, init?: { body?: unknown }) => {
          bodies.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ error: { message: 'recording fetch stops the turn' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' }
          })
        }
      })
  }
  return { name: 'anthropic-probe', apiKey: 'test-key', modelId: 'claude-x', config: config as never }
}

async function runAnthropicTurn(options: {
  provider: PiChatProviderSource
  history: CherryUIMessage[]
  isSameModelAsTurn?: (message: CherryUIMessage) => boolean
}): Promise<void> {
  const stream = await streamPiChatTurn(
    {
      executionId: 'exec-signature',
      provider: options.provider,
      history: options.history,
      prompt: userTurn('follow-up'),
      ...(options.isSameModelAsTurn && { isSameModelAsTurn: options.isSameModelAsTurn })
    },
    new AbortController().signal
  )
  // The recording fetch fails the turn on purpose; the captured body is the artifact.
  await drain(stream).catch(() => undefined)
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

/** The turn's trailing user message, as the seam hands it over (history excludes it). */
function userTurn(text: string, messageId = 'p1'): { messageId: string; text: string } {
  return { messageId, text }
}

/** A served history message (not the trailing turn). */
function historyText(id: string, role: CherryUIMessage['role'], text: string): CherryUIMessage {
  return { id, role, parts: [{ type: 'text', text }] }
}

function userTextOf(context: TranscriptContext): string | undefined {
  const user = [...context.messages].reverse().find((message) => message.role === 'user')
  if (typeof user?.content === 'string') return user.content
  return Array.isArray(user?.content)
    ? (user.content.find((block) => block.type === 'text') as { text?: string } | undefined)?.text
    : undefined
}

describe('streamPiChatTurn', () => {
  it('streams a text turn as a chunk sequence with finish parity', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-text')
    fauxStates.get('exec-text')!.core.setResponses([faux.fauxAssistantMessage('Hello from pi')])

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-text', provider, history: [], prompt: userTurn('hi') },
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
          prompt: userTurn('hi')
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
        { executionId: 'exec-noprompt', provider, history: [], prompt: userTurn('hi') },
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
        { executionId: 'exec-slash', provider, history: [], prompt: userTurn('/help me') },
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
          prompt: userTurn('echo hi'),
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
      { executionId: 'exec-abort', provider, history: [], prompt: userTurn('hi') },
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

  it('closes cleanly when pi aborts on its own (no finish chunk)', async () => {
    const faux = await importFaux()
    // pi stops the turn itself — the signal stays live, so the verdict must not
    // dress the abort up as a successful `finish: stop` (W4a approval flows rely on this).
    const provider = await fauxProviderSource(faux, 'exec-pi-abort')
    fauxStates
      .get('exec-pi-abort')!
      .core.setResponses([faux.fauxAssistantMessage('partial', { stopReason: 'aborted' })])

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-pi-abort', provider, history: [], prompt: userTurn('hi') },
        new AbortController().signal
      )
    )

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
      { executionId: 'exec-error', provider, history: [], prompt: userTurn('hi') },
      new AbortController().signal
    )
    await expect(drain(stream)).rejects.toThrow('provider exploded')
  })

  it('reports one usage invocation with the inclusive/exclusive token split the accounting expects', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-usage')
    fauxStates.get('exec-usage')!.core.setResponses([
      (): ReturnType<typeof faux.fauxAssistantMessage> => ({
        ...faux.fauxAssistantMessage('answer'),
        responseId: 'resp-1',
        responseModel: 'faux-model-2'
      })
    ])
    const invocations: AgentRuntimeUsageInvocation[] = []

    await drain(
      await streamPiChatTurn(
        {
          executionId: 'exec-usage',
          provider,
          history: [],
          prompt: userTurn('hi'),
          onInvocation: (invocation) => invocations.push(invocation)
        },
        new AbortController().signal
      )
    )

    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({
      requestId: 'pi-chat:exec-usage:resp-1',
      model: 'faux-model-2',
      messageAssociation: 'current-turn'
    })
    // pi's `usage.input` is the UNCACHED prompt count; the record's `inputTokens` is the
    // inclusive total (legacy AI SDK semantics) with the buckets kept alongside it.
    const usage = invocations[0].usage
    expect(usage).toBeDefined()
    expect(usage!.cacheWriteTokens).toBeGreaterThan(0)
    expect(usage!.inputTokens).toBe(usage!.noCacheTokens + usage!.cacheReadTokens + usage!.cacheWriteTokens)
    expect(usage!.totalTokens).toBe(usage!.inputTokens + usage!.outputTokens)
    // The faux reports no reasoning breakdown, so the field must be absent, not zeroed.
    expect('reasoningTokens' in usage!).toBe(false)
    expect(invocations[0].metrics?.timeCompletionMs).toBeGreaterThanOrEqual(0)
  })

  it('replays history through the converter and round-trips its own output (W2 guard)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-roundtrip')
    fauxStates
      .get('exec-roundtrip')!
      .core.setResponses([faux.fauxAssistantMessage([faux.fauxThinking('plan'), faux.fauxText('Answer')])])

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-roundtrip', provider, history: [], prompt: userTurn('q') },
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

  it('replays served history into the provider request', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-history')
    fauxStates.get('exec-history')!.core.setResponses([faux.fauxAssistantMessage('answer')])

    await drain(
      await streamPiChatTurn(
        {
          executionId: 'exec-history',
          provider,
          history: [historyText('u0', 'user', 'earlier question'), historyText('a0', 'assistant', 'earlier answer')],
          prompt: userTurn('follow-up')
        },
        new AbortController().signal
      )
    )

    const context = fauxStates.get('exec-history')!.capturedContexts[0]
    // A leading system message always exists (pi's shape; empty text with no chat prompt).
    expect(context.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(userTextOf(context)).toBe('follow-up')
  })

  it('refuses a turn whose history still contains its prompt message', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-dupe')
    fauxStates.get('exec-dupe')!.core.setResponses([faux.fauxAssistantMessage('answer')])

    await expect(
      streamPiChatTurn(
        {
          executionId: 'exec-dupe',
          provider,
          history: [historyText('p1', 'user', 'the same question')],
          prompt: userTurn('the same question', 'p1')
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/history already contains the prompt message p1/)
  })

  it('closes without prompting when the signal was already aborted', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-preabort')
    const core = fauxStates.get('exec-preabort')!.core
    core.setResponses([faux.fauxAssistantMessage('must not be generated')])
    const controller = new AbortController()
    controller.abort()

    const chunks = await drain(
      await streamPiChatTurn(
        { executionId: 'exec-preabort', provider, history: [], prompt: userTurn('hi') },
        controller.signal
      )
    )

    expect(chunks.map((chunk) => chunk.type)).toEqual(['start'])
    expect(core.getPendingResponseCount()).toBe(1)
  })

  it('errors the stream when the model stops at the output limit', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-length')
    fauxStates.get('exec-length')!.core.setResponses([faux.fauxAssistantMessage('truncated', { stopReason: 'length' })])

    await expect(
      drain(
        await streamPiChatTurn(
          { executionId: 'exec-length', provider, history: [], prompt: userTurn('hi') },
          new AbortController().signal
        )
      )
    ).rejects.toThrow(/output limit/)
  })

  it('keeps a signed reasoning block for same-model history only', async () => {
    const history = [
      historyText('u0', 'user', 'earlier question'),
      {
        id: 'a0',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'plan', state: 'done', providerMetadata: { anthropic: { signature: 'sig-abc' } } },
          { type: 'text', text: 'earlier answer' }
        ]
      } as unknown as CherryUIMessage
    ]

    const sameModelBodies: unknown[] = []
    const sameModel = await anthropicProviderSource(sameModelBodies)
    await runAnthropicTurn({ provider: sameModel, history, isSameModelAsTurn: () => true })

    const foreignBodies: unknown[] = []
    const foreign = await anthropicProviderSource(foreignBodies)
    await runAnthropicTurn({ provider: foreign, history })

    const assistantContent = (bodies: unknown[]): Array<{ type: string; signature?: string; text?: string }> => {
      const body = bodies[0] as { messages: Array<{ role: string; content: unknown }> }
      return body.messages[1].content as Array<{ type: string; signature?: string; text?: string }>
    }
    expect(assistantContent(sameModelBodies)[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-abc' })
    // Without the caller's same-model answer the block rides as text: pi drops the signature.
    expect(assistantContent(foreignBodies)[0]).toEqual({ type: 'text', text: 'plan' })
  })

  it('runs concurrent executions on isolated provider registrations', async () => {
    const faux = await importFaux()
    const first = await fauxProviderSource(faux, 'exec-fanout-a')
    const second = await fauxProviderSource(faux, 'exec-fanout-b')
    fauxStates.get('exec-fanout-a')!.core.setResponses([faux.fauxAssistantMessage('answer A')])
    fauxStates.get('exec-fanout-b')!.core.setResponses([faux.fauxAssistantMessage('answer B')])

    const textOf = async (provider: PiChatProviderSource, executionId: string, text: string): Promise<string> => {
      const chunks = await drain(
        await streamPiChatTurn(
          { executionId, provider, history: [], prompt: userTurn(text) },
          new AbortController().signal
        )
      )
      return chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => (chunk as { delta?: string }).delta)
        .join('')
    }
    const [a, b] = await Promise.all([
      textOf(first, 'exec-fanout-a', 'question A'),
      textOf(second, 'exec-fanout-b', 'question B')
    ])

    expect(a).toBe('answer A')
    expect(b).toBe('answer B')
    expect(userTextOf(fauxStates.get('exec-fanout-a')!.capturedContexts[0])).toBe('question A')
    expect(userTextOf(fauxStates.get('exec-fanout-b')!.capturedContexts[0])).toBe('question B')
  })
})
