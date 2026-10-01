import { _api, getIcon, loadIcon } from '@iconify/react'
import { describe, expect, it, vi } from 'vitest'

// This file tests the real @iconify/react wiring (loader, addIcon, fetch
// tripwire), not the Icon stub the renderer setup mocks it with.
vi.mock('@iconify/react', async (importOriginal) => await importOriginal())

import { registerOfflineIcons } from '../offlineIcons'

describe('registerOfflineIcons', () => {
  it('registers the simple-icons preset glyphs synchronously', () => {
    registerOfflineIcons()

    expect(getIcon('simple-icons:github')).toBeTruthy()
    expect(getIcon('simple-icons:uv')).toBeTruthy()
    expect(getIcon('simple-icons:bun')).toBeTruthy()
    expect(getIcon('simple-icons:notion')).toBeTruthy()
  })

  it('serves material-icon-theme lookups from the local collection', async () => {
    registerOfflineIcons()

    // No network: the prefix loader resolves from the installed JSON, and the
    // fetch tripwire below would reject any attempted fetch.
    await expect(loadIcon('material-icon-theme:markdown')).resolves.toHaveProperty('body')
  })

  it('disables network fetches', async () => {
    registerOfflineIcons()

    const fetchImpl = _api.getFetch()
    expect(fetchImpl).toBeTypeOf('function')
    await expect(fetchImpl!('https://api.iconify.design/test.json')).rejects.toThrow(
      'Network icon fetches are disabled'
    )
  })
})
