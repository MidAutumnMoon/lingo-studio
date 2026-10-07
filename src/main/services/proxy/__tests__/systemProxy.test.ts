import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getMacSystemProxyMock } = vi.hoisted(() => ({ getMacSystemProxyMock: vi.fn() }))

vi.mock('mac-system-proxy', () => ({ getMacSystemProxy: getMacSystemProxyMock }))

// Import AFTER mocks are registered so the module binds to mocked values.
import { getSystemProxy } from '../systemProxy'

const REAL_PLATFORM = process.platform

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const

const stubPlatform = (platform: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  // Neutralize any proxy vars leaking from the host/CI runner; empty string is falsy,
  // which the module treats as unset.
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, '')
  vi.clearAllMocks()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  vi.unstubAllEnvs()
})

describe('getSystemProxy — linux', () => {
  beforeEach(() => stubPlatform('linux'))

  // A reordered chain would silently route traffic through the wrong proxy.
  it('resolves the proxy URL with precedence HTTPS_PROXY > HTTP_PROXY > https_proxy > http_proxy', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://https-upper:1')
    vi.stubEnv('HTTP_PROXY', 'http://http-upper:2')
    vi.stubEnv('https_proxy', 'http://https-lower:3')
    vi.stubEnv('http_proxy', 'http://http-lower:4')

    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://https-upper:1' })

    vi.stubEnv('HTTPS_PROXY', '')
    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://http-upper:2' })

    vi.stubEnv('HTTP_PROXY', '')
    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://https-lower:3' })

    vi.stubEnv('https_proxy', '')
    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://http-lower:4' })
  })

  it('returns undefined when no proxy variable is set', async () => {
    await expect(getSystemProxy()).resolves.toBeUndefined()
  })

  it('splits NO_PROXY on commas into the bypass list, uppercase taking priority', async () => {
    vi.stubEnv('http_proxy', 'http://proxy:1')
    vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
    vi.stubEnv('no_proxy', '.internal')

    await expect(getSystemProxy()).resolves.toEqual({
      proxyUrl: 'http://proxy:1',
      noProxy: ['localhost', '127.0.0.1']
    })
  })

  it('falls back to lowercase no_proxy when NO_PROXY is unset', async () => {
    vi.stubEnv('http_proxy', 'http://proxy:1')
    vi.stubEnv('no_proxy', 'localhost,.internal')

    await expect(getSystemProxy()).resolves.toMatchObject({ noProxy: ['localhost', '.internal'] })
  })

  it('returns an empty bypass list when no_proxy is empty', async () => {
    vi.stubEnv('http_proxy', 'http://proxy:1')

    await expect(getSystemProxy()).resolves.toEqual({ proxyUrl: 'http://proxy:1', noProxy: [] })
  })
})

describe('getSystemProxy — darwin', () => {
  beforeEach(() => {
    stubPlatform('darwin')
    getMacSystemProxyMock.mockResolvedValue({})
  })

  it('maps an enabled HTTP proxy to an http:// URL', async () => {
    getMacSystemProxyMock.mockResolvedValue({
      HTTPEnable: '1',
      HTTPProxy: '127.0.0.1',
      HTTPPort: '7890',
      ExceptionsList: ['localhost']
    })

    await expect(getSystemProxy()).resolves.toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      noProxy: ['localhost']
    })
  })

  // scutil can report several proxies at once; HTTP wins by design.
  it('prefers HTTP over SOCKS and HTTPS when several are enabled', async () => {
    getMacSystemProxyMock.mockResolvedValue({
      HTTPEnable: '1',
      HTTPProxy: 'http-proxy',
      HTTPPort: '1',
      SOCKSEnable: '1',
      SOCKSProxy: 'socks-proxy',
      SOCKSPort: '2',
      HTTPSEnable: '1',
      HTTPSProxy: 'https-proxy',
      HTTPSPort: '3'
    })

    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://http-proxy:1' })
  })

  it('maps a SOCKS proxy to a socks:// URL when HTTP is not configured', async () => {
    getMacSystemProxyMock.mockResolvedValue({
      SOCKSEnable: '1',
      SOCKSProxy: '127.0.0.1',
      SOCKSPort: '1080'
    })

    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'socks://127.0.0.1:1080' })
  })

  // The HTTPS proxy is reachable over plain http:// to the proxy host — an https://
  // scheme here would change how proxy agents dial it.
  it('maps an HTTPS proxy to an http:// scheme URL', async () => {
    getMacSystemProxyMock.mockResolvedValue({
      HTTPSEnable: '1',
      HTTPSProxy: '127.0.0.1',
      HTTPSPort: '7891'
    })

    await expect(getSystemProxy()).resolves.toMatchObject({ proxyUrl: 'http://127.0.0.1:7891' })
  })

  it('defaults noProxy to an empty list when ExceptionsList is absent', async () => {
    getMacSystemProxyMock.mockResolvedValue({ HTTPEnable: '1', HTTPProxy: '127.0.0.1', HTTPPort: '7890' })

    await expect(getSystemProxy()).resolves.toMatchObject({ noProxy: [] })
  })

  it('returns undefined when no proxy is fully configured', async () => {
    getMacSystemProxyMock.mockResolvedValue({
      HTTPEnable: '0',
      SOCKSEnable: '0',
      HTTPSEnable: '0'
    })

    await expect(getSystemProxy()).resolves.toBeUndefined()
  })
})

describe('getSystemProxy — win32', () => {
  beforeEach(() => stubPlatform('win32'))

  it('reports no proxy and never consults the mac settings reader', async () => {
    await expect(getSystemProxy()).resolves.toBeUndefined()
    expect(getMacSystemProxyMock).not.toHaveBeenCalled()
  })
})
