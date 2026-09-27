/**
 * W6 seam contract: the per-execution gate (flag + matrix exclusions + provider
 * injection) and the request→engine-input preparation. The engine itself is
 * mocked here (its own suite covers it against the faux provider); these tests
 * assert the SHAPE the seam hands over — sliced prompt, knobs, truncation
 * gating, accounting, approval wiring.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { makeAssistant, makeModel, makeProvider } from '../../__tests__/fixtures'

const { mockPreferenceGet, mockResolveToolApproval, mockTrackTokenUsage, mockRecordInvocation } = vi.hoisted(() => ({
  mockPreferenceGet: vi.fn(),
  mockResolveToolApproval: vi.fn(),
  mockTrackTokenUsage: vi.fn(),
  mockRecordInvocation: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'PreferenceService') return { get: mockPreferenceGet }
      if (name === 'AiStreamManager') return { resolveToolApproval: mockResolveToolApproval }
      if (name === 'AnalyticsService') return { trackTokenUsage: mockTrackTokenUsage }
      throw new Error(`Unexpected service: ${name}`)
    }
  }
}))

vi.mock('@data/services/AiUsageRecordService', () => ({
  aiUsageRecordService: { recordInvocation: mockRecordInvocation }
}))

const {
  mockStreamPiChatTurn,
  mockResolveInjection,
  mockMaterialize,
  mockUsesPiGateway,
  mockResolvePlan,
  mockAssembleSystemPrompt,
  mockToolSurface,
  mockPrepareChatMessages
} = vi.hoisted(() => ({
  mockStreamPiChatTurn: vi.fn(),
  mockResolveInjection: vi.fn(),
  mockMaterialize: vi.fn(),
  mockUsesPiGateway: vi.fn(),
  mockResolvePlan: vi.fn(),
  mockAssembleSystemPrompt: vi.fn(),
  mockToolSurface: vi.fn(),
  mockPrepareChatMessages: vi.fn()
}))

vi.mock('./chatEngine', () => ({ streamPiChatTurn: mockStreamPiChatTurn }))
vi.mock('./chatToolSurface', () => ({ toPiChatToolSurface: mockToolSurface }))
vi.mock('../aiSdk/params/assembleSystemPrompt', () => ({ assembleSystemPrompt: mockAssembleSystemPrompt }))
vi.mock('@main/ai/chatTurnPlan', () => ({ resolveChatTurnPlan: mockResolvePlan }))
vi.mock('../../messages/attachmentRouting', () => ({ prepareChatMessages: mockPrepareChatMessages }))
vi.mock('../pi/modelInjection', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof modelInjectionModule
  return {
    ...actual,
    resolvePiProviderInjectionFromSnapshot: mockResolveInjection,
    materializePiProviderStream: mockMaterialize,
    usesPiGateway: mockUsesPiGateway
  }
})

import type * as modelInjectionModule from '../pi/modelInjection'
import { PiMissingApiKeyError, PiUnsupportedProviderError } from '../pi/modelInjection'
import { tryStreamPiChatTurn } from './chatTurnSeam'

const INJECTION = {
  providerName: 'test-provider',
  api: 'openai-completions',
  apiKey: 'real-key',
  modelId: 'test-model',
  providerConfig: { name: 'Test', api: 'openai-completions' },
  usageCapture: { owner: 'agent-sdk', credentialReceipt: { attribution: 'unknown' } }
}

const MATERIALIZED = {
  providerConfig: {
    name: 'Test',
    api: 'openai-completions',
    models: [{ id: 'test-model', maxTokens: 4096 }],
    streamSimple: async () => {}
  },
  streamSimple: async () => {}
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    endpointType: 'openai-chat-completions',
    retained: { fileAttachments: [], persistedOutputPaths: new Set<string>() },
    fileAttachments: [],
    hasFileAttachments: false,
    hasPersistedOutputs: false,
    contextSettings: {
      enabled: true,
      truncateThreshold: 100_000,
      maxMessages: null,
      compress: { enabled: false, modelId: null, thresholdPercent: 50 }
    },
    compressionModel: null,
    toolCallLimit: 20,
    canOffloadToolOutputs: false,
    knowledgeBaseIds: [],
    canConsumeTools: true,
    mcpToolIds: new Set<string>(),
    mcpResourceServerIds: new Set<string>(),
    webToolRoutes: { webSearch: 'none', webFetch: 'none' },
    selectedEntries: [],
    hasCitableTools: false,
    requestedSelection: 'default',
    hasExplicitReasoningEffort: false,
    reasoningInvocation: { kind: 'omit', selection: 'default', emissions: [] },
    reasoningProfile: { wire: {}, support: null },
    requestedMaxOutputTokens: undefined,
    customParameters: { standardParams: {}, providerParams: {} },
    ...overrides
  }
}

function seamInput(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      conversation: { id: 'c1', topicId: 'topic-1' },
      trigger: 'submit-message',
      messageId: 'anchor-1',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'earlier' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'the question' }] }
      ],
      ...overrides
    },
    signal: new AbortController().signal,
    provider: makeProvider(),
    model: makeModel({ id: 'test-provider::test-model', providerId: 'test-provider', apiModelId: 'test-model' }),
    assistant: undefined
  } as never as Parameters<typeof tryStreamPiChatTurn>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPreferenceGet.mockReturnValue(false)
  mockUsesPiGateway.mockReturnValue(false)
  mockResolveInjection.mockReturnValue(INJECTION)
  mockMaterialize.mockResolvedValue(MATERIALIZED)
  mockResolvePlan.mockResolvedValue(makePlan())
  mockAssembleSystemPrompt.mockResolvedValue('SYS')
  mockStreamPiChatTurn.mockResolvedValue(new ReadableStream({ start: () => {} }))
  // Passthrough by default: the seam's own extraction sees the raw list; tests
  // that pin the routing CONTEXT assert on the captured ctx instead.
  mockPrepareChatMessages.mockImplementation(async (messages: unknown[]) => messages)
})

describe('pi chat seam gate', () => {
  it('returns null without resolving anything while the flag is off', async () => {
    expect(await tryStreamPiChatTurn(seamInput())).toBeNull()
    expect(mockResolveInjection).not.toHaveBeenCalled()
    expect(mockStreamPiChatTurn).not.toHaveBeenCalled()
  })

  it('falls back to legacy on an unsupported provider', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolveInjection.mockImplementation(() => {
      throw new PiUnsupportedProviderError('vertexai')
    })
    expect(await tryStreamPiChatTurn(seamInput())).toBeNull()
    expect(mockStreamPiChatTurn).not.toHaveBeenCalled()
  })

  it('falls back to legacy on a missing API key', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolveInjection.mockImplementation(() => {
      throw new PiMissingApiKeyError('test-provider')
    })
    expect(await tryStreamPiChatTurn(seamInput())).toBeNull()
  })

  it('falls back to legacy for a non-streaming assistant', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput()
    input.assistant = makeAssistant({ settings: { streamOutput: false } })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
    expect(mockResolveInjection).not.toHaveBeenCalled()
  })

  it('falls back to legacy for approval-resume dispatches (assistant-terminated history)', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput({
      trigger: 'continue-conversation',
      messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] }]
    })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
  })

  it('falls back to legacy when the served list does not end with a user message', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
        { id: 'a1', role: 'assistant', parts: [] }
      ]
    })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
  })

  it('falls back to legacy for gateway client-tool requests', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput({ callOverrides: { tools: { external: {} } } })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
  })

  it('falls back to legacy for an API-key override (not represented in the pi injection)', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput({ apiKeyOverride: 'sk-override' })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
  })

  it('falls back to legacy on huggingface (reasoning-replay hard 400)', async () => {
    mockPreferenceGet.mockReturnValue(true)
    const input = seamInput()
    input.provider = makeProvider({ id: 'huggingface' })
    expect(await tryStreamPiChatTurn(input)).toBeNull()
  })

  it('falls back to legacy on gateway-routed providers', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockUsesPiGateway.mockReturnValue(true)
    expect(await tryStreamPiChatTurn(seamInput())).toBeNull()
  })

  it('fails the turn (no fallback) when the shared plan rejects', async () => {
    // Recorded boundary: everything before the engine call is pre-provider-request, and
    // silent fallback there would mask engine bugs during dogfood. Nothing pins this —
    // a broadened catch would silently convert engine bugs into legacy fallbacks.
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockRejectedValue(new Error('plan boom'))
    await expect(tryStreamPiChatTurn(seamInput())).rejects.toThrow('plan boom')
    expect(mockStreamPiChatTurn).not.toHaveBeenCalled()
  })

  it('fails the turn (no fallback) when the provider injection throws a non-matrix error', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolveInjection.mockImplementation(() => {
      throw new Error('injection boom')
    })
    await expect(tryStreamPiChatTurn(seamInput())).rejects.toThrow('injection boom')
  })
})

describe('pi chat seam preparation', () => {
  const entry = { name: 'web_search' }

  beforeEach(() => {
    mockPreferenceGet.mockReturnValue(true)
  })

  it('slices the trailing user message into the prompt and history', async () => {
    await tryStreamPiChatTurn(seamInput())
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    expect(engineRequest.prompt).toEqual({ messageId: 'u2', text: 'the question' })
    expect(engineRequest.history).toEqual([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'earlier' }] }])
    expect(engineRequest.systemPrompt).toBe('SYS')
    expect(engineRequest.executionId).toBe('anchor-1:test-provider::test-model')
  })

  it('extracts base64 images from the trailing user message', async () => {
    const input = seamInput({
      messages: [
        {
          id: 'u9',
          role: 'user',
          parts: [
            { type: 'text', text: 'describe' },
            { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aGk=' }
          ]
        }
      ]
    })
    input.model = makeModel({
      id: 'test-provider::test-model',
      providerId: 'test-provider',
      apiModelId: 'test-model',
      capabilities: ['image-recognition']
    })
    await tryStreamPiChatTurn(input)
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    expect(engineRequest.prompt.images).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }])
  })

  it('passes the plan tool-call limit and provider source through, patching the request output cap', async () => {
    mockResolvePlan.mockResolvedValue(makePlan({ toolCallLimit: 7, requestedMaxOutputTokens: 2048 }))
    await tryStreamPiChatTurn(seamInput())
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    expect(engineRequest.toolCallLimit).toBe(7)
    expect(engineRequest.provider).toEqual({
      name: 'test-provider',
      apiKey: 'real-key',
      modelId: 'test-model',
      config: expect.objectContaining({
        models: [{ id: 'test-model', maxTokens: 2048 }]
      })
    })
  })

  it('leaves the model-level output cap untouched when the request sets none', async () => {
    await tryStreamPiChatTurn(seamInput())
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    expect(engineRequest.provider.config.models).toEqual([{ id: 'test-model', maxTokens: 4096 }])
  })

  it('omits the truncation knob when context settings are disabled', async () => {
    mockResolvePlan.mockResolvedValue(
      makePlan({
        selectedEntries: [entry],
        contextSettings: {
          enabled: false,
          truncateThreshold: 100_000,
          maxMessages: null,
          compress: { enabled: false, modelId: null, thresholdPercent: 50 }
        }
      })
    )
    await tryStreamPiChatTurn(seamInput())
    expect(mockToolSurface.mock.calls[0][1].requestContext.toolResultTruncation).toBeUndefined()
  })

  it('omits the truncation knob for caller-owned context (the gateway)', async () => {
    mockResolvePlan.mockResolvedValue(makePlan({ selectedEntries: [entry] }))
    const input = seamInput({ contextOwner: 'caller' })
    await tryStreamPiChatTurn(input)
    expect(mockToolSurface.mock.calls[0][1].requestContext.toolResultTruncation).toBeUndefined()
  })

  it('passes the truncation knob with the legacy offload gate when context build is on', async () => {
    mockResolvePlan.mockResolvedValue(makePlan({ selectedEntries: [entry], canOffloadToolOutputs: true }))
    await tryStreamPiChatTurn(seamInput())
    const truncation = mockToolSurface.mock.calls[0][1].requestContext.toolResultTruncation
    expect(truncation).toBeDefined()
    expect(truncation.canOffload).toBe(true)
    // min(configured 100k, window-derived budget) — a window-less fixture falls back to the configured cap.
    expect(truncation.thresholdChars).toBe(100_000)
  })

  it('hands the tool surface one selection and wires approval resolution to the stream manager', async () => {
    mockResolvePlan.mockResolvedValue(
      makePlan({ selectedEntries: [entry], hasCitableTools: true, mcpToolIds: new Set(['srv/tool']) })
    )
    mockToolSurface.mockReturnValue({ tools: [], authorizer: vi.fn() })
    await tryStreamPiChatTurn(seamInput())
    const [entries, context, approval] = mockToolSurface.mock.calls[0]
    expect(entries).toEqual([entry])
    expect(context.requestContext.toolOutputCharCap).toBe(100_000)
    expect(context.requestContext.persistedOutputPaths).toEqual(new Set())
    approval.onApprovalResolved('call-9', true)
    expect(mockResolveToolApproval).toHaveBeenCalledWith('topic-1', 'call-9', true)
  })

  it('falls back to legacy when web search is server-routed (provider-native search has no pi surface)', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockResolvedValue(makePlan({ webToolRoutes: { webSearch: 'server', webFetch: 'none' } }))
    expect(await tryStreamPiChatTurn(seamInput())).toBeNull()
    expect(mockStreamPiChatTurn).not.toHaveBeenCalled()
    // The route is only final after the plan resolves — the exclusion must not re-derive it.
    expect(mockResolvePlan).toHaveBeenCalled()
  })

  it('passes the request-level output cap into the materialized config and the stream options', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockResolvedValue(makePlan({ requestedMaxOutputTokens: 4321 }))
    await tryStreamPiChatTurn(seamInput())
    const config = mockStreamPiChatTurn.mock.calls[0][0].provider.config
    expect(config.models.find((entry: { id: string }) => entry.id === 'test-model').maxTokens).toBe(4321)
    // The wire half: 4 of 5 adapters gate the cap on `options.maxTokens`, which the
    // session loop never sets — the materialized stream must carry it.
    expect(mockMaterialize.mock.calls[0][1]).toMatchObject({ maxTokens: 4321 })
  })

  it('derives the sampling tail with legacy precedence: shared gates, custom params override, wire aliases', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockResolvedValue(
      makePlan({
        reasoningInvocation: { kind: 'omit', selection: 'default', emissions: [] },
        customParameters: {
          standardParams: { topP: 0.8, topK: 3, stopSequences: ['\nEND'] },
          providerParams: {}
        }
      })
    )
    const input = seamInput()
    input.assistant = makeAssistant({
      settings: { enableTemperature: true, temperature: 0.5, enableTopP: true, topP: 0.9 }
    })
    await tryStreamPiChatTurn(input)
    expect(mockMaterialize.mock.calls[0][1]).toEqual({
      temperature: 0.5,
      // The custom topP overrides the gated setting (legacy spreads custom params last);
      // the rest of the standard vocabulary rides pi's samplingParams by wire alias.
      samplingParams: { top_p: 0.8, top_k: 3, stop: ['\nEND'] }
    })
  })

  it('hands no stream options when nothing was resolved', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockResolvedValue(makePlan())
    await tryStreamPiChatTurn(seamInput())
    expect(mockMaterialize.mock.calls[0][1]).toBeUndefined()
  })

  it('fails the turn when the output-cap patch finds no matching model entry', async () => {
    mockPreferenceGet.mockReturnValue(true)
    mockResolvePlan.mockResolvedValue(makePlan({ requestedMaxOutputTokens: 4321 }))
    mockMaterialize.mockResolvedValue({
      ...MATERIALIZED,
      providerConfig: {
        ...MATERIALIZED.providerConfig,
        models: [{ id: 'other-model', maxTokens: 4096 }]
      }
    })
    // A silent no-op here is the exact inert-cap bug the patch exists to fix.
    await expect(tryStreamPiChatTurn(seamInput())).rejects.toThrow('no model entry')
  })

  it('maps reasoning selections onto pi thinking levels', async () => {
    mockResolvePlan.mockResolvedValue(
      makePlan({ reasoningInvocation: { kind: 'effort', selection: 'high', emissions: [] } })
    )
    await tryStreamPiChatTurn(seamInput())
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBe('high')

    mockStreamPiChatTurn.mockClear()
    mockResolvePlan.mockResolvedValue(
      makePlan({ reasoningInvocation: { kind: 'off', selection: 'none', emissions: [] } })
    )
    await tryStreamPiChatTurn(seamInput())
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBe('off')

    // `auto` means thinking ON in Cherry's profiles — pi gets an explicit `medium`, never
    // an absent level (pi seeds absent to its own `medium` default, which would silently
    // enable thinking for omit-kind turns too).
    mockStreamPiChatTurn.mockClear()
    mockResolvePlan.mockResolvedValue(
      makePlan({
        reasoningInvocation: {
          kind: 'auto',
          selection: 'auto',
          emissions: [{ target: 'reasoningEffort', value: 'medium' }]
        }
      })
    )
    await tryStreamPiChatTurn(seamInput())
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBe('medium')

    // omit on a non-anthropic family stays absent (recorded residual: pi's medium default
    // vs legacy's provider default on google/qwen/openai tiered vocabularies).
    mockStreamPiChatTurn.mockClear()
    mockResolvePlan.mockResolvedValue(makePlan())
    await tryStreamPiChatTurn(seamInput())
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBeUndefined()

    // omit on anthropic = legacy's "no thinking param" = disabled: explicit `off`, which
    // is faithful AND expressible there (the model declares `none`).
    mockStreamPiChatTurn.mockClear()
    mockResolveInjection.mockReturnValue({ ...INJECTION, api: 'anthropic-messages' })
    await tryStreamPiChatTurn({
      ...seamInput(),
      model: makeModel({ reasoning: { selectableEfforts: ['none'] } })
    })
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBe('off')

    // …but a tiered vocabulary without `none` cannot express `off` — pi would clamp it UP
    // to the lowest tier (thinking silently on), so the level stays absent.
    mockStreamPiChatTurn.mockClear()
    await tryStreamPiChatTurn({
      ...seamInput(),
      model: makeModel({ reasoning: { selectableEfforts: ['low', 'high'] } })
    })
    expect(mockStreamPiChatTurn.mock.calls[0][0].thinkingLevel).toBeUndefined()
    mockResolveInjection.mockReturnValue(INJECTION)
  })

  it('records usage invocations with chat attribution and analytics', async () => {
    const input = seamInput({ tokenUsageSource: 'chat' })
    await tryStreamPiChatTurn(input)
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    const usage = { inputTokens: 3, outputTokens: 5 }
    engineRequest.onInvocation({
      requestId: 'pi-chat:anchor-1:test-provider::test-model:r1',
      model: 'test-model',
      messageAssociation: 'current-turn',
      usage,
      metrics: { timeFirstTokenMs: 10 }
    })
    expect(mockRecordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'pi-chat:anchor-1:test-provider::test-model:r1',
        modality: 'language',
        usage,
        metrics: { timeFirstTokenMs: 10 }
      })
    )
    const recorded = mockRecordInvocation.mock.calls[0][0]
    expect(recorded.context.messageRef).toEqual({ kind: 'chat', id: 'anchor-1' })
    expect(recorded.context.modelId).toBe('test-model')
    expect(mockTrackTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'test-provider', input_tokens: 3, output_tokens: 5, source: 'chat' })
    )
  })

  it('does not touch the engine when no tools are selected', async () => {
    await tryStreamPiChatTurn(seamInput())
    expect(mockToolSurface).not.toHaveBeenCalled()
    const engineRequest = mockStreamPiChatTurn.mock.calls[0][0]
    expect(engineRequest.tools).toBeUndefined()
    expect(engineRequest.authorizer).toBeUndefined()
  })

  it('answers same-model replay only for messages stamped with this turn UniqueModelId', async () => {
    await tryStreamPiChatTurn(seamInput())
    const { isSameModelAsTurn } = mockStreamPiChatTurn.mock.calls[0][0]
    // Signature replay silently degrades to text if this predicate ever loosens.
    expect(isSameModelAsTurn({ metadata: { modelId: 'test-provider::test-model' } })).toBe(true)
    expect(isSameModelAsTurn({ metadata: { modelId: 'other::model' } })).toBe(false)
    expect(isSameModelAsTurn({})).toBe(false)
  })

  it('pins pi native attachment support to vision-only images', async () => {
    await tryStreamPiChatTurn(seamInput())
    expect(mockPrepareChatMessages.mock.calls[0][1].nativeSupport).toEqual({
      image: false,
      pdf: false,
      audio: false,
      video: false
    })

    mockPrepareChatMessages.mockClear()
    const input = seamInput()
    input.model = makeModel({
      id: 'test-provider::test-model',
      providerId: 'test-provider',
      apiModelId: 'test-model',
      capabilities: ['image-recognition']
    })
    await tryStreamPiChatTurn(input)
    expect(mockPrepareChatMessages.mock.calls[0][1].nativeSupport).toEqual({
      image: true,
      pdf: false,
      audio: false,
      video: false
    })
  })

  it('resolves the thinking suffix from MCP-only tool counts, and not at all for omitted reasoning', async () => {
    const input = seamInput()
    input.provider = makeProvider({ id: 'nvidia' })
    input.model = makeModel({
      id: 'nvidia::qwen3-235b-a22b',
      providerId: 'nvidia',
      apiModelId: 'qwen3-235b-a22b',
      capabilities: [],
      reasoning: { thinkingTokenLimits: { min: 0, max: 1000 } } as never
    })
    mockResolvePlan.mockResolvedValue(
      makePlan({
        reasoningInvocation: { kind: 'auto', selection: 'auto', emissions: [] },
        mcpToolIds: new Set(['srv/tool'])
      })
    )
    await tryStreamPiChatTurn(input)
    expect(mockStreamPiChatTurn.mock.calls[0][0].userTextSuffix).toBeUndefined()

    mockStreamPiChatTurn.mockClear()
    input.assistant = makeAssistant({})
    mockResolvePlan.mockResolvedValue(
      makePlan({ reasoningInvocation: { kind: 'auto', selection: 'auto', emissions: [] } })
    )
    await tryStreamPiChatTurn(input)
    expect(mockStreamPiChatTurn.mock.calls[0][0].userTextSuffix).toEqual({
      text: ' /think',
      scope: 'every-text-part'
    })

    mockStreamPiChatTurn.mockClear()
    mockResolvePlan.mockResolvedValue(
      makePlan({ reasoningInvocation: { kind: 'omit', selection: 'default', emissions: [] } })
    )
    await tryStreamPiChatTurn(input)
    expect(mockStreamPiChatTurn.mock.calls[0][0].userTextSuffix).toBeUndefined()
  })
})
