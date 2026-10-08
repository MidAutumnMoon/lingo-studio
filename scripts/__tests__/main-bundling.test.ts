/**
 * Bundling contract for main-process families beyond `@ai-sdk/*` (see ai-sdk-bundling.test.ts).
 *
 * The main-process build externalizes every root `dependencies`/`optionalDependencies` entry
 * (electron.vite.config.ts `mainExternalDependencies`) and bundles everything else; dev and
 * tests always pass because they resolve modules from node_modules. Two field moves break only
 * the packaged app:
 * - Promoting a pure-JS family (the Elysia API gateway, the OTel SDK) to `dependencies`
 *   externalizes it, but devDependencies are pruned from production packages → MODULE_NOT_FOUND.
 *   See docs/references/api-gateway/README.md for why the Elysia stack is deliberately bundled.
 * - Demoting a native runtime dep out of `dependencies` ships no node_modules copy, so the
 *   packaged app cannot load its `.node` addons / sqlite extensions.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isMainExternalModule } from '../../electron.vite.config'

const root = path.resolve(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const bridgePkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/dsh-bridge/package.json'), 'utf8'))

const manifestNames = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]

const elysiaFamily = manifestNames.filter((name) => name === 'elysia' || name.startsWith('@elysia/'))
const otelFamily = manifestNames.filter((name) => name.startsWith('@opentelemetry/'))

// Native runtime deps: real import targets whose binaries/assets must ship in node_modules.
const nativeRuntimeDeps = [
  '@deepseek-ai/node-addon-system-darwin-arm64',
  '@deepseek-ai/node-addon-system-darwin-x64',
  '@deepseek-ai/node-addon-system-linux-arm64',
  '@deepseek-ai/node-addon-system-linux-x64',
  '@firecrawl/anydoc',
  '@napi-rs/canvas',
  '@napi-rs/system-ocr',
  '@node-rs/xxhash',
  '@vectorstores/core',
  'better-sqlite3',
  'mac-system-proxy',
  'sharp',
  'sqlite-vec',
  'tesseract.js'
]

describe('main-process bundling contract', () => {
  it('declares both families so the guards below are not vacuously true', () => {
    expect(elysiaFamily.length).toBeGreaterThanOrEqual(5)
    expect(otelFamily.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps the Elysia and OTel families out of root dependencies, so the main build bundles them', () => {
    const promoted = [...Object.keys(pkg.dependencies ?? {})].filter(
      (name) => elysiaFamily.includes(name) || otelFamily.includes(name)
    )
    expect(promoted).toEqual([])
  })

  it.each([...elysiaFamily, ...otelFamily])('bundles %s rather than externalizing it', (name) => {
    expect(isMainExternalModule(name)).toBe(false)
  })

  it.each(nativeRuntimeDeps)('ships and externalizes native runtime dep %s', (name) => {
    const shipped = name in (pkg.dependencies ?? {}) || name in (pkg.optionalDependencies ?? {})
    expect(shipped, `${name} must stay in dependencies/optionalDependencies`).toBe(true)
    expect(isMainExternalModule(name)).toBe(true)
  })

  // dsh-bridge ships as an external workspace dependency, so its own natives must stay in
  // its dependencies or electron-builder prunes them from the packaged node_modules.
  it.each(['koffi', 'node-pty', 'sharp'])('keeps %s in dsh-bridge dependencies', (name) => {
    expect(name in (bridgePkg.dependencies ?? {})).toBe(true)
  })
})
