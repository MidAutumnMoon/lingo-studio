import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { Provider } from '@shared/data/types/provider'

const services = vi.hoisted(() => ({
  ready: true,
  checkClaudeLogin: vi.fn(),
  listAgents: vi.fn(),
  getProviderByProviderId: vi.fn()
}))
vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    CodeCliService: {
      get isReady() {
        return services.ready
      },
      checkClaudeLogin: services.checkClaudeLogin
    }
  } as never)
})
vi.mock('@main/data/services/AgentService', () => ({
  agentService: { listAgents: services.listAgents }
}))
vi.mock('@main/data/services/ProviderService', () => ({
  providerService: { getByProviderId: services.getProviderByProviderId }
}))

const { claudeLogin } = await import('../runtime')
const signal = new AbortController().signal
const ctx = { signal, share: <T>(_key: string, factory: (signal: AbortSignal) => Promise<T>) => factory(signal) }

const agent = (model: AgentEntity['model'] = 'claude-code::sonnet'): AgentEntity => ({
  id: 'agent-1',
  type: 'claude-code',
  name: 'Agent',
  model,
  modelName: 'Claude',
  orderKey: 'a',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
})

const provider = (id: string, authMethods: Provider['authMethods']): Provider => ({
  id,
  name: id,
  authMethods,
  reportsActualCost: false,
  apiKeys: [],
  authType: 'api-key',
  settings: {},
  isEnabled: true
})

beforeEach(() => {
  vi.clearAllMocks()
  services.ready = true
  services.checkClaudeLogin.mockResolvedValue(true)
  services.listAgents.mockReturnValue({ agents: [], total: 0 })
  services.getProviderByProviderId.mockReturnValue(provider('claude-code', ['external-cli']))
})

describe('runtime-claude-login', () => {
  it('does not claim the login state of an uninitialized service', async () => {
    services.ready = false
    services.listAgents.mockReturnValue({ agents: [agent()] })
    await expect(claudeLogin.run(ctx)).rejects.toThrow('not ready')
  })

  it('propagates login query failures', async () => {
    services.listAgents.mockReturnValue({ agents: [agent()] })
    services.checkClaudeLogin.mockRejectedValue(new Error('keychain locked'))
    await expect(claudeLogin.run(ctx)).rejects.toThrow('keychain locked')
  })
  it('does not require a CLI login when no Claude Code agent exists', async () => {
    await expect(claudeLogin.run(ctx)).resolves.toEqual({ status: 'pass' })
    expect(services.checkClaudeLogin).not.toHaveBeenCalled()
  })

  it('does not require a CLI login for a Claude Code agent using an API-key provider', async () => {
    services.listAgents.mockReturnValue({ agents: [agent('anthropic::claude-sonnet')] })
    services.getProviderByProviderId.mockReturnValue(provider('anthropic', ['api-key']))
    services.checkClaudeLogin.mockResolvedValue(false)

    await expect(claudeLogin.run(ctx)).resolves.toEqual({ status: 'pass' })
    expect(services.checkClaudeLogin).not.toHaveBeenCalled()
  })

  it('passes when a Claude Code agent has a usable CLI login', async () => {
    services.listAgents.mockReturnValue({ agents: [agent()], total: 1 })
    await expect(claudeLogin.run(ctx)).resolves.toEqual({ status: 'pass' })
  })

  it('warns and links to login when a Claude Code agent has no CLI login', async () => {
    services.listAgents.mockReturnValue({ agents: [agent()], total: 1 })
    services.checkClaudeLogin.mockResolvedValue(false)

    await expect(claudeLogin.run(ctx)).resolves.toMatchObject({
      status: 'warn',
      attribution: 'user-fixable',
      detail: { variant: 'not_logged_in' },
      actions: [{ kind: 'navigate', target: '/settings/provider?id=claude-code' }]
    })
  })
})
