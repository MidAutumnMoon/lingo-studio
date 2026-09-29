import type { SettingsSearchEntry } from '../settingsSearch/types'

export const route = '/settings/about'

// Actionable rows only: version info lines stay out per D8.
export const entries: SettingsSearchEntry[] = [
  {
    anchorId: 'debug-tools',
    titleKey: 'settings.about.debug.title',
    groupKey: 'settings.about.label'
  }
]
