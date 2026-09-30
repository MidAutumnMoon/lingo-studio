import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentGlobalSkillTable } from '@data/db/schemas/agentGlobalSkill'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentSkillTable } from '@data/db/schemas/agentSkill'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { AgentOrphanRowCleanupSeeder } from '@data/db/seeding/seeders/AgentOrphanRowCleanupSeeder'

describe('AgentOrphanRowCleanupSeeder', () => {
  const dbh = setupTestDatabase()
  const seeder = new AgentOrphanRowCleanupSeeder()

  function insertFixtures() {
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: 'workspace-1', name: 'Workspace', path: '/tmp/workspace-1', orderKey: 'a0' })
      .onConflictDoNothing()
      .run()
    dbh.db
      .insert(agentTable)
      .values({ id: 'agent-1', type: 'main', name: 'Agent', instructions: '', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({ id: 'session-1', name: 'Session', workspaceId: 'workspace-1', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentGlobalSkillTable)
      .values({ id: 'skill-1', name: 'Skill', folderName: 'skill-1', source: 'builtin', contentHash: 'hash' })
      .onConflictDoNothing()
      .run()

    // Orphans arise when a migration deletes parents with foreign keys off,
    // so create them the same way.
    dbh.sqlite.pragma('foreign_keys = OFF')
    dbh.db
      .insert(agentSessionMessageTable)
      .values([
        { id: 'message-live', sessionId: 'session-1', role: 'user', data: { parts: [] }, status: 'success' },
        { id: 'message-orphan', sessionId: 'gone-session', role: 'user', data: { parts: [] }, status: 'success' }
      ])
      .run()
    dbh.db
      .insert(agentSkillTable)
      .values([
        { agentId: 'agent-1', skillId: 'skill-1' },
        { agentId: 'gone-agent', skillId: 'skill-1' }
      ])
      .onConflictDoNothing()
      .run()
    dbh.sqlite.pragma('foreign_keys = ON')
  }

  it('deletes orphaned agent child rows and keeps the reachable ones', () => {
    insertFixtures()

    seeder.run(dbh.db)

    const remainingMessages = dbh.db
      .select({ id: agentSessionMessageTable.id })
      .from(agentSessionMessageTable)
      .all()
      .map((row) => row.id)
    expect(remainingMessages).toEqual(['message-live'])

    const remainingSkills = dbh.db
      .select({ agentId: agentSkillTable.agentId })
      .from(agentSkillTable)
      .where(eq(agentSkillTable.skillId, 'skill-1'))
      .all()
      .map((row) => row.agentId)
    expect(remainingSkills).toEqual(['agent-1'])

    // The cleanup must leave the database FK-clean — the boot check reports
    // exactly these violations when they persist.
    expect(dbh.sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('is idempotent — a second pass changes nothing', () => {
    insertFixtures()

    seeder.run(dbh.db)
    seeder.run(dbh.db)

    const remainingMessages = dbh.db
      .select({ id: agentSessionMessageTable.id })
      .from(agentSessionMessageTable)
      .all()
      .map((row) => row.id)
    expect(remainingMessages).toEqual(['message-live'])
  })
})
