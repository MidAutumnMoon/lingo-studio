/**
 * Guards the prebuilt-package checks in before-pack.js. CI never runs electron-builder,
 * so this is the only place the check is exercised: it fails here if `pnpm install`
 * stopped materialising both CPU architectures for the host OS — the packaging bug that
 * shipped a macOS x64 build without `@img/sharp-darwin-x64` — or if the better-sqlite3
 * prebuild filter stops narrowing prebuilds/ to the packaging target.
 */
import { Arch } from 'electron-builder'
import { describe, expect, it } from 'vitest'

// CJS build script — vitest interops the module.exports fine.
import beforePack, { assertPrebuiltPackages, betterSqlite3PrebuildExcludes, keepPackages } from '../before-pack'

const hostPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
const hostPlatformName = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
const foreignPlatform = hostPlatform === 'darwin' ? 'win32' : 'darwin'

describe('assertPrebuiltPackages', () => {
  it.each(['arm64', 'x64'])('passes for the host platform on %s', (arch) => {
    expect(() => assertPrebuiltPackages(hostPlatform, arch)).not.toThrow()
  })

  it('reports the missing packages by name', () => {
    // Only the host OS's binaries are installed (supportedArchitectures.os is `current`),
    // so another platform stands in for an install that skipped an architecture.
    expect(() => assertPrebuiltPackages(foreignPlatform, 'x64')).toThrow(
      /Missing prebuilt packages for .+-x64: .*@img\/sharp-/
    )
  })
})

describe('betterSqlite3PrebuildExcludes', () => {
  it.each([
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['darwin', 'arm64', 'darwin-arm64'],
    ['win32', 'x64', 'win32-x64'],
    ['win32', 'arm64', 'win32-arm64']
  ] as const)('keeps only the %s %s prebuild', (platform, arch, kept) => {
    const excludes = betterSqlite3PrebuildExcludes(platform, arch)

    expect(excludes).toHaveLength(7)
    expect(excludes).not.toContain(`!node_modules/better-sqlite3/prebuilds/${kept}.node`)
  })

  it('excludes every prebuild via an absolute node_modules file pattern', () => {
    for (const pattern of betterSqlite3PrebuildExcludes('linux', 'x64')) {
      expect(pattern).toMatch(/^!node_modules\/better-sqlite3\/prebuilds\/[a-z0-9]+-(x64|arm64)\.node$/)
    }
  })

  it('treats a musl packaging target as glibc — the musl prebuilds are never shipped', () => {
    const excludes = betterSqlite3PrebuildExcludes('linuxmusl', 'x64')

    expect(excludes).not.toContain('!node_modules/better-sqlite3/prebuilds/linux-x64.node')
    expect(excludes).toContain('!node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node')
  })
})

describe('beforePack hook', () => {
  it('pushes cross-arch package and foreign prebuild excludes into the files filter', async () => {
    const context = {
      arch: Arch.x64,
      packager: { platform: { name: hostPlatformName }, config: { files: [{ filter: [] }] } }
    }

    await beforePack(context)

    const filters: string[] = context.packager.config.files[0].filter
    // Cross-arch prebuilt packages are dropped for the target platform-arch…
    expect(filters).toContain('!node_modules/@aiany/sqlite-vec-darwin-arm64/**')
    expect(filters).toContain('!node_modules/@firecrawl/anydoc-linux-arm64-gnu/**')
    // …while the target's own packages survive.
    expect(filters).not.toContain(`!node_modules/@deepseek-ai/node-addon-system-${hostPlatform}-x64/**`)
    // better-sqlite3 keeps exactly the target's prebuild: every arm64 one is excluded on x64.
    for (const token of ['darwin', 'linux', 'linuxmusl', 'win32']) {
      expect(filters).toContain(`!node_modules/better-sqlite3/prebuilds/${token}-arm64.node`)
    }
    expect(filters).not.toContain(`!node_modules/better-sqlite3/prebuilds/${hostPlatform}-x64.node`)
  })
})

describe('keepPackages', () => {
  it.each([
    ['linux', 'x64', ['@deepseek-ai/node-addon-system-linux-x64']],
    ['linux', 'arm64', ['@deepseek-ai/node-addon-system-linux-arm64']],
    ['darwin', 'x64', ['@deepseek-ai/node-addon-system-darwin-x64']],
    ['darwin', 'arm64', ['@deepseek-ai/node-addon-system-darwin-arm64']],
    ['win32', 'x64', []],
    ['win32', 'arm64', []]
  ] as const)('keeps only the %s %s DSH system binary', (platform, arch, expectedPackages) => {
    const keptPackages = keepPackages(platform, arch).filter((name) => name.startsWith('@deepseek-ai/node-addon-'))

    expect(keptPackages).toEqual(expectedPackages)
  })
})
