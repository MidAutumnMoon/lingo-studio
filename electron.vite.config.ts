import { readFileSync } from 'fs'
import { resolve } from 'path'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { CodeInspectorPlugin } from 'code-inspector-plugin'
import { defineConfig } from 'electron-vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { parse } from 'yaml'

// Import attributes are not supported by the current Electron config loader.
// import pkg from './package.json' assert { type: 'json' }
import pkg from './package.json'
import { chunkExportGuardPlugin } from './scripts/checkChunkExports'
import { uiContractPlugin } from './scripts/uiContract/vitePlugin'
import { APP_EDITIONS, type AppEdition } from './src/shared/types/appEdition'
import { parseReleaseHistory, validateCurrentReleaseHistory } from './src/shared/utils/releaseNotes'

type ElectronBuilderConfig = {
  releaseInfo?: {
    releaseNotes?: unknown
  }
}

const electronBuilderConfig = parse(
  readFileSync(resolve(__dirname, 'electron-builder.yml'), 'utf8')
) as ElectronBuilderConfig
const bundledReleaseNotes = electronBuilderConfig.releaseInfo?.releaseNotes
const bundledReleaseHistory = parseReleaseHistory(
  readFileSync(resolve(__dirname, 'resources/cherry-studio/release-history.json'), 'utf8')
)

if (typeof bundledReleaseNotes !== 'string' || !bundledReleaseNotes.trim()) {
  throw new Error('electron-builder.yml must define non-empty releaseInfo.releaseNotes')
}
validateCurrentReleaseHistory({ releaseNotes: bundledReleaseNotes, version: pkg.version }, bundledReleaseHistory)

const visualizerPlugin = (type: 'renderer' | 'main') => {
  return process.env[`VISUALIZER_${type.toUpperCase()}`] ? [visualizer({ open: true })] : []
}

const isDev = process.env.NODE_ENV === 'development'
const isProd = process.env.NODE_ENV === 'production'

// Shipped builds carry no sourcemaps; dev keeps them for debugging.
const sourceMap = isDev

export function resolveRendererEdition(value: string | undefined): AppEdition {
  const edition = value?.trim().toLowerCase() || 'global'
  if (APP_EDITIONS.includes(edition as AppEdition)) return edition as AppEdition
  throw new Error(`Unsupported renderer edition: ${edition}`)
}

const rendererEdition = resolveRendererEdition(process.env.CHERRY_EDITION)

// Bundle/externalize split for the main process: everything in `dependencies` is
// externalized below (kept in node_modules of the packaged app), and everything
// NOT in `dependencies` (i.e. in `devDependencies`) is bundled into the main bundle by
// Rolldown. The API gateway's Elysia stack (`elysia`, `@elysia/*`) is intentionally in
// `devDependencies` for exactly this reason — it is pure JS and bundles cleanly. Do NOT
// move it to `dependencies`: that would externalize it, and since devDependencies are
// pruned from production packages, the packaged app would fail at runtime with
// MODULE_NOT_FOUND (guarded by scripts/__tests__/main-bundling.test.ts).
// See docs/references/api-gateway/README.md.
const mainExternalDependencies = [
  ...Object.keys(pkg.dependencies),
  // optionalDependencies too: platform-gated natives (e.g. node-mac-permissions) are real import
  // targets, not napi sub-packages, so rollup would fail on the .node; production keeps them installed.
  ...Object.keys(pkg.optionalDependencies ?? {})
]
export const mainExternalModules = ['bufferutil', 'utf-8-validate', 'electron', ...mainExternalDependencies]

export const isMainExternalModule = (id: string) => {
  return mainExternalModules.some((moduleId) => id === moduleId || id.startsWith(`${moduleId}/`))
}

export const mainResolveAlias = {
  '@main': resolve('src/main'),
  '@application': resolve('src/main/core/application/Application'),
  '@data': resolve('src/main/data'),
  '@shared': resolve('src/shared'),
  '@logger': resolve('src/main/core/logger/LoggerService'),
  '@cherrystudio/ai-core/provider': resolve('packages/aiCore/src/core/providers'),
  '@cherrystudio/ai-core/built-in/plugins': resolve('packages/aiCore/src/core/plugins/built-in'),
  '@cherrystudio/ai-core': resolve('packages/aiCore/src'),
  '@cherrystudio/ai-sdk-provider': resolve('packages/ai-sdk-provider/src'),
  '@cherrystudio/provider-registry/node': resolve('packages/provider-registry/src/registry-loader'),
  '@cherrystudio/provider-registry': resolve('packages/provider-registry/src'),
  '@test-mocks': resolve('tests/__mocks__'),
  '@test-helpers': resolve('tests/helpers')
}

export default defineConfig({
  main: {
    define: { __APP_EDITION__: JSON.stringify(rendererEdition) },
    plugins: [chunkExportGuardPlugin(), ...visualizerPlugin('main')],
    resolve: { alias: mainResolveAlias },
    build: {
      externalizeDeps: {
        include: mainExternalModules
      },
      lib: { entry: resolve(__dirname, 'src/main/main.ts') },
      rolldownOptions: {
        output: {
          manualChunks: (id) => {
            // conf removes its containing file from require.cache; isolate it so the app entry stays cached.
            if (id.includes('/node_modules/conf/')) return 'electron-store-conf'
            // rolldown drops this chunk's named exports when it merges with a re-export-only
            // facade chunk, leaving createOpenAI undefined at runtime. Keep it alone.
            if (id.includes('/node_modules/@ai-sdk/openai/')) return 'ai-sdk-openai'
            return undefined
          },
          comments: isProd ? { legal: false } : undefined
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        }
      },
      sourcemap: sourceMap
    },
    optimizeDeps: {
      noDiscovery: isDev
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      sourcemap: sourceMap,
      rolldownOptions: {
        // Unlike renderer which auto-discovers entries from HTML files,
        // preload requires explicit entry point configuration for multiple scripts
        input: {
          preload: resolve(__dirname, 'src/preload/preload.ts'),
          simplest: resolve(__dirname, 'src/preload/simplest.ts'), // Minimal preload
          webview: resolve(__dirname, 'src/preload/webview.ts') // Site `<webview>` guests
        },
        external: ['electron'],
        output: {
          entryFileNames: '[name].js',
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    define: {
      __APP_EDITION__: JSON.stringify(rendererEdition),
      __APP_RELEASE_HISTORY__: JSON.stringify(bundledReleaseHistory),
      __APP_RELEASE_NOTES__: JSON.stringify(bundledReleaseNotes),
      __APP_RELEASE_VERSION__: JSON.stringify(pkg.version)
    },
    plugins: [
      uiContractPlugin(),
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/routes'),
        generatedRouteTree: resolve('src/renderer/routeTree.gen.ts')
      }),
      tailwindcss(),
      ...(isDev ? [CodeInspectorPlugin({ bundler: 'vite' })] : []), // 只在开发环境下启用 CodeInspectorPlugin
      // React Compiler (oxc) — verified compiling ~2.2k renderer functions on 2026-10-01, parked because
      // oxc-transform-react 0.152.0 miscompiles this codebase: 56 renderer tests fail (stale-UI class,
      // e.g. EditDialogs) and upstream bugs oxc#26519 (outlined closure → ReferenceError),
      // oxc#27070 (nullable useState guard → TypeError), oxc#27113 (silent useMemo dep widening)
      // (github.com/oxc-project/oxc/issues) are open. Re-enable as `compiler: { reportDiagnostics: true,
      // logDiagnostics: true }` — both flags, otherwise bailouts are silent — and keep
      // CodeInspectorPlugin above react() so it annotates raw JSX before the compiler lowers it.
      react({ compiler: false }),
      // react({ compiler: { reportDiagnostics: true, logDiagnostics: true } })
      ...visualizerPlugin('renderer')
    ],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@logger': resolve('src/renderer/services/LoggerService'),
        '@data': resolve('src/renderer/data'),
        // shiki runs on the JavaScript regex engine everywhere; alias the wasm module to a
        // throwing stub so the bundler drops the otherwise-dead 622KB oniguruma chunk that
        // shiki's default-engine closure (and pierre's opt-in branch) would keep emitted.
        // Vitest's renderer/scripts projects inherit this alias via vitest.config.ts.
        'shiki/wasm': resolve('src/renderer/utils/shikiWasmStub'),
        '@cherrystudio/ai-core/provider': resolve('packages/aiCore/src/core/providers'),
        '@cherrystudio/ai-core/built-in/plugins': resolve('packages/aiCore/src/core/plugins/built-in'),
        '@cherrystudio/ai-core': resolve('packages/aiCore/src'),
        '@cherrystudio/extension-table-plus': resolve('packages/extension-table-plus/src'),
        '@cherrystudio/ai-sdk-provider': resolve('packages/ai-sdk-provider/src'),
        '@cherrystudio/provider-registry/node': resolve('packages/provider-registry/src/registry-loader'),
        '@cherrystudio/provider-registry': resolve('packages/provider-registry/src'),
        '@cherrystudio/ui/icons/providers': resolve('packages/ui/src/components/icons/providers'),
        '@cherrystudio/ui/icons': resolve('packages/ui/src/components/icons'),
        '@cherrystudio/ui': resolve('packages/ui/src'),
        '@test-mocks': resolve('tests/__mocks__'),
        '@test-helpers': resolve('tests/helpers')
      }
    },
    optimizeDeps: {
      exclude: ['pyodide'],
      rolldownOptions: {
        transform: {
          target: 'esnext' // for dev
        }
      }
    },
    worker: {
      format: 'es'
    },
    build: {
      sourcemap: sourceMap,
      target: 'esnext', // for build
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/windows/main/index.html'),
          migrationV2: resolve(__dirname, 'src/renderer/windows/migrationV2/index.html'),
          userDataRelocation: resolve(__dirname, 'src/renderer/windows/userDataRelocation/index.html'),
          subWindow: resolve(__dirname, 'src/renderer/windows/subWindow/index.html')
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        },
        output: {
          comments: isProd ? { legal: false } : undefined,
          advancedChunks: {
            // Without this, groups recursively capture dependencies — React
            // itself ends up inside an icon bucket and every window preloads it.
            includeDependenciesRecursively: false,
            groups: [
              // Bucket per-icon lazy modules into mid-size chunks instead of one
              // tiny chunk per icon. Model icons only: they are reached solely
              // through the dynamic loaders, so the buckets stay off every
              // window's eager graph. Provider icons must NOT be grouped — a few
              // files statically import specific providers from
              // @cherrystudio/ui/icons/providers, and bucketing would chain
              // whole buckets of unrelated SVGs into those windows' first load.
              // Only the SVG component files (*.tsx) may match: each icon dir's
              // meta.ts is eagerly imported by the meta-catalogs.
              {
                name: 'icons-models',
                test: /packages\/ui\/src\/components\/icons\/models\/[^/]+\/(?:index|light|dark|avatar)\.tsx$/,
                maxSize: 150_000
              }
            ]
          }
        }
      }
    }
  }
})
