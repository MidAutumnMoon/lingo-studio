import { describe, expect, it } from 'vitest'

import type { Provider } from '@shared/data/types/provider'

import { isAgentOnlyProvider } from '../provider'

const provider = (id: string, authMethods?: Provider['authMethods']): Pick<Provider, 'id' | 'authMethods'> => ({
  id,
  authMethods
})

describe('isAgentOnlyProvider', () => {
  it('is true for external-cli providers', () => {
    expect(isAgentOnlyProvider(provider('cli-login', ['external-cli']))).toBe(true)
    expect(isAgentOnlyProvider(provider('cli-login', ['external-cli']))).toBe(true)
  })

  it('is false for api-key and oauth providers', () => {
    expect(isAgentOnlyProvider(provider('openai', ['api-key']))).toBe(false)
    expect(isAgentOnlyProvider(provider('codex', ['oauth']))).toBe(false)
    expect(isAgentOnlyProvider(provider('openai'))).toBe(false)
  })
})
