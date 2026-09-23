import { and, eq } from 'drizzle-orm'

import { preferenceTable } from '@data/db/schemas/preference'
import { SIDEBAR_SHORTCUT_PROVIDER_IDS } from '@shared/utils/sidebarShortcutProviderIds'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const ASSISTANT_SIDEBAR_CLEANUP = {
  scope: 'default',
  shortcutKey: 'ui.sidebar_shortcut',
  retiredProviderId: SIDEBAR_SHORTCUT_PROVIDER_IDS.ASSISTANT
} as const

type StoredEntry = { target?: { locator?: { providerId?: unknown } } }

function targetsRetiredProvider(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as StoredEntry).target?.locator?.providerId === ASSISTANT_SIDEBAR_CLEANUP.retiredProviderId
  )
}

/**
 * The sidebar lists assistants itself now, so a pinned assistant shortcut is a second row for the
 * same thing. Drop the stored entries; every other shortcut kind stays.
 */
export class AssistantSidebarShortcutCleanupSeeder implements ISeeder {
  readonly name = 'assistant-sidebar-shortcut-cleanup'
  readonly description = 'Drop sidebar shortcuts that pinned an assistant'
  readonly version = hashObject(ASSISTANT_SIDEBAR_CLEANUP)

  run(db: DbType): void {
    const row = db
      .select({ value: preferenceTable.value })
      .from(preferenceTable)
      .where(
        and(
          eq(preferenceTable.scope, ASSISTANT_SIDEBAR_CLEANUP.scope),
          eq(preferenceTable.key, ASSISTANT_SIDEBAR_CLEANUP.shortcutKey)
        )
      )
      .get()
    if (!Array.isArray(row?.value)) return
    if (!row.value.some(targetsRetiredProvider)) return

    db.update(preferenceTable)
      .set({ value: row.value.filter((entry) => !targetsRetiredProvider(entry)) })
      .where(
        and(
          eq(preferenceTable.scope, ASSISTANT_SIDEBAR_CLEANUP.scope),
          eq(preferenceTable.key, ASSISTANT_SIDEBAR_CLEANUP.shortcutKey)
        )
      )
      .run()
  }
}
