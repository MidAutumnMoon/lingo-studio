import { getMacSystemProxy } from 'mac-system-proxy'

export interface SystemProxy {
  /** Proxy server URL ready for proxy agents, e.g. `http://host:port`, `socks://host:port`. */
  proxyUrl: string
  /** Hosts whose traffic must bypass the proxy. */
  noProxy: string[]
}

/**
 * Read the OS-level proxy configuration: macOS system settings (via `scutil`) or the
 * conventional `*_proxy` environment variables on other platforms. Returns undefined
 * when the OS reports no proxy; Windows is not supported and reports none.
 */
export async function getSystemProxy(): Promise<SystemProxy | undefined> {
  if (process.platform === 'win32') return undefined

  if (process.platform === 'darwin') {
    const settings = await getMacSystemProxy()
    const noProxy = settings.ExceptionsList ?? []

    // Deliberate precedence: HTTP, then SOCKS, then HTTPS — do not reorder.
    if (settings.HTTPEnable && settings.HTTPProxy && settings.HTTPPort) {
      return { proxyUrl: `http://${settings.HTTPProxy}:${settings.HTTPPort}`, noProxy }
    }
    if (settings.SOCKSEnable && settings.SOCKSProxy && settings.SOCKSPort) {
      return { proxyUrl: `socks://${settings.SOCKSProxy}:${settings.SOCKSPort}`, noProxy }
    }
    if (settings.HTTPSEnable && settings.HTTPSProxy && settings.HTTPSPort) {
      return { proxyUrl: `http://${settings.HTTPSProxy}:${settings.HTTPSPort}`, noProxy }
    }
    return undefined
  }

  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  if (!proxyUrl) return undefined

  const noProxyValue = process.env.NO_PROXY || process.env.no_proxy
  return { proxyUrl, noProxy: noProxyValue ? noProxyValue.split(',') : [] }
}
