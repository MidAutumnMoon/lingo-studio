import { notInArray } from 'drizzle-orm'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentSkillTable } from '@data/db/schemas/agentSkill'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const AGENT_ORPHAN_ROW_CLEANUP = {
  orphanedChildren: ['agent_session_message', 'agent_skill']
} as const

/**
 * Migrations run with foreign_keys off, so ON DELETE cascades never fire inside
 * them — data migrations that drop parent rows (0027 removed claude-code
 * agents) leave orphaned children that the boot-time foreign_key_check then
 * reports on every start. Delete the orphans the app cannot reach.
 */
export class AgentOrphanRowCleanupSeeder implements ISeeder {
  readonly name = 'agent-orphan-row-cleanup'
  readonly description = 'Delete agent child rows orphaned by FK-off data migrations'
  readonly version = hashObject(AGENT_ORPHAN_ROW_CLEANUP)

  run(db: DbType): void {
    db.transaction((tx) => {
      tx.delete(agentSessionMessageTable)
        .where(
          notInArray(
            agentSessionMessageTable.sessionId,
            db.select({ id: agentSessionTable.id }).from(agentSessionTable)
          )
        )
        .run()
      tx.delete(agentSkillTable)
        .where(notInArray(agentSkillTable.agentId, db.select({ id: agentTable.id }).from(agentTable)))
        .run()
    })
  }
}
