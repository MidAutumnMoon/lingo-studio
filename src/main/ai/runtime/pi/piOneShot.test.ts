import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReasoningEffortOption } from '@shared/types/aiSdk'

import { makeModel, makeProvider } from '../../__tests__/fixtures'
import type { PiDirectProviderInjection } from './modelInjection'
import type * as ModelInjectionModule from './modelInjection'

const { mockResolveInjection, mockWithSessionHeader, mockMaterialize, mockRuntime } = vi.hoisted(() => ({
  mockResolveInjection: vi.fn(),
  mockWithSessionHeader: vi.fn(),
  mockMaterialize: vi.fn(),
  mockRuntime: {
    setRuntimeApiKey: vi.fn(),
    registerProvider: vi.fn(),
    getModel: vi.fn(),
    completeSimple: vi.fn()
  }
}))

vi.mock('./modelInjection', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelInjectionModule>()
  return {
    ...actual,
    resolvePiProviderInjectionFromSnapshot: mockResolveInjection,
    withPiSessionHeader: mockWithSessionHeader,
    materializePiProviderStream: mockMaterialize
  }
})

vi.mock('./piSdk', () => ({
  createIsolatedPiModelRuntime: async () => mockRuntime
}))

import { runPiOneShotText } from './piOneShot'

const PROVIDER = makeProvider({ id: 'prov', name: 'Prov' })
const MODEL = makeModel({ id: 'prov::m', providerId: 'prov', name: 'M' })

function makeInjection(overrides: Partial<PiDirectProviderInjection> = {}): PiDirectProviderInjection {
  return {
    providerName: 'prov',
    api: 'openai-completions',
    apiKey: 'real-key',
    modelId: 'm',
    providerConfig: { name: 'Prov', api: 'openai-completions', apiKey: 'placeholder' },
    usageCapture: { owner: 'agent-sdk', credentialReceipt: { attribution: 'unknown' } },
    ...overrides
  } as PiDirectProviderInjection
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'HELLO' }],
    api: 'openai-completions',
    provider: 'prov',
    model: 'm',
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides
  }
}

const MATERIALIZED = {
  providerConfig: { name: 'Prov', api: 'openai-completions', streamSimple: vi.fn() },
  streamSimple: vi.fn()
}

describe('runPiOneShotText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const injection = makeInjection()
    mockResolveInjection.mockReturnValue(injection)
    mockWithSessionHeader.mockImplementation((inj) => inj)
    mockMaterialize.mockResolvedValue(MATERIALIZED)
    mockRuntime.getModel.mockReturnValue({ id: 'm', provider: 'prov', api: 'openai-completions' })
    mockRuntime.completeSimple.mockResolvedValue(assistantMessage())
  })

  it('resolves the injection from the snapshot and threads an explicit key override', async () => {
    await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      apiKeyOverride: 'explicit-key'
    })
    expect(mockResolveInjection).toHaveBeenCalledWith(PROVIDER, MODEL, undefined, 'explicit-key')
  })

  it('injects the key out-of-band and registers the materialized config on an isolated runtime', async () => {
    await runPiOneShotText({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    expect(mockRuntime.setRuntimeApiKey).toHaveBeenCalledWith('prov', 'real-key')
    expect(mockRuntime.registerProvider).toHaveBeenCalledWith('prov', MATERIALIZED.providerConfig)
    expect(mockRuntime.getModel).toHaveBeenCalledWith('prov', 'm')
  })

  it('stamps the session header only when a session id is given', async () => {
    await runPiOneShotText({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    expect(mockWithSessionHeader).not.toHaveBeenCalled()

    const stamped = makeInjection({ apiKey: 'stamped-key' })
    mockWithSessionHeader.mockReturnValueOnce(stamped)
    await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'topic-1'
    })
    expect(mockWithSessionHeader).toHaveBeenCalledTimes(1)
    expect(mockRuntime.setRuntimeApiKey).toHaveBeenLastCalledWith('prov', 'stamped-key')
  })

  it('sends the system prompt and the transcript, replaying assistant history under the injection identity', async () => {
    await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      systemPrompt: 'be brief',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' }
      ]
    })

    const [modelArg, contextArg, optionsArg] = mockRuntime.completeSimple.mock.calls[0]
    expect(modelArg).toEqual({ id: 'm', provider: 'prov', api: 'openai-completions' })
    expect(contextArg.systemPrompt).toBe('be brief')
    expect(contextArg.messages).toHaveLength(3)
    expect(contextArg.messages[0]).toMatchObject({ role: 'user', content: 'q1' })
    expect(contextArg.messages[1]).toMatchObject({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'prov',
      model: 'm',
      stopReason: 'stop'
    })
    expect(contextArg.messages[2]).toMatchObject({ role: 'user', content: 'q2' })
    expect(optionsArg.signal).toBeUndefined()
    expect('reasoning' in optionsArg).toBe(false)
  })

  it('omits the system prompt entirely when none is given', async () => {
    await runPiOneShotText({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    expect('systemPrompt' in mockRuntime.completeSimple.mock.calls[0][1]).toBe(false)
  })

  it.each<[ReasoningEffortOption | undefined, boolean]>([
    ['none', false],
    ['default', false],
    [undefined, false],
    ['high', true]
  ])('maps reasoning %p to an explicit pi level only for tiers (%p)', async (reasoning, expectsReasoning) => {
    await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      ...(reasoning !== undefined && { reasoning })
    })
    const optionsArg = mockRuntime.completeSimple.mock.calls[0][2]
    expect('reasoning' in optionsArg).toBe(expectsReasoning)
    if (expectsReasoning) expect(optionsArg.reasoning).toBe('high')
  })

  it('forwards the abort signal and rejects before any work when it is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runPiOneShotText({
        provider: PROVIDER,
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(mockResolveInjection).not.toHaveBeenCalled()

    const live = new AbortController()
    await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      signal: live.signal
    })
    expect(mockRuntime.completeSimple.mock.calls[0][2].signal).toBe(live.signal)
  })

  it('assembles text from text blocks only and reports usage inclusive of the cache buckets', async () => {
    mockRuntime.completeSimple.mockResolvedValue(
      assistantMessage({
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: 'part-1 ' },
          { type: 'text', text: 'part-2' }
        ],
        usage: {
          input: 3,
          output: 5,
          cacheRead: 7,
          cacheWrite: 11,
          reasoning: 2,
          totalTokens: 26,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      })
    )
    const result = await runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(result.text).toBe('part-1 part-2')
    expect(result.usage).toEqual({
      inputTokens: 21,
      outputTokens: 5,
      totalTokens: 26,
      noCacheTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      reasoningTokens: 2
    })
    expect(result.injection.modelId).toBe('m')
    expect(result.timeCompletionMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects with the provider error message when the stream stops with an error', async () => {
    mockRuntime.completeSimple.mockResolvedValue(
      assistantMessage({ stopReason: 'error', errorMessage: 'upstream exploded' })
    )
    await expect(
      runPiOneShotText({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('upstream exploded')
  })

  it('rejects with an AbortError when the provider stream was aborted', async () => {
    mockRuntime.completeSimple.mockResolvedValue(assistantMessage({ stopReason: 'aborted' }))
    const promise = runPiOneShotText({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }]
    })
    await expect(promise).rejects.toSatisfy(
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
  })

  it('fails loudly when the registered model cannot be resolved', async () => {
    mockRuntime.getModel.mockReturnValueOnce(undefined)
    await expect(
      runPiOneShotText({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/could not be resolved/)
  })
})
