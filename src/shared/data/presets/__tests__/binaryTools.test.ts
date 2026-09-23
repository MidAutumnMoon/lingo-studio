import { describe, expect, it } from 'vitest'

import enUs from '../../../../renderer/i18n/locales/en-us.json'
import { BABELDOC_TOOL_NAME, getBabelDocInstallationStatus, PRESETS_BINARY_TOOLS } from '../binaryTools'

describe('preset descriptions', () => {
  // The dependency card interpolates `tool.name` into the key, so a renamed preset
  // renders the raw `settings.dependencies.tools.<name>` string instead of a description.
  it.each(PRESETS_BINARY_TOOLS.map(({ name }) => name))('%s resolves to a description in en-us.json', (name) => {
    expect(typeof (enUs as Record<string, string>)[`settings.dependencies.tools.${name}`]).toBe('string')
  })
})

describe('BabelDOC Stream preset', () => {
  it('uses the independently published executable name', () => {
    expect(BABELDOC_TOOL_NAME).toBe('babeldoc-stream')
    expect(PRESETS_BINARY_TOOLS.find(({ name }) => name === BABELDOC_TOOL_NAME)).toMatchObject({
      displayName: 'BabelDOC Stream',
      repoUrl: 'https://github.com/eeee0717/BabelDOC'
    })
  })

  it.each([
    [undefined, 'missing'],
    [{ name: BABELDOC_TOOL_NAME, availability: { source: 'none' as const } }, 'missing'],
    [
      { name: BABELDOC_TOOL_NAME, availability: { source: 'system' as const, path: '/usr/local/bin/babeldoc-stream' } },
      'available'
    ]
  ])('classifies snapshot %j as %s', (snapshot, expected) => {
    expect(getBabelDocInstallationStatus(snapshot)).toBe(expected)
  })
})
