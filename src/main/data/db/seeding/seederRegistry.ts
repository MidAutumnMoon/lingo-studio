import type { ISeeder } from '../types'
import { AgentOrphanRowCleanupSeeder } from './seeders/AgentOrphanRowCleanupSeeder'
import { AssistantSidebarShortcutCleanupSeeder } from './seeders/AssistantSidebarShortcutCleanupSeeder'
import { BrowserCapabilityUpgradeSeeder } from './seeders/browserCapabilityUpgradeSeeder'
import { BuiltinMcpServerSeeder } from './seeders/builtinMcpServerSeeder'
import { DefaultAssistantSeeder } from './seeders/defaultAssistantSeeder'
import { LegacyFileCleanupPolicySeeder } from './seeders/legacyFileCleanupPolicySeeder'
import { LongTextPastePreferenceUpgradeSeeder } from './seeders/longTextPastePreferenceUpgradeSeeder'
import { PreferenceSeeder } from './seeders/preferenceSeeder'
import { PresetProviderSeeder } from './seeders/presetProviderSeeder'
import { SidebarShortcutMigrationSeeder } from './seeders/sidebarShortcutMigrationSeeder'
import { TranslateLanguageSeeder } from './seeders/translateLanguageSeeder'

/**
 * All seeders in execution order.
 *
 * To add a new seeder: create an ISeeder class, add it to this array.
 * No changes to DbService needed.
 */
export const seeders: ISeeder[] = [
  new BrowserCapabilityUpgradeSeeder(),
  new LegacyFileCleanupPolicySeeder(),
  new DefaultAssistantSeeder(),
  new LongTextPastePreferenceUpgradeSeeder(),
  new SidebarShortcutMigrationSeeder(),
  new AssistantSidebarShortcutCleanupSeeder(),
  new AgentOrphanRowCleanupSeeder(),
  new PreferenceSeeder(),
  new TranslateLanguageSeeder(),
  new PresetProviderSeeder(),
  new BuiltinMcpServerSeeder()
]
