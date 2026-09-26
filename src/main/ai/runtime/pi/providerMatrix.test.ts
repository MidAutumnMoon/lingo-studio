/**
 * W3 — the chat provider matrix, keyed on `@cherrystudio/provider-registry` endpoint
 * types as the axis (docs/plans/2026-09-pi-unification.md, W3).
 *
 * The matrix is the gate W6's per-execution fallback consults: a chat execution runs
 * on pi exactly when its provider+model resolves a pi api family here. Three layers:
 *
 * 1. The chat-protocol set, derived from the production table (`ENDPOINT_PI_API`).
 *    Endpoint-type classification itself is compile-enforced there: a new
 *    `ENDPOINT_TYPE` member that is not classified fails the typecheck, so this file
 *    does not restate it.
 * 2. Adapter-family refinements within chat endpoint types (azure, bedrock, vertex),
 *    asserted through `mapEndpointToPiApi` — the same mapping `resolvePiApi` applies.
 * 3. A sweep over the registry's own provider data (`data/providers.json`): every
 *    chat endpoint of every preset provider resolves a family, except the explicitly
 *    unsupported list below. A new provider or family that fails to map fails here —
 *    it must be either mapped or added to the unsupported list deliberately.
 *
 * Live spot-checks (one per family, in dev) are the manual half of W3's verification;
 * this file is the mechanical half.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { ENDPOINT_TYPE, type EndpointType } from '@cherrystudio/provider-registry'
import { ENDPOINT_PI_API, resolvePiApi, type PiApi } from '@shared/ai/piModelCompatibility'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { buildPiGatewayInjection, materializePiProviderStream, type PiProviderInjection } from './modelInjection'
import { loadPiApiStreamSimple } from './piSdk'

/** The chat protocols pi drives, each with its pi api family — the production table, filtered. */
const CHAT_ENDPOINT_TO_PI_API = Object.fromEntries(
  Object.entries(ENDPOINT_PI_API).filter((entry): entry is [string, PiApi] => entry[1] !== undefined)
)

describe('pi provider matrix — adapter-family refinements', () => {
  it('maps azure-responses to the azure family and excludes azure chat-completions', () => {
    // Azure speaks a distinct wire (deployment + api-version URL); pi ships only
    // an Azure *responses* family, so plain `openai-completions` would target the
    // wrong URL shape.
    expect(mapWithFamily(ENDPOINT_TYPE.OPENAI_RESPONSES, 'azure-responses')).toBe('azure-openai-responses')
    expect(mapWithFamily(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS, 'azure')).toBeUndefined()
  })

  it('excludes signed-request families pi cannot drive with a key', () => {
    for (const family of ['bedrock', 'google-vertex', 'google-vertex-anthropic']) {
      expect(mapWithFamily(ENDPOINT_TYPE.ANTHROPIC_MESSAGES, family)).toBeUndefined()
      expect(mapWithFamily(ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT, family)).toBeUndefined()
    }
  })

  it('keeps generic openai-compatible families on the chat family', () => {
    // Registry families like mistral/openrouter/deepseek/groq are dialect hints for
    // the AI SDK provider builders, not wire switches: they all ride OpenAI chat.
    for (const family of ['mistral', 'openrouter', 'deepseek', 'groq', 'openai-compatible', 'openai']) {
      expect(mapWithFamily(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS, family)).toBe('openai-completions')
    }
  })
})

function mapWithFamily(endpointType: EndpointType, adapterFamily: string): PiApi | undefined {
  return resolvePiApi(
    { id: 'probe', endpointConfigs: { [endpointType]: { adapterFamily } } } as unknown as Provider,
    modelOn(endpointType)
  )
}

function modelOn(endpointType: EndpointType, id = 'probe-model'): Model {
  return { id, apiModelId: 'probe-model', endpointTypes: [endpointType], capabilities: [] } as unknown as Model
}

describe('pi provider matrix — registry sweep', () => {
  /**
   * Registry chat endpoints with NO pi family. Everything else must resolve —
   * adding an entry here is a deliberate decision, not a fallback.
   */
  const UNSUPPORTED = new Set([
    'azure-openai/openai-chat-completions', // pi has no azure chat-completions family
    'vertexai/google-generate-content', // GCP service-account auth does not fit pi's key model
    'vertexai/anthropic-messages',
    'aws-bedrock/anthropic-messages' // AWS SigV4 signed requests
  ])

  interface RegistryProvider {
    id: string
    name?: string
    defaultChatEndpoint?: string
    authMethods?: string[]
    endpointConfigs?: Record<string, { adapterFamily?: string }>
  }
  const registryProviders: RegistryProvider[] = (
    JSON.parse(
      readFileSync(new URL('../../../../../packages/provider-registry/data/providers.json', import.meta.url), 'utf-8')
    ) as { providers: RegistryProvider[] }
  ).providers

  it('covers every preset provider that declares a chat endpoint', () => {
    const chatEndpoints = Object.keys(CHAT_ENDPOINT_TO_PI_API)
    const seen: string[] = []
    for (const provider of registryProviders) {
      for (const [endpointType, config] of Object.entries(provider.endpointConfigs ?? {})) {
        if (!chatEndpoints.includes(endpointType)) continue
        const key = `${provider.id}/${endpointType}`
        seen.push(key)
        const api = resolvePiApi(
          { ...provider, endpointConfigs: { [endpointType]: config } } as unknown as Provider,
          modelOn(endpointType as EndpointType)
        )
        if (UNSUPPORTED.has(key)) {
          expect(api, `${key} should be unsupported`).toBeUndefined()
        } else {
          // azure-responses refines the responses endpoint onto pi's azure family.
          const expected =
            config.adapterFamily === 'azure-responses'
              ? 'azure-openai-responses'
              : CHAT_ENDPOINT_TO_PI_API[endpointType]
          expect(api, `${key} should map to a pi family`).toEqual(expected)
        }
      }
    }
    // The sweep is only the gate while it actually sweeps: every unsupported entry
    // must exist in the registry data, and the chat-protocol rows must be non-empty.
    for (const key of UNSUPPORTED) expect(seen, `${key} not found in registry data`).toContain(key)
    expect(seen.length).toBeGreaterThan(50)
  })

  it('keeps login-based providers drivable only through their transport adapters', () => {
    // grok-cli and openai-codex hold no app-side key but have per-call OAuth
    // transport adapters, so their responses endpoints map normally.
    for (const id of ['grok-cli', 'openai-codex']) {
      const provider = registryProviders.find((row) => row.id === id) as unknown as Provider
      expect(provider).toBeDefined()
      expect(resolvePiApi(provider, modelOn(ENDPOINT_TYPE.OPENAI_RESPONSES))).toBe('openai-responses')
    }
  })
})

describe('pi provider matrix — family stream materialization', () => {
  /** One injection per pi family, with no provider-declared stream: the builtin must load. */
  function injectionFor(api: PiApi): PiProviderInjection {
    return {
      providerName: 'matrix-probe',
      api,
      providerConfig: {
        name: 'Matrix Probe',
        baseUrl: 'https://probe.invalid',
        apiKey: 'placeholder',
        api,
        models: []
      },
      apiKey: 'test-key',
      modelId: 'probe-model',
      usageCapture: { owner: 'agent-sdk' }
    } as unknown as PiProviderInjection
  }

  it('loads the builtin pi stream for every chat family (loadPiApiStreamSimple mirror)', async () => {
    for (const api of Object.values(CHAT_ENDPOINT_TO_PI_API)) {
      const streamSimple = await loadPiApiStreamSimple(api)
      expect(typeof streamSimple, `${api} builtin stream`).toBe('function')
    }
    // azure rides the responses endpoint, so the full family set is covered by the
    // four chat protocols plus the azure refinement.
    const azure = await loadPiApiStreamSimple('azure-openai-responses')
    expect(typeof azure).toBe('function')
  })

  it('materializes one prepared stream per family without a provider-declared one', async () => {
    for (const api of Object.values(CHAT_ENDPOINT_TO_PI_API)) {
      const materialized = await materializePiProviderStream(injectionFor(api))
      expect(typeof materialized.streamSimple, `${api} prepared stream`).toBe('function')
      expect(materialized.providerConfig.streamSimple).toBe(materialized.streamSimple)
    }
  })

  it('keeps the google family off customFetch (pi-ai rejects it)', async () => {
    const inner = vi.fn(() => {
      throw new Error('inner stream reached')
    })
    const injection = injectionFor('google-generative-ai')
    injection.providerConfig = {
      ...injection.providerConfig,
      streamSimple: inner
    }
    const materialized = await materializePiProviderStream(injection)

    expect(() => materialized.streamSimple({ provider: 'p', id: 'm' } as never, { messages: [] } as never, {})).toThrow(
      'inner stream reached'
    )
    // The Google adapter drives @google/genai's own client and hard-rejects a custom
    // fetch, so the prepared stream must not attach one (proxy gap recorded in W5).
    const options = (inner.mock.calls[0] as unknown[])[2] as Record<string, unknown>
    expect(options).not.toHaveProperty('fetch')
  })
})

describe('pi provider matrix — gateway routing parity', () => {
  /** Cherry Cloud rides the local gateway while preserving the model's wire protocol. */
  const gateway = { baseUrl: 'http://127.0.0.1:23333/v1', apiKey: 'gateway-key', usageHeaders: { 'x-session': 's1' } }

  function providerWithChatEndpoint(endpointType: EndpointType, adapterFamily?: string): Provider {
    return {
      id: 'cherry-cloud',
      name: 'Cherry Cloud',
      endpointConfigs: { [endpointType]: { adapterFamily, baseUrl: 'https://probe.invalid' } }
    } as unknown as Provider
  }

  it('routes every chat family through the gateway with its own wire protocol', () => {
    const cases: Array<[EndpointType, PiApi, string?]> = [
      [ENDPOINT_TYPE.ANTHROPIC_MESSAGES, 'anthropic-messages'],
      [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS, 'openai-completions'],
      [ENDPOINT_TYPE.OPENAI_RESPONSES, 'openai-responses'],
      [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT, 'google-generative-ai'],
      [ENDPOINT_TYPE.OPENAI_RESPONSES, 'azure-openai-responses', 'azure-responses']
    ]
    for (const [endpointType, expectedApi, family] of cases) {
      const injection = buildPiGatewayInjection(
        providerWithChatEndpoint(endpointType, family),
        modelOn(endpointType),
        gateway
      )
      expect(injection.api, `${endpointType} via gateway`).toBe(expectedApi)
      expect(injection.providerConfig.api).toBe(expectedApi)
      expect(injection.providerConfig.baseUrl).toContain('127.0.0.1:23333')
      expect(injection.modelId).toContain('cherry-cloud:probe-model')
      expect(injection.usageCapture).toEqual({ owner: 'provider-calls' })
    }
  })

  it('carries the gateway usage headers onto the provider config', () => {
    const injection = buildPiGatewayInjection(
      providerWithChatEndpoint(ENDPOINT_TYPE.ANTHROPIC_MESSAGES),
      modelOn(ENDPOINT_TYPE.ANTHROPIC_MESSAGES),
      gateway
    )
    expect(injection.providerConfig.headers).toEqual(gateway.usageHeaders)
  })
})
