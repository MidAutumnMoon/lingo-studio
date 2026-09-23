import { setupTestDatabase } from '@test-helpers/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { preferenceTable } from '@data/db/schemas/preference'
import { AssistantSidebarShortcutCleanupSeeder } from '@data/db/seeding/seeders/AssistantSidebarShortcutCleanupSeeder'
import type { SidebarShortcutItem, SidebarShortcutTarget } from '@shared/data/preference/preferenceTypes'

const CACHE_KEY = 'ui.sidebar_shortcut'

function shortcut(providerId: string, resourceId: string): SidebarShortcutItem {
  const target: SidebarShortcutTarget = { kind: 'resource', locator: { providerId, resourceId } }
  return { type: 'shortcut', id: `sidebar-shortcut:${providerId}:${resourceId}`, target }
}

describe('AssistantSidebarShortcutCleanupSeeder', () => {
  const dbh = setupTestDatabase()
  const seeder = new AssistantSidebarShortcutCleanupSeeder()

  function writeShortcuts(value: unknown) {
    dbh.db.insert(preferenceTable).values({ scope: 'default', key: CACHE_KEY, value }).onConflictDoNothing().run()
  }

  function readShortcuts(): unknown {
    return dbh.db
      .select({ value: preferenceTable.value })
      .from(preferenceTable)
      .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, CACHE_KEY)))
      .get()?.value
  }

  it('drops pinned assistants while leaving every other shortcut in place', () => {
    writeShortcuts([
      shortcut('core.app', 'assistants'),
      shortcut('core.assistant', 'assistant-1'),
      shortcut('core.agent', 'agent-1'),
      shortcut('core.assistant', 'assistant-2')
    ])

    seeder.run(dbh.db)

    expect(readShortcuts()).toEqual([shortcut('core.app', 'assistants'), shortcut('core.agent', 'agent-1')])
  })

  it('leaves the stored list untouched when no assistant shortcut is present', () => {
    const shortcuts = [shortcut('core.app', 'assistants'), shortcut('core.topic', 'topic-1')]
    writeShortcuts(shortcuts)

    seeder.run(dbh.db)

    expect(readShortcuts()).toEqual(shortcuts)
  })

  it('tolerates stored entries that are not shortcuts', () => {
    writeShortcuts([{ type: 'app', id: 'translate' }, shortcut('core.assistant', 'assistant-1')])

    seeder.run(dbh.db)

    expect(readShortcuts()).toEqual([{ type: 'app', id: 'translate' }])
  })
})
