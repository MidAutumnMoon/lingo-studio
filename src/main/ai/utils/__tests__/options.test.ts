import { createOpenAI } from '@ai-sdk/openai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { generateText } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import { ENDPOINT_TYPE, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import {
  applyFastModeToProviderOptions,
  buildResolvedReasoningProviderOptions,
  extractAiSdkStandardParams
} from '../options'
import type { ResolvedReasoningInvocation } from '../reasoningSerializers'

describe('applyFastModeToProviderOptions', () => {
  const provider = {
    fastMode: { transport: 'openai-priority' }
  } satisfies Pick<Provider, 'fastMode'>
  const model = {
    id: 'openai-codex::gpt-5-6-sol',
    providerId: 'openai-codex',
    name: 'GPT-5.6 Sol',
    capabilities: [],
    supportsStreaming: true,
    supportsFastMode: true,
    isEnabled: true,
    isHidden: false
  } satisfies Model

  it('maps Fast to priority only for an eligible provider-model pair', () => {
    expect(applyFastModeToProviderOptions(provider, model, { openai: { reasoningEffort: 'high' } }, true)).toEqual({
      openai: { reasoningEffort: 'high', serviceTier: 'priority' }
    })
    expect(applyFastModeToProviderOptions(provider, { ...model, supportsFastMode: false }, {}, true)).toEqual({})
    expect(applyFastModeToProviderOptions(provider, model, {}, false)).toEqual({})
  })

  it('honours a provider-declared service tier value (Ark asks for fast, not priority)', () => {
    expect(
      applyFastModeToProviderOptions(
        { fastMode: { transport: 'openai-priority', serviceTier: 'fast' } },
        model,
        {},
        true
      )
    ).toEqual({ openai: { serviceTier: 'fast' } })
  })
})

describe('extractAiSdkStandardParams', () => {
  it('routes AI-SDK standard params to standardParams, others to providerParams', () => {
    const input = {
      topK: 40,
      frequencyPenalty: 0.5,
      stopSequences: ['END'],
      seed: 42,
      reasoningEffort: 'high',
      customFlag: true
    }
    const { standardParams, providerParams } = extractAiSdkStandardParams(input)
    expect(standardParams).toEqual({
      topK: 40,
      frequencyPenalty: 0.5,
      stopSequences: ['END'],
      seed: 42
    })
    expect(providerParams).toEqual({
      reasoningEffort: 'high',
      customFlag: true
    })
  })

  it('returns empty maps for empty input', () => {
    const { standardParams, providerParams } = extractAiSdkStandardParams({})
    expect(standardParams).toEqual({})
    expect(providerParams).toEqual({})
  })

  it('treats unknown keys as provider params (forward-compat)', () => {
    const { standardParams, providerParams } = extractAiSdkStandardParams({ futureField: 'xyz' })
    expect(standardParams).toEqual({})
    expect(providerParams).toEqual({ futureField: 'xyz' })
  })
})

describe('OpenAI-compatible reasoning normalization', () => {
  it.each([
    ['openai-compatible', 'relay'],
    ['google-vertex-maas', 'vertex'],
    ['aihubmix', 'aihubmix'],
    ['dmxapi', 'openai']
  ] as const)(
    'normalizes %s reasoning into the concrete provider namespace',
    (runtimeProviderId, providerOptionsKey) => {
      const endpointType = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
      const reasoning: ResolvedReasoningInvocation = {
        kind: 'effort',
        selection: 'high',
        effort: 'high',
        emissions: [{ target: 'reasoning_effort', value: 'high' }]
      }
      const resolvedOptions = buildResolvedReasoningProviderOptions({
        aiSdkProviderId: runtimeProviderId,
        providerOptionsKey,
        endpointType,
        reasoning
      })

      expect(resolvedOptions).toMatchObject({ [providerOptionsKey]: { reasoningEffort: 'high' } })
      expect(resolvedOptions[providerOptionsKey].reasoning_effort).toBeUndefined()
    }
  )

  it.each(['none', 'high'] as const)('serializes custom Responses reasoning effort %s on the wire', async (effort) => {
    const reasoning: ResolvedReasoningInvocation = {
      kind: effort === 'none' ? 'off' : 'effort',
      selection: effort,
      ...(effort === 'high' ? { effort } : {}),
      emissions: [{ target: 'reasoningEffort', value: effort }]
    }
    const providerOptions = buildResolvedReasoningProviderOptions({
      aiSdkProviderId: 'openai',
      providerOptionsKey: 'openai',
      endpointType: ENDPOINT_TYPE.OPENAI_RESPONSES,
      reasoning
    })
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            created_at: 1,
            model: 'deepseek-v4-flash',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
            incomplete_details: null,
            service_tier: null
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    const openai = createOpenAI({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch })

    await generateText({
      model: openai.responses('deepseek-v4-flash'),
      prompt: 'ping',
      providerOptions: providerOptions as ProviderOptions
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.reasoning).toEqual({ effort })
  })
})
