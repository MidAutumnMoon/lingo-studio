import fs from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import { loggerService } from '@logger'
import { toLocalDayKey } from '@main/utils/time'
import type { CacheCleanupGroupResult, CacheCleanupSizeSnapshot } from '@shared/types/cacheCleanupIpc'

import {
  type CacheCleanupIssue,
  type CleanupTarget,
  collectOwnedTargets,
  isNodeError,
  issue,
  measurePaths,
  removeCleanupTarget,
  resultFromSteps,
  toSizeSnapshot
} from './shared'

const logger = loggerService.withContext('CacheCleanup')

// `.log.3` is a size-rolled shard of the same day: file-stream-rotator appends the
// counter after the name, because our `filename` carries the extension and its own is empty.
const LOG_FILE_PATTERN = /\.log(\.\d+)?(\.gz)?$/
const LOG_STAMP_PATTERN = /(\d{4})-(\d{2})-(\d{2})/

/** Calendar days between a file's `YYYY-MM-DD` rotation stamp and today, both local. Null for an impossible stamp. */
export function ageInDays(name: string, now = Date.now()): number | null {
  const match = LOG_STAMP_PATTERN.exec(name)
  if (!match) return null

  const today = toLocalDayKey(now)
  if (today === null) return null
  try {
    return Temporal.PlainDate.from(`${match[1]}-${match[2]}-${match[3]}`).until(Temporal.PlainDate.from(today)).days
  } catch {
    return null
  }
}

export function isRemovable(name: string, minAgeDays: number, now = Date.now()): boolean {
  if (!LOG_FILE_PATTERN.test(name)) return false

  const age = ageInDays(name, now)
  // Undated or impossibly-dated leftovers have no age to weigh against a retention window,
  // so only the manual sweep takes them. Today's files stay open in the rotating transports:
  // removing them would silently drop the rest of today's logs on POSIX and fail on Windows.
  return age === null ? minAgeDays === 0 : age > minAgeDays
}

async function collectLogTargets(minAgeDays: number): Promise<{
  targets: CleanupTarget[]
  issues: CacheCleanupIssue[]
}> {
  const logsDir = application.getPath('app.logs')

  let entries
  try {
    entries = await fs.readdir(logsDir, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { targets: [], issues: [] }
    logger.warn('Failed to enumerate log files', { path: logsDir, error })
    return { targets: [], issues: [issue('logs', 'inspection_failed')] }
  }

  return collectOwnedTargets(
    entries
      .filter((entry) => entry.isFile() && isRemovable(entry.name, minAgeDays))
      .map((entry): CleanupTarget => ({ item: 'logs', path: path.join(entry.parentPath, entry.name), kind: 'file' }))
  )
}

export async function inspectLogs(): Promise<CacheCleanupSizeSnapshot> {
  const { targets, issues } = await collectLogTargets(0)
  const measurement = await measurePaths(targets.map(({ item, path: targetPath }) => ({ item, path: targetPath })))
  measurement.issues.push(...issues)
  return toSizeSnapshot(measurement, 'exact')
}

export async function clearLogs(): Promise<CacheCleanupGroupResult> {
  const { targets, issues } = await collectLogTargets(0)
  const steps = await Promise.all(targets.map(removeCleanupTarget))
  steps.push(...issues.map(() => ({ state: 'skipped' as const })))
  return resultFromSteps('logs', steps)
}

/** Retention sweep: drops dated logs older than `retentionDays`. Returns how many went. */
export async function sweepAgedLogs(retentionDays: number): Promise<number> {
  const { targets } = await collectLogTargets(Math.max(1, Math.floor(retentionDays)))
  const steps = await Promise.all(targets.map(removeCleanupTarget))
  return steps.filter(({ state }) => state === 'cleared').length
}
