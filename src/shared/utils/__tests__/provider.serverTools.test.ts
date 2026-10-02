import { describe, expect, it } from 'vitest'

import { ENDPOINT_TYPE, type Model, MODEL_CAPABILITY, SERVER_TOOL } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { isBuiltinWebSearchAvailable, isServerToolModelEligible, resolveWebToolRoutes } from '@shared/utils/provider'

const model = (apiModelId: string, overrides: Partial<Model> = {}): Model => ({
  id: `provider::${apiModelId}`,
  providerId: 'provider',
  apiModelId,
  name: apiModelId,
  capabilities: [],
  supportsStreaming: true,
  isEnabled: true,
  isHidden: false,
  ...overrides
})

const provider = (modelScope: 'all-chat-models' | 'model-dependent', id = 'anthropic'): Provider =>
  ({ id, serverTools: [{ id: SERVER_TOOL.WEB_SEARCH, modelScope }] }) as Provider

describe('server-tool model eligibility', () => {
  it('uses generated registry eligibility without a generic model capability', () => {
    const claude = model('claude-sonnet-4-6')

    expect(claude.capabilities).not.toContain('web-search')
    expect(isServerToolModelEligible(claude, { id: 'anthropic' }, SERVER_TOOL.WEB_SEARCH)).toBe(true)
    expect(isBuiltinWebSearchAvailable(claude, provider('model-dependent'))).toBe(true)
  })

  it('keeps unknown custom models ineligible for model-dependent tools', () => {
    const custom = model('private-model')

    expect(isBuiltinWebSearchAvailable(custom, provider('model-dependent'))).toBe(false)
    expect(isBuiltinWebSearchAvailable(custom, { id: 'custom', serverTools: [] })).toBe(false)
  })

  it.each(['deepseek-v3', 'deepseek-v3.2', 'deepseek-v4-flash', 'deepseek-v4-pro'])(
    'keeps Bailian-owned DeepSeek web-search eligibility for %s',
    (modelId) => {
      expect(isBuiltinWebSearchAvailable(model(modelId), provider('model-dependent', 'dashscope'))).toBe(true)
    }
  )

  it('narrows official DeepSeek web search to its Responses endpoint', () => {
    const deepseek = {
      id: 'deepseek',
      serverTools: [
        {
          id: SERVER_TOOL.WEB_SEARCH,
          modelScope: 'model-dependent',
          endpointTypes: [ENDPOINT_TYPE.OPENAI_RESPONSES]
        }
      ]
    } as Provider
    const flash = model('deepseek-flash', { capabilities: [MODEL_CAPABILITY.FUNCTION_CALL] })

    expect(isBuiltinWebSearchAvailable(flash, deepseek, ENDPOINT_TYPE.OPENAI_RESPONSES)).toBe(true)
    expect(isBuiltinWebSearchAvailable(flash, deepseek, ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)).toBe(false)
    expect(isBuiltinWebSearchAvailable(flash, deepseek, ENDPOINT_TYPE.ANTHROPIC_MESSAGES)).toBe(false)
    expect(isBuiltinWebSearchAvailable(model('deepseek-v3.2'), deepseek, ENDPOINT_TYPE.OPENAI_RESPONSES)).toBe(false)
  })

  it('rejects non-chat models even when their ids are otherwise eligible', () => {
    const embedding = model('claude-sonnet-4-6', {
      capabilities: [MODEL_CAPABILITY.EMBEDDING]
    })

    expect(isServerToolModelEligible(embedding, { id: 'anthropic' }, SERVER_TOOL.WEB_SEARCH)).toBe(false)
  })

  // Gateways serve namespaced ids (`google/gemini-3-1-pro-preview`). VENDOR_PATTERNS are anchored, so
  // an unstripped namespace matches nothing and `vendors` narrowing withheld the tool from every
  // model whose vendor slug differs from its namespace — the gateways' Gemini and Claude lines both.
  it('narrows by vendor through a gateway namespace prefix', () => {
    const gateway = {
      id: 'aihubmix',
      serverTools: [{ id: SERVER_TOOL.WEB_SEARCH, modelScope: 'model-dependent', vendors: ['gemini', 'openai'] }]
    } as unknown as Provider

    expect(isBuiltinWebSearchAvailable(model('google/gemini-3-1-pro-preview'), gateway)).toBe(true)
    expect(isBuiltinWebSearchAvailable(model('openai/gpt-5.5'), gateway)).toBe(true)
    // Still excluded: its vendor is simply not on the declaration.
    expect(isBuiltinWebSearchAvailable(model('deepseek/deepseek-v3.2'), gateway)).toBe(false)
  })

  // Ark's wire ids are dated snapshots (`doubao-seed-2-1-pro-260628`), while the catalog keys the
  // undated canonical — eligibility must survive the date stamp or built-in search vanishes for
  // exactly the models that carry it.
  it('stays eligible when the wire id carries an Ark date snapshot', () => {
    const dated = model('doubao-seed-2-1-pro-260628', { providerId: 'doubao' })

    expect(isBuiltinWebSearchAvailable(dated, provider('model-dependent', 'doubao'))).toBe(true)
  })

  it('keeps provider-wide tools independent from model-dependent eligibility', () => {
    expect(isBuiltinWebSearchAvailable(model('private-model'), provider('all-chat-models'))).toBe(true)
  })
})

describe('web-tool routing', () => {
  const claude = model('claude-sonnet-4-6', {
    capabilities: [MODEL_CAPABILITY.FUNCTION_CALL]
  })

  it('routes to the client side when a backend is configured', () => {
    expect(
      resolveWebToolRoutes(claude, {
        webSearchEnabled: true,
        clientSearchAvailable: true,
        clientFetchAvailable: true
      })
    ).toEqual({ webSearch: 'client', webFetch: 'client' })
  })

  it('routes each capability independently', () => {
    expect(
      resolveWebToolRoutes(claude, {
        webSearchEnabled: true,
        clientSearchAvailable: false,
        clientFetchAvailable: true
      })
    ).toEqual({
      webSearch: 'none',
      webFetch: 'client',
      reasons: { webSearch: 'no-backend' }
    })
  })

  it('reports no-backend when the toggle is on and nothing is configured', () => {
    expect(
      resolveWebToolRoutes(claude, {
        webSearchEnabled: true,
        clientSearchAvailable: false,
        clientFetchAvailable: false
      })
    ).toEqual({
      webSearch: 'none',
      webFetch: 'none',
      reasons: { webSearch: 'no-backend', webFetch: 'no-backend' }
    })
  })

  it('reports model-unsupported when backends exist but the model cannot call tools', () => {
    expect(
      resolveWebToolRoutes(model('private-model'), {
        webSearchEnabled: true,
        clientSearchAvailable: true,
        clientFetchAvailable: true
      })
    ).toEqual({
      webSearch: 'none',
      webFetch: 'none',
      reasons: { webSearch: 'model-unsupported', webFetch: 'model-unsupported' }
    })
  })

  it('yields no routes while the toggle is off', () => {
    expect(
      resolveWebToolRoutes(claude, {
        webSearchEnabled: false,
        clientSearchAvailable: true,
        clientFetchAvailable: true
      })
    ).toMatchObject({ webSearch: 'none', webFetch: 'none' })
  })
})
