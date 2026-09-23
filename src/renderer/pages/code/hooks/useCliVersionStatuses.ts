import { useEffect, useMemo, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import { loggerService } from '@renderer/services/LoggerService'
import { interpretBinarySnapshot } from '@renderer/utils/binarySnapshot'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { BinaryToolSnapshot } from '@shared/types/binary'
import type { CodeCli } from '@shared/types/codeCli'

import type { VersionStatus } from '../types'

const logger = loggerService.withContext('useCliVersionStatus')

const buildStatus = (snapshot: BinaryToolSnapshot | undefined): VersionStatus => {
  const view = interpretBinarySnapshot(snapshot)
  return {
    installed: view.installed,
    source: view.source,
    ...(view.systemPath !== undefined ? { systemPath: view.systemPath } : {})
  }
}

const SNAPSHOT_RETRY_MS = 2000
const SNAPSHOT_MAX_ATTEMPTS = 5

export interface CliVersionStatusesState {
  statuses: Record<string, VersionStatus>
  /** False until a read settles — either successfully or at the retry cap. */
  resolved: boolean
}

/** PATH availability for every CLI tool executable. */
export const useCliVersionStatuses = (toolIds: readonly CodeCli[]): CliVersionStatusesState => {
  const [statuses, setStatuses] = useState<Record<string, VersionStatus>>({})
  const [resolved, setResolved] = useState(false)
  const toolKey = toolIds.join('|')
  const tools = useMemo(() => (toolKey ? (toolKey.split('|') as CodeCli[]) : []), [toolKey])

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const refresh = async () => {
      const binaryNames = tools.map((toolId) => CODE_CLI_TOOL_PRESET_MAP[toolId].executable)
      const snapshots = await ipcApi.request('binary.get_tool_snapshots', binaryNames).catch((error) => {
        logger.error('Failed to get CLI tool snapshots', error as Error)
        return null
      })
      if (cancelled) return
      if (!snapshots) {
        // Nothing else re-runs this read, so without a retry a first attempt that
        // races main-process readiness strands every tool for the session.
        attempts += 1
        if (attempts < SNAPSHOT_MAX_ATTEMPTS) retryTimer = setTimeout(() => void refresh(), SNAPSHOT_RETRY_MS)
        else setResolved(true)
        return
      }

      const next: Record<string, VersionStatus> = {}
      for (const toolId of tools) {
        next[toolId] = buildStatus(snapshots[CODE_CLI_TOOL_PRESET_MAP[toolId].executable])
      }
      setStatuses(next)
      setResolved(true)
    }

    void refresh()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [toolKey, tools])

  return { statuses, resolved }
}
