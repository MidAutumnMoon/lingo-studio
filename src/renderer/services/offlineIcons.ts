/**
 * Offline icon data for @iconify/react.
 *
 * The app registers its icon data instead of fetching it from
 * api.iconify.design at runtime. The material-icon-theme collection (already
 * a dependency) backs a custom prefix loader, so network access for that
 * prefix is impossible by construction — every lookup miss goes to the
 * loader, never the API. The four simple-icons glyphs used by the
 * binary-tool presets are committed inline; pulling the whole simple-icons
 * collection for four names would ship ~1 MB of dead weight. Any other
 * prefix would still reach for the API, so fetch is tripwired to fail loudly.
 */
import { _api, addCollection, addIcon, setCustomIconsLoader, type IconifyJSON } from '@iconify/react'

import { loggerService } from '@logger'

const logger = loggerService.withContext('offlineIcons')

/** simple-icons bodies for the binary-tool presets (24×24, fill: currentColor). */
export const OFFLINE_SIMPLE_ICONS = {
  uv: {
    body: '<path fill="currentColor" d="m0 .106l.05 11.95l.04 9.56a2.39 2.39 0 0 0 2.4 2.379l9.56-.04l5.975-.026l.608-.002c1.316-.006 2.38-1.097 2.38-2.413h1.094v2.39H24L23.9.005L12.905.051l.046 9.525v5.963h-1.958l.046-5.955l-.046-9.525Z"/>',
    width: 24,
    height: 24
  },
  bun: {
    body: '<path fill="currentColor" d="M12 22.596c6.628 0 12-4.338 12-9.688c0-3.318-2.057-6.248-5.219-7.986c-1.286-.715-2.297-1.357-3.139-1.89C14.058 2.025 13.08 1.404 12 1.404c-1.097 0-2.334.785-3.966 1.821a50 50 0 0 1-2.816 1.697C2.057 6.66 0 9.59 0 12.908c0 5.35 5.372 9.687 12 9.687zM10.599 4.715c.334-.759.503-1.58.498-2.409c0-.145.202-.187.23-.029c.658 2.783-.902 4.162-2.057 4.624c-.124.048-.199-.121-.103-.209a5.8 5.8 0 0 0 1.432-1.977m2.058-.102a5.8 5.8 0 0 0-.782-2.306v-.016c-.069-.123.086-.263.185-.172c1.962 2.111 1.307 4.067.556 5.051c-.082.103-.23-.003-.189-.126a5.85 5.85 0 0 0 .23-2.431m1.776-.561a5.7 5.7 0 0 0-1.612-1.806v-.014c-.112-.085-.024-.274.114-.218c2.595 1.087 2.774 3.18 2.459 4.407a.12.12 0 0 1-.049.071a.11.11 0 0 1-.153-.026a.12.12 0 0 1-.022-.083a5.9 5.9 0 0 0-.737-2.331m-5.087.561c-.617.546-1.282.76-2.063 1c-.117 0-.195-.078-.156-.181c1.752-.909 2.376-1.649 2.999-2.778c0 0 .155-.118.188.085c0 .304-.349 1.329-.968 1.874m4.945 11.237a2.96 2.96 0 0 1-.937 1.553c-.346.346-.8.565-1.286.62a2.18 2.18 0 0 1-1.327-.62a2.96 2.96 0 0 1-.925-1.553a.24.24 0 0 1 .064-.198a.23.23 0 0 1 .193-.069h3.965a.23.23 0 0 1 .19.07c.05.053.073.125.063.197m-5.458-2.176a1.86 1.86 0 0 1-2.384-.245a1.98 1.98 0 0 1-.233-2.447c.207-.319.503-.566.848-.713a1.84 1.84 0 0 1 1.092-.11c.366.075.703.261.967.531a1.98 1.98 0 0 1 .408 2.114a1.93 1.93 0 0 1-.698.869zm8.495.005a1.86 1.86 0 0 1-2.381-.253a1.96 1.96 0 0 1-.547-1.366c0-.384.11-.76.32-1.079c.207-.319.503-.567.849-.713a1.84 1.84 0 0 1 1.093-.108c.367.076.704.262.968.534a1.98 1.98 0 0 1 .4 2.117a1.93 1.93 0 0 1-.702.868"/>',
    width: 24,
    height: 24
  },
  github: {
    body: '<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.96-.267 1.98-.399 3-.405c1.02.006 2.04.138 3 .405c2.28-1.552 3.285-1.23 3.285-1.23c.645 1.653.24 2.873.12 3.176c.765.84 1.23 1.91 1.23 3.22c0 4.61-2.805 5.625-5.475 5.92c.42.36.81 1.096.81 2.22c0 1.606-.015 2.896-.015 3.286c0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
    width: 24,
    height: 24
  },
  notion: {
    body: '<path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514c-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233l4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632"/>',
    width: 24,
    height: 24
  }
} as const

let materialIconTheme: Promise<IconifyJSON> | undefined

/**
 * Load the full material-icon-theme collection as its own async chunk. The
 * dynamic import keeps ~250 KB gzip off every window's entry graph; disk is
 * local, so the one-time load is ~ms.
 */
const loadMaterialIconTheme = (): Promise<IconifyJSON> =>
  (materialIconTheme ??= import('@iconify-json/material-icon-theme/icons.json')
    .then((module) => {
      const collection = module.default as unknown as IconifyJSON
      addCollection(collection)
      return collection
    })
    .catch((error) => {
      // Don't cache a rejected load: retry on the next lookup instead of
      // blanking these icons for the window's lifetime.
      materialIconTheme = undefined
      throw error
    }))

/**
 * Register offline icon data. Call once at window bootstrap, before the first
 * render — the prefix loader makes material-icon-theme lookups local-disk
 * only, the inline glyphs render synchronously, and the boot prefetch fills
 * the collection while the window paints so the first icon never waits.
 */
export function registerOfflineIcons(): void {
  for (const [name, icon] of Object.entries(OFFLINE_SIMPLE_ICONS)) {
    addIcon(`simple-icons:${name}`, icon)
  }
  setCustomIconsLoader(async () => loadMaterialIconTheme(), 'material-icon-theme')
  void loadMaterialIconTheme().catch((error) => logger.error('material-icon-theme prefetch failed', error))

  // Any prefix without offline data fails loudly here instead of reaching
  // api.iconify.design (private _api surface; a future removal of it breaks
  // startup loudly rather than silently regressing to network fetches).
  _api.setFetch(async (input: RequestInfo | URL) => {
    logger.warn('iconify network fetch attempted — register icon data offline instead', { url: String(input) })
    throw new Error('Network icon fetches are disabled')
  })
}
