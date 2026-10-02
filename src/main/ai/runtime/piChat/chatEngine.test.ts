import type { TranscriptContext } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readUIMessageStream } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import type { CherryUIMessage, CherryUIMessageChunk } from '@shared/data/types/message'

import { toolApprovalRegistry } from '../../toolApproval/ToolApprovalRegistry'
import { zodToolSchema } from '../../tools/neutralTool'
import { markTrustedLocalToolTerminalFailure, ToolLoopTerminalError } from '../../tools/toolLoopTerminal'
import type { AgentRuntimeUsageInvocation } from '../types'
import { streamPiChatTurn, type PiChatProviderSource } from './chatEngine'
import { toPiChatToolSurface } from './chatToolSurface'
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

/** A real pi-ai api family behind a recording fetch, so the wire payload is the assertion target. */
async function recordingProviderSource(
  api: 'anthropic-messages' | 'google-generative-ai' | 'openai-responses',
  modelId: string,
  bodies: unknown[]
): Promise<PiChatProviderSource> {
  // Static import expressions per family: the bundler must see them to inline the ESM ids.
  const apiModule =
    api === 'anthropic-messages'
      ? await import('@earendil-works/pi-ai/api/anthropic-messages')
      : api === 'google-generative-ai'
        ? await import('@earendil-works/pi-ai/api/google-generative-ai')
        : await import('@earendil-works/pi-ai/api/openai-responses')
  const config = {
    name: 'Wire Probe',
    api,
    baseUrl: 'https://probe.invalid',
    apiKey: 'placeholder',
    models: [
      {
        id: modelId,
        name: modelId,
        api,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_000
      }
    ],
    streamSimple: (model: never, context: never, options: { [key: string]: unknown } | undefined) =>
      (apiModule as { streamSimple: (m: never, c: never, o: never) => unknown }).streamSimple(model, context, {
        ...options,
        apiKey: 'test-key',
        maxRetries: 0,
        // The Google adapter rejects a custom fetch (it drives @google/genai's own
        // client), so its wire payload is captured through the onPayload hook instead.
        ...(api === 'google-generative-ai'
          ? { onPayload: (params: unknown) => bodies.push(params) }
          : {
              fetch: async (_input: unknown, init?: { body?: unknown }) => {
                bodies.push(JSON.parse(String(init?.body)))
                return new Response(JSON.stringify({ error: { message: 'recording fetch stops the turn' } }), {
                  status: 400,
                  headers: { 'content-type': 'application/json' }
                })
              }
            })
      } as never)
  }
  return { name: 'wire-probe', apiKey: 'test-key', modelId, config: config as never }
}

async function runRecordingTurn(options: {
  provider: PiChatProviderSource
  history: CherryUIMessage[]
  isSameModelAsTurn?: (message: CherryUIMessage) => boolean
  thinkingLevel?: 'off'
}): Promise<void> {
  const stream = await streamPiChatTurn(
    {
      toolCallLimit: TEST_TOOL_CALL_LIMIT,
      executionId: 'exec-signature',
      provider: options.provider,
      history: options.history,
      prompt: userTurn('follow-up'),
      ...(options.thinkingLevel && { thinkingLevel: options.thinkingLevel }),
      ...(options.isSameModelAsTurn && { isSameModelAsTurn: options.isSameModelAsTurn })
    },
    new AbortController().signal
  )
  // The recording fetch fails the turn on purpose; the captured body is the artifact.
  await drain(stream).catch(() => undefined)
}

/** Test-side stand-in for `resolveToolCallLimit` — the engine requires the seam's resolved value. */
const TEST_TOOL_CALL_LIMIT = 20

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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-text',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
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

  it('sanitizes execution ids pi cannot use as session ids (seam ids carry "::" separators)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-colons')
    fauxStates.get('exec-colons')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    // First dogfood run: the seam's `${messageId}:${model.id}` id reached
    // SessionManager verbatim and pi rejected the ':' outright.
    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: '6f0a1b2c-3d4e-4f5a-9b8c-7d6e5f4a3b2c:dashscope::deepseek-v3.2',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
        new AbortController().signal
      )
    )

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('uses the chat prompt as the sole system prompt', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-prompt')
    fauxStates.get('exec-prompt')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-noprompt',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-slash',
          provider,
          history: [],
          prompt: userTurn('/help me')
        },
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
      details: { echoed: (params as { q: string }).q }
    }))

    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
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
    // The part payload is the result's `details` (the raw execute output a registry tool
    // hands over), not pi's `{content, details}` envelope.
    expect((toolPart as { output?: unknown }).output).toEqual({ echoed: 'hi' })
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
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-abort',
        provider,
        history: [],
        prompt: userTurn('hi')
      },
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

  it('aborts during the prompt prelude and still closes the turn cleanly', async () => {
    // An abort racing dispatch lands while `session.prompt()` is still in its prelude —
    // pi's `abort()` is a no-op there (no active run), so the engine latches it and
    // re-issues on the first session event; the turn must not run to completion.
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-prelude-abort', {
      tokensPerSecond: 20,
      tokenSize: { min: 30, max: 30 }
    })
    fauxStates
      .get('exec-prelude-abort')!
      .core.setResponses([faux.fauxAssistantMessage('a turn that would have fully streamed')])

    const controller = new AbortController()
    const stream = await streamPiChatTurn(
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-prelude-abort',
        provider,
        history: [],
        prompt: userTurn('hi')
      },
      controller.signal
    )
    // Abort before reading anything: the prompt promise is in its prelude.
    controller.abort()
    const chunks = await drain(stream)
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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-pi-abort',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
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
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-error',
        provider,
        history: [],
        prompt: userTurn('hi')
      },
      new AbortController().signal
    )
    await expect(drain(stream)).rejects.toThrow('provider exploded')
  })

  it('records the usage invocation even for an errored turn', async () => {
    // Legacy's usage hook flushed per-turn usage on error turns too; dropping the row
    // would silently lose billing for exactly the turns users retry.
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-error-usage')
    fauxStates
      .get('exec-error-usage')!
      .core.setResponses([
        faux.fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: 'provider exploded' })
      ])
    const invocations: AgentRuntimeUsageInvocation[] = []

    const stream = await streamPiChatTurn(
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-error-usage',
        provider,
        history: [],
        prompt: userTurn('hi'),
        onInvocation: (invocation) => invocations.push(invocation)
      },
      new AbortController().signal
    )
    await expect(drain(stream)).rejects.toThrow('provider exploded')
    expect(invocations).toHaveLength(1)
    expect(invocations[0].usage).toBeDefined()
  })

  it('does not auto-retry a retryable provider failure (retry has one owner: the host)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-no-retry')
    // A message pi classifies as retryable (rate-limit pattern) — with the session-level
    // auto-retry left at its defaults, this turn would re-prompt up to 3 times.
    fauxStates
      .get('exec-no-retry')!
      .core.setResponses([
        faux.fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: 'Rate limit exceeded' })
      ])

    const stream = await streamPiChatTurn(
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-no-retry',
        provider,
        history: [],
        prompt: userTurn('hi')
      },
      new AbortController().signal
    )
    await expect(drain(stream)).rejects.toThrow('Rate limit exceeded')

    const state = fauxStates.get('exec-no-retry')!
    expect(state.capturedContexts).toHaveLength(1)
  })

  it('reports thinking duration in invocation metrics and feeds the runtime-timing sink for tools', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-timing')
    fauxStates.get('exec-timing')!.core.setResponses([
      (): ReturnType<typeof faux.fauxAssistantMessage> => ({
        ...faux.fauxAssistantMessage([faux.fauxThinking('pondering'), faux.fauxToolCall('echo', { q: 'x' })]),
        responseId: 'resp-timing'
      }),
      faux.fauxAssistantMessage('done')
    ])
    const invocations: AgentRuntimeUsageInvocation[] = []
    const toolStarts: Array<{ callId: string; toolName?: string }> = []
    const toolEnds: Array<{ callId: string; toolName?: string; durationMs: number }> = []

    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: { ok: 1 } }))
    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-timing',
          provider,
          history: [],
          prompt: userTurn('hi'),
          tools: [echoTool(execute)],
          onInvocation: (invocation) => invocations.push(invocation),
          runtimeTimingSink: {
            onToolExecutionStart: (event) => toolStarts.push(event),
            onToolExecutionEnd: (event) => toolEnds.push(event)
          }
        },
        new AbortController().signal
      )
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })

    // The thinking-bearing response's invocation carries a thinking duration (legacy
    // billing semantics: first thinking frame → first content frame).
    const thinkingInvocation = invocations.find((invocation) => invocation.requestId.endsWith('resp-timing'))
    expect(thinkingInvocation?.metrics?.timeThinkingMs).toBeGreaterThanOrEqual(0)
    expect(thinkingInvocation?.metrics?.timeFirstTokenMs).toBeGreaterThanOrEqual(0)

    // The tool execution produced one start/end span pair keyed by the trunk's sink shape.
    expect(toolStarts).toHaveLength(1)
    expect(toolEnds).toHaveLength(1)
    expect(toolStarts[0]).toMatchObject({ toolName: 'echo' })
    expect(toolEnds[0]).toMatchObject({ toolName: 'echo' })
    expect(toolEnds[0].callId).toBe(toolStarts[0].callId)
    expect(toolEnds[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('extracts inline <think> markup into reasoning parts on the openai-completions family', async () => {
    const faux = await importFaux()
    await fauxProviderSource(faux, 'exec-think')
    const state = fauxStates.get('exec-think')!
    // The extraction gate keys on the registered model's api family (faux defaults to
    // 'faux'): register an openai-completions-shaped entry while the core keeps its own
    // model for response synthesis.
    const fauxModel = state.core.models[0]
    const provider: PiChatProviderSource = {
      name: 'faux-chat',
      apiKey: 'test-key',
      modelId: fauxModel.id,
      config: {
        name: 'Faux Chat',
        api: 'openai-completions',
        models: [{ ...fauxModel, api: 'openai-completions' }],
        streamSimple: (_model, context, options) => {
          state.capturedContexts.push(context)
          return state.core.streamSimple(fauxModel, context, options)
        }
      }
    }
    state.core.setResponses([faux.fauxAssistantMessage([faux.fauxText('<think>hidden plan</think>visible answer')])])

    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-think',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
        new AbortController().signal
      )
    )
    const message = await accumulate(chunks)

    const reasoning = message.parts.find((part) => part.type === 'reasoning')
    const text = message.parts.find((part) => part.type === 'text')
    expect((reasoning as { text?: string } | undefined)?.text).toBe('hidden plan')
    expect((text as { text?: string } | undefined)?.text).toBe('visible answer')
  })

  it('keeps literal tags as content on the faux family (gate check)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-no-think')
    fauxStates
      .get('exec-no-think')!
      .core.setResponses([faux.fauxAssistantMessage([faux.fauxText('<think>literal</think>')])])

    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-no-think',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
        new AbortController().signal
      )
    )
    const message = await accumulate(chunks)
    expect(message.parts.some((part) => part.type === 'reasoning')).toBe(false)
    expect((message.parts.find((part) => part.type === 'text') as { text?: string } | undefined)?.text).toBe(
      '<think>literal</think>'
    )
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
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-roundtrip',
          provider,
          history: [],
          prompt: userTurn('q')
        },
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
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
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
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
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
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-preabort',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
        controller.signal
      )
    )

    expect(chunks.map((chunk) => chunk.type)).toEqual(['start'])
    expect(core.getPendingResponseCount()).toBe(1)
  })

  it('finishes a length-truncated turn successfully (legacy parity, gateway maps it)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-length')
    fauxStates.get('exec-length')!.core.setResponses([faux.fauxAssistantMessage('truncated', { stopReason: 'length' })])

    const chunks = await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-length',
          provider,
          history: [],
          prompt: userTurn('hi')
        },
        new AbortController().signal
      )
    )

    // Truncation is not an error: nothing in-app persists or renders finishReason, and
    // the gateway SSE adapters map 'length' to each family's max-tokens vocabulary.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'length' })
  })

  it('fails the turn with the localized cap error when the tool-call limit is reached', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-cap')
    const core = fauxStates.get('exec-cap')!.core
    core.setResponses([
      faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'one' })]),
      faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'two' })]),
      faux.fauxAssistantMessage('should never stream')
    ])
    const execute = vi.fn(async (_id: string, params: unknown) => ({
      content: [{ type: 'text' as const, text: `echoed:${(params as { q: string }).q}` }],
      details: null
    }))

    const stream = await streamPiChatTurn(
      {
        executionId: 'exec-cap',
        provider,
        history: [],
        prompt: userTurn('loop forever'),
        tools: [echoTool(execute)],
        toolCallLimit: 2
      },
      new AbortController().signal
    )
    const chunks: CherryUIMessageChunk[] = []
    const reader = stream.getReader()
    await expect(
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
      })()
    ).rejects.toThrow(/tool-call limit/)

    // The two limit-bounded tool turns executed (results reached the stream); the third
    // model call never happened and no finish chunk landed.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(chunks.filter((chunk) => chunk.type === 'tool-output-available')).toHaveLength(2)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
  })

  it('fails the turn with the branded error when a trusted local tool reports a terminal failure', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-terminal')
    fauxStates
      .get('exec-terminal')!
      .core.setResponses([faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'x' })])])

    const branded = markTrustedLocalToolTerminalFailure({
      terminal: true,
      retryable: false,
      error: 'web search is not configured',
      userMessage: 'Web search is not configured.',
      i18nKey: 'web_search_provider_unavailable'
    })
    const stream = await streamPiChatTurn(
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-terminal',
        provider,
        history: [],
        prompt: userTurn('search'),
        tools: [echoTool(async () => ({ content: [{ type: 'text' as const, text: 'failed' }], details: branded }))]
      },
      new AbortController().signal
    )
    const chunks: CherryUIMessageChunk[] = []
    const reader = stream.getReader()
    const failure = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    })().then(
      () => undefined,
      (error: unknown) => error
    )
    const error = (await failure) as ToolLoopTerminalError
    // The legacy surface: message + i18nKey (serializeError carries it to the renderer's
    // localized error row), no finish chunk, the tool result still streamed.
    expect(error).toBeInstanceOf(ToolLoopTerminalError)
    expect(error.message).toBe('Web search is not configured.')
    expect(error.i18nKey).toBe('web_search_provider_unavailable')
    expect(chunks.some((chunk) => chunk.type === 'tool-output-available')).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
  })

  it('stops a mixed batch at the step boundary after a terminal failure (no further model call)', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-mixed')
    fauxStates.get('exec-mixed')!.core.setResponses([
      // One batch with a branded failure AND a healthy sibling: pi's every-result
      // terminate rule alone would keep the loop alive and burn another model call.
      faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'bad' }), faux.fauxToolCall('echo', { q: 'ok' })]),
      faux.fauxAssistantMessage('model would respond here')
    ])

    const branded = markTrustedLocalToolTerminalFailure({
      terminal: true,
      retryable: false,
      error: 'gone',
      userMessage: 'Search is gone.'
    })
    const execute = vi.fn(async (_id: string, params: unknown) => {
      const { q } = params as { q: string }
      return {
        content: [{ type: 'text' as const, text: `echoed:${q}` }],
        details: q === 'bad' ? branded : null
      }
    })
    const stream = await streamPiChatTurn(
      {
        toolCallLimit: TEST_TOOL_CALL_LIMIT,
        executionId: 'exec-mixed',
        provider,
        history: [],
        prompt: userTurn('search'),
        tools: [echoTool(execute)]
      },
      new AbortController().signal
    )
    const chunks: CherryUIMessageChunk[] = []
    const reader = stream.getReader()
    await expect(
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
      })()
    ).rejects.toThrow('Search is gone.')

    // Both batch results settled (card sees them), the second model call never issued.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(chunks.filter((chunk) => chunk.type === 'tool-output-available')).toHaveLength(2)
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { delta?: string }).delta)
      .join('')
    expect(text).not.toContain('model would respond here')
  })

  it('applies the final-text-block suffix to the prompt only when no images follow the text', async () => {
    const faux = await importFaux()
    const provider = await fauxProviderSource(faux, 'exec-suffix-image')
    fauxStates.get('exec-suffix-image')!.core.setResponses([faux.fauxAssistantMessage('ok')])

    await drain(
      await streamPiChatTurn(
        {
          toolCallLimit: TEST_TOOL_CALL_LIMIT,
          executionId: 'exec-suffix-image',
          provider,
          history: [],
          // pi builds user content as [text, ...images]: with an image, the FINAL block
          // is not text, so the ovms scope applies nothing (converter parity).
          prompt: {
            messageId: 'p1',
            text: 'describe',
            images: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
          },
          userTextSuffix: { text: ' /no_think', scope: 'final-text-block' }
        },
        new AbortController().signal
      )
    )

    const userText = userTextOf(fauxStates.get('exec-suffix-image')!.capturedContexts[0]) ?? ''
    // The tiny fixture image gets a pi-side omission note — the assertion is that no
    // suffix was appended to the text (pi put the note after it, as its own block).
    expect(userText.startsWith('describe')).toBe(true)
    expect(userText).not.toContain('/no_think')
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
    const sameModel = await recordingProviderSource('anthropic-messages', 'claude-x', sameModelBodies)
    await runRecordingTurn({ provider: sameModel, history, isSameModelAsTurn: () => true })

    const foreignBodies: unknown[] = []
    const foreign = await recordingProviderSource('anthropic-messages', 'claude-x', foreignBodies)
    await runRecordingTurn({ provider: foreign, history })

    const assistantContent = (bodies: unknown[]): Array<{ type: string; signature?: string; text?: string }> => {
      const body = bodies[0] as { messages: Array<{ role: string; content: unknown }> }
      return body.messages[1].content as Array<{ type: string; signature?: string; text?: string }>
    }
    expect(assistantContent(sameModelBodies)[0]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-abc' })
    // Without the caller's same-model answer the block rides as text: pi drops the signature.
    expect(assistantContent(foreignBodies)[0]).toEqual({ type: 'text', text: 'plan' })
  })

  it('strips signed thinking from same-model history when the turn disables thinking', async () => {
    // Anthropic rejects a thinking block on a thinking-disabled request, and pi keeps
    // same-model signed blocks unconditionally — so a thinking-off turn must not claim
    // same-model history on that family (cross-model degradation: thinking → text, no
    // signature), even though the caller says the message IS from this model.
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

    const bodies: unknown[] = []
    const provider = await recordingProviderSource('anthropic-messages', 'claude-x', bodies)
    await runRecordingTurn({ provider, history, isSameModelAsTurn: () => true, thinkingLevel: 'off' })

    const body = bodies[0] as { messages: Array<{ role: string; content: unknown }> }
    const content = body.messages[1].content as Array<{ type: string; signature?: string; text?: string }>
    expect(content[0]).toEqual({ type: 'text', text: 'plan' })
    expect(content.some((block) => block.type === 'thinking' || block.signature)).toBe(false)
  })

  it('replays a redacted thinking block as redacted_thinking on the wire', async () => {
    // Both writers: the pi engine stores the opaque payload under `pi.thinkingSignature`
    // with the redacted marker, a legacy AI SDK turn under `anthropic.redactedData` with no
    // visible text. Anthropic only accepts the payload back as a `redacted_thinking` block.
    const history = [
      historyText('u0', 'user', 'earlier question'),
      {
        id: 'a0',
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: '[Reasoning redacted]',
            state: 'done',
            providerMetadata: { pi: { thinkingSignature: 'pi-payload', redacted: true } }
          },
          {
            type: 'reasoning',
            text: '',
            state: 'done',
            providerMetadata: { anthropic: { redactedData: 'legacy-payload' } }
          }
        ]
      } as unknown as CherryUIMessage
    ]

    const bodies: unknown[] = []
    const provider = await recordingProviderSource('anthropic-messages', 'claude-x', bodies)
    await runRecordingTurn({ provider, history, isSameModelAsTurn: () => true })

    const body = bodies[0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
    const assistant = body.messages.find((message) => message.role === 'assistant')!
    expect(
      assistant.content.filter((block) => block.type === 'redacted_thinking' || block.type === 'thinking')
    ).toEqual([
      { type: 'redacted_thinking', data: 'pi-payload' },
      { type: 'redacted_thinking', data: 'legacy-payload' }
    ])
  })

  it('replays google thought signatures on the wire for same-model history only', async () => {
    // Google validates signatures as base64 (TYPE_BYTES) and drops anything else.
    const history = [
      historyText('u0', 'user', 'earlier question'),
      {
        id: 'a0',
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'plan',
            state: 'done',
            providerMetadata: { google: { thoughtSignature: 'c2lnLXI=' } }
          },
          { type: 'text', text: 'earlier answer', providerMetadata: { google: { thoughtSignature: 'c2lnLXQ=' } } }
        ]
      } as unknown as CherryUIMessage
    ]

    const sameModelBodies: unknown[] = []
    const sameModel = await recordingProviderSource('google-generative-ai', 'gemini-x', sameModelBodies)
    await runRecordingTurn({ provider: sameModel, history, isSameModelAsTurn: () => true })

    const foreignBodies: unknown[] = []
    const foreign = await recordingProviderSource('google-generative-ai', 'gemini-x', foreignBodies)
    await runRecordingTurn({ provider: foreign, history })

    /** The model-turn parts of a `contents` payload (the replayed assistant turn). */
    const modelParts = (bodies: unknown[]): Array<Record<string, unknown>> => {
      const body = bodies[0] as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
      return body.contents.find((content) => content.role === 'model')!.parts
    }
    expect(modelParts(sameModelBodies)).toEqual([
      { thought: true, text: 'plan', thoughtSignature: 'c2lnLXI=' },
      { text: 'earlier answer', thoughtSignature: 'c2lnLXQ=' }
    ])
    // Cross-model: both signatures drop and the thinking degrades to a plain text part.
    expect(modelParts(foreignBodies)).toEqual([{ text: 'plan' }, { text: 'earlier answer' }])
  })

  it('reconstructs the openai-responses reasoning item for same-model history only', async () => {
    const history = [
      historyText('u0', 'user', 'earlier question'),
      {
        id: 'a0',
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'plan',
            state: 'done',
            providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-blob' } }
          },
          { type: 'text', text: 'earlier answer' }
        ]
      } as unknown as CherryUIMessage
    ]

    const sameModelBodies: unknown[] = []
    const sameModel = await recordingProviderSource('openai-responses', 'gpt-x', sameModelBodies)
    await runRecordingTurn({ provider: sameModel, history, isSameModelAsTurn: () => true })

    const foreignBodies: unknown[] = []
    const foreign = await recordingProviderSource('openai-responses', 'gpt-x', foreignBodies)
    await runRecordingTurn({ provider: foreign, history })

    const inputItems = (bodies: unknown[]): Array<{ type?: string; role?: string }> => {
      const body = bodies[0] as { input: Array<{ type?: string; role?: string }> }
      return body.input
    }
    // Same-model: the persisted item id + encrypted blob ride back as a reasoning item,
    // between the original user item and the replayed assistant message.
    expect(inputItems(sameModelBodies).slice(1, 3)).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'plan' }],
        encrypted_content: 'enc-blob'
      },
      expect.objectContaining({ type: 'message', role: 'assistant' })
    ])
    // Cross-model: pi drops an unsigned reasoning block entirely rather than degrading it.
    expect(inputItems(foreignBodies).filter((item) => item.type === 'reasoning')).toEqual([])
    expect(inputItems(foreignBodies).some((item) => item.type === 'message' && item.role === 'assistant')).toBe(true)
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
          {
            toolCallLimit: TEST_TOOL_CALL_LIMIT,
            executionId,
            provider,
            history: [],
            prompt: userTurn(text)
          },
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

  describe('tool-call authorization (W4a)', () => {
    /** Drain the stream while answering approval requests as they surface. */
    async function drainWithApprovals(
      stream: ReadableStream<CherryUIMessageChunk>,
      respond: (approvalId: string) => { approved: boolean; reason?: string; updatedInput?: Record<string, unknown> }
    ): Promise<CherryUIMessageChunk[]> {
      const reader = stream.getReader()
      const chunks: CherryUIMessageChunk[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        if (value.type === 'tool-approval-request') {
          const { approved, reason, updatedInput } = respond(value.approvalId)
          toolApprovalRegistry.dispatch(value.approvalId, {
            approved,
            ...(reason !== undefined && { reason }),
            ...(updatedInput !== undefined && { updatedInput })
          })
        }
      }
      return chunks
    }

    /** A gated registry entry + its pi tool + the authorizer, wired like the W6 seam will. */
    function gatedTool(executionId: string, onApprovalResolved?: (toolCallId: string, approved: boolean) => void) {
      const execute = vi.fn(async ({ q }: { q: string }) => ({ echoed: q }))
      const entry = {
        name: 'echo',
        namespace: 'test',
        description: 'Echo',
        defer: 'never' as const,
        tool: {
          description: 'Echo the query back',
          inputSchema: zodToolSchema(z.object({ q: z.string() })),
          needsApproval: true,
          execute
        }
      }
      const surface = toPiChatToolSurface(
        [entry],
        { requestContext: { requestId: `req-${executionId}` } },
        {
          approvalScope: `pi-chat:${executionId}`,
          ...(onApprovalResolved && { onApprovalResolved })
        }
      )
      return { execute, tools: surface.tools, authorizer: surface.authorizer }
    }

    afterEach(() => {
      toolApprovalRegistry.clear('test-cleanup')
    })

    it('pauses on a gated call, executes after approval, and reports the input edit', async () => {
      const faux = await importFaux()
      const provider = await fauxProviderSource(faux, 'exec-approve')
      fauxStates
        .get('exec-approve')!
        .core.setResponses([
          faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
          faux.fauxAssistantMessage('Done')
        ])
      const onApprovalResolved = vi.fn()
      const wiring = gatedTool('exec-approve', onApprovalResolved)

      const chunks = await drainWithApprovals(
        await streamPiChatTurn(
          {
            toolCallLimit: TEST_TOOL_CALL_LIMIT,
            executionId: 'exec-approve',
            provider,
            history: [],
            prompt: userTurn('echo hi'),
            tools: wiring.tools,
            authorizer: wiring.authorizer
          },
          new AbortController().signal
        ),
        () => ({ approved: true, updatedInput: { q: 'edited' } })
      )

      // The approval card surfaced mid-stream; the edited input is what executed.
      expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true)
      expect(wiring.execute).toHaveBeenCalledTimes(1)
      expect(wiring.execute.mock.calls[0]?.[0]).toEqual({ q: 'edited' })
      expect(onApprovalResolved).toHaveBeenCalledWith(expect.any(String), true)
      const message = await accumulate(chunks)
      const toolPart = message.parts.find((part) => part.type === 'dynamic-tool')
      expect(toolPart).toMatchObject({ toolName: 'echo', state: 'output-available' })
      // The corrected input is re-emitted after the decision, so the persisted part (and
      // replay) carries what actually executed — not the original pre-edit arguments.
      expect(toolPart).toMatchObject({ input: { q: 'edited' } })
      // Legacy parity: the persisted part output is the raw execute output, not pi's
      // `{content, details}` envelope the stream adapter projects for pi's own tools.
      expect(toolPart).toMatchObject({ output: { echoed: 'edited' } })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      expect(toolApprovalRegistry.size()).toBe(0)
    })

    it('reports a tool span that excludes the approval wait', async () => {
      // pi emits `tool_execution_start` before the `tool_call` hook, so a raw wall-clock
      // span would bill the user's thinking time to the tool; the collector's contract
      // (and legacy's execute hooks) exclude approval latency.
      let clock = 0
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
      try {
        const faux = await importFaux()
        const provider = await fauxProviderSource(faux, 'exec-wait')
        fauxStates
          .get('exec-wait')!
          .core.setResponses([
            faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
            faux.fauxAssistantMessage('Done')
          ])
        const sink = { onToolExecutionStart: vi.fn(), onToolExecutionEnd: vi.fn() }
        const wiring = gatedTool('exec-wait')
        // The tool itself runs for 200ms of the wall clock (see the assertion below).
        wiring.execute.mockImplementation(async () => {
          clock = 5200
          return { echoed: 'hi' }
        })

        const reader = (
          await streamPiChatTurn(
            {
              toolCallLimit: TEST_TOOL_CALL_LIMIT,
              executionId: 'exec-wait',
              provider,
              history: [],
              prompt: userTurn('echo hi'),
              tools: wiring.tools,
              authorizer: wiring.authorizer,
              runtimeTimingSink: sink
            },
            new AbortController().signal
          )
        ).getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.type === 'tool-approval-request') {
            clock = 5000 // the user thinks for five seconds
            toolApprovalRegistry.dispatch(value.approvalId, { approved: true })
          }
        }

        const reported = sink.onToolExecutionEnd.mock.calls[0]?.[0] as { durationMs: number }
        // 5200ms wall clock minus the 5000ms approval wait — the tool itself took 200ms.
        expect(reported.durationMs).toBe(200)
      } finally {
        nowSpy.mockRestore()
      }
    })

    it('surfaces a denial as tool-output-denied without executing the tool', async () => {
      const faux = await importFaux()
      const provider = await fauxProviderSource(faux, 'exec-deny')
      fauxStates
        .get('exec-deny')!
        .core.setResponses([
          faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
          faux.fauxAssistantMessage('Done')
        ])
      const onApprovalResolved = vi.fn()
      const wiring = gatedTool('exec-deny', onApprovalResolved)

      const chunks = await drainWithApprovals(
        await streamPiChatTurn(
          {
            toolCallLimit: TEST_TOOL_CALL_LIMIT,
            executionId: 'exec-deny',
            provider,
            history: [],
            prompt: userTurn('echo hi'),
            tools: wiring.tools,
            authorizer: wiring.authorizer
          },
          new AbortController().signal
        ),
        () => ({ approved: false, reason: 'not today' })
      )

      // pi reports a blocked call as an error result; the engine translates it to the
      // denial state the renderer card and the history converter expect.
      expect(wiring.execute).not.toHaveBeenCalled()
      expect(chunks.some((chunk) => chunk.type === 'tool-output-denied')).toBe(true)
      expect(chunks.some((chunk) => chunk.type === 'tool-output-error')).toBe(false)
      expect(onApprovalResolved).toHaveBeenCalledWith(expect.any(String), false)
      const message = await accumulate(chunks)
      expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
        state: 'output-denied'
      })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    })

    it('treats an abort-cancelled approval as a cancellation, not a denial', async () => {
      // Legacy cleared pending approvals on abort without writing a denial; a denied
      // state here would persist a refusal the user never made (and the renderer card
      // plus history converter would both read it back as one).
      const faux = await importFaux()
      const provider = await fauxProviderSource(faux, 'exec-abort-approval')
      fauxStates
        .get('exec-abort-approval')!
        .core.setResponses([
          faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
          faux.fauxAssistantMessage('Done')
        ])
      const onApprovalResolved = vi.fn()
      const wiring = gatedTool('exec-abort-approval', onApprovalResolved)

      const controller = new AbortController()
      const reader = (
        await streamPiChatTurn(
          {
            toolCallLimit: TEST_TOOL_CALL_LIMIT,
            executionId: 'exec-abort-approval',
            provider,
            history: [],
            prompt: userTurn('echo hi'),
            tools: wiring.tools,
            authorizer: wiring.authorizer
          },
          controller.signal
        )
      ).getReader()
      const chunks: CherryUIMessageChunk[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        if (value.type === 'tool-approval-request') controller.abort()
      }

      expect(wiring.execute).not.toHaveBeenCalled()
      // Neither a denial NOR pi's blocked-call error may land — the part stays parked on
      // its card, the state `dropUnansweredApprovals` cleans up on replay.
      expect(chunks.some((chunk) => chunk.type === 'tool-output-denied')).toBe(false)
      expect(chunks.some((chunk) => chunk.type === 'tool-output-error')).toBe(false)
      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
      expect(onApprovalResolved).not.toHaveBeenCalled()
      const message = await accumulate(chunks)
      expect(message.parts.find((part) => part.type === 'dynamic-tool')).not.toMatchObject({
        state: 'output-denied'
      })
      expect(toolApprovalRegistry.size()).toBe(0)
    })

    it('does not gate ungated tools', async () => {
      const faux = await importFaux()
      const provider = await fauxProviderSource(faux, 'exec-ungated')
      fauxStates
        .get('exec-ungated')!
        .core.setResponses([
          faux.fauxAssistantMessage([faux.fauxToolCall('echo', { q: 'hi' })]),
          faux.fauxAssistantMessage('Done')
        ])
      const execute = vi.fn(async ({ q }: { q: string }) => ({ echoed: q }))
      const entry = {
        name: 'echo',
        namespace: 'test',
        description: 'Echo',
        defer: 'never' as const,
        tool: {
          description: 'Echo the query back',
          inputSchema: zodToolSchema(z.object({ q: z.string() })),
          execute
        }
      }
      const surface = toPiChatToolSurface(
        [entry],
        { requestContext: { requestId: 'r' } },
        {
          approvalScope: 'pi-chat:exec-ungated'
        }
      )

      const chunks = await drain(
        await streamPiChatTurn(
          {
            toolCallLimit: TEST_TOOL_CALL_LIMIT,
            executionId: 'exec-ungated',
            provider,
            history: [],
            prompt: userTurn('echo hi'),
            tools: surface.tools,
            authorizer: surface.authorizer
          },
          new AbortController().signal
        )
      )

      expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    })
  })
})
