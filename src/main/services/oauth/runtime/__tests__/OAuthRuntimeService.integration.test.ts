import type { Server } from 'node:http'

import { setupTestDatabase } from '@test-helpers/db'
import { net, shell } from 'electron'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import '@data/services/ProviderRegistryService'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { BaseService } from '@main/core/lifecycle'

import { OAuthSignInCancelledError } from '../../errors'
import { LoopbackCallbackTransport } from '../LoopbackCallbackTransport'
import { OAuthRuntimeService } from '../OAuthRuntimeService'
import { PkceOAuthClient } from '../PkceOAuthClient'
import type * as ProviderDefinitions from '../providerDefinitions'

/**
 * Synthetic login-based provider exercising the runtime's full surface the way
 * the removed CherryIN definition did: PKCE client, loopback callback on an
 * ephemeral port, and API keys provisioned after token persistence.
 */
const TEST_AUTH_SERVER = 'https://auth.test'

vi.mock('../providerDefinitions', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderDefinitions>()
  const testProvider = {
    providerId: 'oauth-test',
    clientId: 'test-client',
    transport: {
      hosts: ['127.0.0.1'],
      port: 0,
      path: '/oauth/callback',
      redirectUri: 'http://127.0.0.1/oauth/callback'
    },
    matchesSignInContext: (current: { server?: string }, requested: { server?: string }) =>
      (current.server ?? TEST_AUTH_SERVER) === (requested.server ?? TEST_AUTH_SERVER),
    createClient: (context?: { server?: string }) => {
      const server = context?.server ?? TEST_AUTH_SERVER
      return new PkceOAuthClient({
        clientId: 'test-client',
        authorizeUrl: `${server}/oauth2/auth`,
        tokenUrl: `${server}/oauth2/token`,
        redirectUri: 'http://127.0.0.1/oauth/callback',
        scope: 'openid offline_access'
      })
    },
    afterPersistTokens: async (tokenData: { access_token: string }) => {
      const response = await net.fetch(`${TEST_AUTH_SERVER}/api/v1/oauth/tokens`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok) throw new Error(`Failed to fetch API keys: ${response.status}`)
      const keys = (await response.json()) as string[]
      const apiKeys = keys.filter(Boolean).join(',')
      if (!apiKeys) throw new Error('No API keys received')
      return { apiKeys }
    }
  }
  return {
    ...actual,
    oauthProviderDefinitions: {
      ...actual.oauthProviderDefinitions,
      ['oauth-test']: testProvider
    }
  }
})

class TestOAuthRuntimeService extends OAuthRuntimeService {
  stopForTest() {
    return this.onStop()
  }
}

describe('OAuth login with a real callback server and token store', () => {
  const dbh = setupTestDatabase()
  let service: TestOAuthRuntimeService
  let callbackWait: MockInstance<LoopbackCallbackTransport['waitForAuthorizationCode']>
  const tokenData = { access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600 }

  beforeEach(() => {
    BaseService.resetInstances()
    service = new TestOAuthRuntimeService()
    dbh.db.insert(userProviderTable).values({ providerId: 'oauth-test', name: 'Test', orderKey: 'a0' }).run()
    vi.mocked(shell.openExternal).mockReset().mockResolvedValue()
    vi.mocked(net.fetch)
      .mockReset()
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/oauth2/token') return Response.json(tokenData)
        if (path === '/api/v1/oauth/tokens') return Response.json(['private-key'])
        throw new Error(`Unexpected OAuth request: ${path}`)
      })
    callbackWait = vi.spyOn(LoopbackCallbackTransport.prototype, 'waitForAuthorizationCode')
  })

  afterEach(async () => {
    await service.stopForTest()
    vi.restoreAllMocks()
  })

  async function authorize(browserCall = 0) {
    await vi.waitFor(() => expect(vi.mocked(shell.openExternal).mock.calls.length).toBeGreaterThan(browserCall))
    const authUrl = new URL(vi.mocked(shell.openExternal).mock.calls[browserCall][0])
    const transport = callbackWait.mock.contexts[browserCall] as { activeServers: Server[] }
    const address = transport.activeServers[0].address()
    if (!address || typeof address === 'string') throw new Error('Callback server is not listening')
    const callback = new URL(`http://127.0.0.1:${address.port}/oauth/callback`)
    callback.searchParams.set('state', authUrl.searchParams.get('state')!)
    callback.searchParams.set('code', 'test-code')
    const response = await fetch(callback)
    await response.text()
    expect(response.status).toBe(200)
  }

  it('delivers API keys only to the initiating window and account information to observers', async () => {
    const login = service.signIn('window-a', 'oauth-test', 'owner')
    void login.catch(() => {})
    const repeated = service.signIn('window-a', 'oauth-test', 'repeated')
    const observer = service.joinActiveSignIn('window-b', 'oauth-test', 'observer')
    void observer.catch(() => {})
    await expect(service.signIn('window-b', 'oauth-test', 'other')).rejects.toThrow(/another window/)

    await authorize()

    await expect(login).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
    await expect(repeated).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
    await expect(observer).resolves.toEqual({ status: 'completed', account: { accountId: null } })
    expect(dbh.db.select().from(userProviderTable).get()).toMatchObject({
      isEnabled: true,
      authConfig: { type: 'oauth', accessToken: 'private-token', refreshToken: 'private-refresh' }
    })
  })

  it('rejects a second login for a different server without interrupting the first', async () => {
    const login = service.signIn('window-a', 'oauth-test', 'owner')
    void login.catch(() => {})
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledOnce())

    await expect(
      service.signIn('window-a', 'oauth-test', 'other', { server: 'https://other.test' } as never)
    ).rejects.toThrow(/another server/)

    await authorize()
    await expect(login).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
  })

  it('rejects callers without a managed window before starting or observing a login', async () => {
    await expect(service.signIn(null, 'oauth-test', 'unknown')).rejects.toThrow(/managed window/)
    await expect(service.joinActiveSignIn(null, 'oauth-test', 'unknown')).rejects.toThrow(/managed window/)
    await expect(service.cancelSignIn(null, 'oauth-test', 'unknown')).rejects.toThrow(/managed window/)
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(dbh.db.select().from(userProviderTable).get()?.authConfig).toBeNull()
  })

  it.each(['window-a', 'window-b'])(
    'allows a registered %s to cancel without trusting another window’s request id',
    async (windowId) => {
      let outcome: unknown = 'pending'
      const login = service.signIn('window-a', 'oauth-test', 'owner').catch((error: unknown) => {
        outcome = error
        return error
      })
      await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledOnce())
      await service.cancelSignIn('window-b', 'oauth-test', 'owner')
      expect(outcome).toBe('pending')

      const remounted = service.joinActiveSignIn('window-a', 'oauth-test', 'remounted').catch((error: unknown) => error)
      const observer = service.joinActiveSignIn('window-b', 'oauth-test', 'owner').catch((error: unknown) => error)
      await service.cancelSignIn(windowId, 'oauth-test', windowId === 'window-a' ? 'remounted' : 'owner')
      for (const result of await Promise.all([login, remounted, observer])) {
        expect(result).toBeInstanceOf(OAuthSignInCancelledError)
      }

      const retry = service.signIn('window-a', 'oauth-test', 'retry')
      void retry.catch(() => {})
      await service.cancelSignIn('window-a', 'oauth-test', 'owner')
      await authorize(1)
      await expect(retry).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
    }
  )

  it('keeps a later callback server alive when a failed browser launch reaches its old timeout', async () => {
    const staleTimeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(staleTimeout.signal)
    const browserError = new Error('Browser launch failed')
    vi.mocked(shell.openExternal).mockRejectedValueOnce(browserError)
    await expect(service.signIn('window-a', 'oauth-test', 'failed')).rejects.toHaveProperty('cause', browserError)

    const retry = service.signIn('window-a', 'oauth-test', 'retry')
    void retry.catch(() => {})
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2))
    staleTimeout.abort()
    await authorize(1)
    await expect(retry).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
  })

  it('retains persisted tokens after an API-key timeout and allows another login', async () => {
    const timers = new Map<AbortSignal, AbortController>()
    let keyTimeout: AbortController | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const timer = new AbortController()
      timers.set(timer.signal, timer)
      return timer.signal
    })
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(Response.json(tokenData))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = options?.signal
            if (signal) keyTimeout = timers.get(signal)
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )
    const login = service.signIn('window-a', 'oauth-test', 'timeout')
    void login.catch(() => {})
    await authorize()
    await vi.waitFor(() => expect(keyTimeout).toBeDefined())
    expect(dbh.db.select().from(userProviderTable).get()?.authConfig).toMatchObject({ accessToken: 'private-token' })
    const timeoutError = new DOMException('API-key request timed out', 'TimeoutError')
    keyTimeout!.abort(timeoutError)
    await expect(login).rejects.toHaveProperty('cause', timeoutError)
    expect(dbh.db.select().from(userProviderTable).get()?.authConfig).toMatchObject({
      accessToken: 'private-token',
      refreshToken: 'private-refresh'
    })

    const retry = service.signIn('window-a', 'oauth-test', 'retry')
    void retry.catch(() => {})
    await authorize(1)
    await expect(retry).resolves.toEqual({ accountId: null, apiKeys: 'private-key' })
  })
})
