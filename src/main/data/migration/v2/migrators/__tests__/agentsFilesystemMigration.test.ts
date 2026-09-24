import type * as FsPromises from 'node:fs/promises'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import PQueue from 'p-queue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@main/core/platform'

import {
  type AgentFileSessionPlan,
  isManagedLegacyAgentWorkspace,
  legacyAgentWorkspacePath,
  stageLegacyAgentFiles
} from '../agentsFilesystemMigration'

const { copyMutation, platformState, realpathFailures } = vi.hoisted(() => ({
  copyMutation: {
    afterCopyFile: undefined as undefined | ((sourcePath: string, destinationPath: string) => Promise<void>),
    copyFileCalls: [] as Array<[sourcePath: string, destinationPath: string]>,
    linkFailure: undefined as undefined | NodeJS.ErrnoException,
    linkCalls: [] as Array<[sourcePath: string, destinationPath: string]>,
    symlinkCalls: [] as Array<[target: string, path: string, type?: string | null]>
  },
  platformState: { isMac: false, isWin: false },
  realpathFailures: new Map<string, NodeJS.ErrnoException>()
}))

vi.mock('@main/core/platform', async (importOriginal) => {
  const original = await importOriginal<typeof Platform>()
  return {
    ...original,
    get isMac() {
      return platformState.isMac
    },
    get isWin() {
      return platformState.isWin
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    copyFile: async (...args: Parameters<typeof original.copyFile>) => {
      copyMutation.copyFileCalls.push([String(args[0]), String(args[1])])
      const result = await original.copyFile(...args)
      await copyMutation.afterCopyFile?.(String(args[0]), String(args[1]))
      return result
    },
    link: async (...args: Parameters<typeof original.link>) => {
      copyMutation.linkCalls.push([String(args[0]), String(args[1])])
      if (copyMutation.linkFailure) throw copyMutation.linkFailure
      return original.link(...args)
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const failure = realpathFailures.get(path.resolve(String(args[0])))
      if (failure) throw failure
      return original.realpath(...args)
    },
    symlink: async (...args: Parameters<typeof original.symlink>) => {
      copyMutation.symlinkCalls.push([String(args[0]), String(args[1]), args[2]])
      return original.symlink(...args)
    }
  }
})

const SOURCE_AGENT_ID = 'agent_1234567890_keykxlx33'
const FINAL_AGENT_ID = '5f83c9de-f186-5d86-813f-1a19f190c68c'
const FINAL_OLD_SESSION_ID = '9a075ce3-c42d-545b-a0b5-f39e43e4a917'
const FINAL_LATEST_SESSION_ID = '01257168-34a7-5ff9-994d-bf78596c777c'

function buildSystemWorkspacePath(systemWorkspacesRoot: string, sessionId: string, createdAt: number): string {
  return path.join(systemWorkspacesRoot, new Date(createdAt).toISOString().slice(0, 10), sessionId)
}

describe('agentsFilesystemMigration', () => {
  const tempRoots: string[] = []

  async function createFixture() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agents-filesystem-migration-'))
    tempRoots.push(tempRoot)
    const agentsDataRoot = path.join(tempRoot, 'Data', 'Agents')
    await mkdir(agentsDataRoot, { recursive: true })
    return {
      tempRoot,
      agentsDataRoot,
      legacyWorkspace: legacyAgentWorkspacePath(agentsDataRoot, SOURCE_AGENT_ID)
    }
  }

  function sessionPlan(
    agentsDataRoot: string,
    legacyWorkspace: string,
    input: {
      sourceSessionId: string
      finalSessionId: string
      createdAt: number
      updatedAt: number
      managed?: boolean
    }
  ): AgentFileSessionPlan {
    const managed = input.managed ?? true
    return {
      sourceSessionId: input.sourceSessionId,
      finalSessionId: input.finalSessionId,
      sourceAgentId: SOURCE_AGENT_ID,
      finalAgentId: FINAL_AGENT_ID,
      sourceWorkspacePath: legacyWorkspace,
      isManagedDefault: managed,
      systemWorkspacePath: managed
        ? buildSystemWorkspacePath(path.join(agentsDataRoot, 'system'), input.finalSessionId, input.createdAt)
        : undefined,
      runtimeResumeTokens: [],
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    }
  }

  afterEach(async () => {
    copyMutation.afterCopyFile = undefined
    copyMutation.copyFileCalls.length = 0
    copyMutation.linkFailure = undefined
    copyMutation.linkCalls.length = 0
    copyMutation.symlinkCalls.length = 0
    realpathFailures.clear()
    platformState.isMac = false
    platformState.isWin = false
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true })))
  })

  it.runIf(process.platform !== 'win32')(
    'skips top-level workspace symlinks without attempting to recreate them on Windows',
    async () => {
      const { tempRoot, agentsDataRoot, legacyWorkspace } = await createFixture()
      const sharedDirectory = path.join(tempRoot, 'shared-directory')
      const sourceLink = path.join(legacyWorkspace, 'shared-directory')
      await mkdir(sharedDirectory, { recursive: true })
      await writeFile(path.join(sharedDirectory, 'shared.txt'), 'shared content')
      await mkdir(legacyWorkspace, { recursive: true })
      await symlink(sharedDirectory, sourceLink, 'dir')
      copyMutation.symlinkCalls.length = 0
      platformState.isWin = true

      const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
        sourceSessionId: 'session_latest',
        finalSessionId: FINAL_LATEST_SESSION_ID,
        createdAt: Date.parse('2026-07-22T00:00:00Z'),
        updatedAt: Date.parse('2026-07-23T00:00:00Z')
      })

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })

      await expect(access(path.join(latestSession.systemWorkspacePath!, 'shared-directory'))).rejects.toThrow()
      expect(copyMutation.symlinkCalls).toEqual([])
    }
  )

  it.runIf(process.platform !== 'win32')('splits identity from workspace content and skips every symlink', async () => {
    const { tempRoot, agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(path.join(legacyWorkspace, 'memory'), { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'identity-source.md'), 'agent soul')
    await symlink('identity-source.md', path.join(legacyWorkspace, 'SOUL.md'))
    await writeFile(path.join(legacyWorkspace, 'USER.md'), 'agent user')
    await symlink('SOUL.md', path.join(legacyWorkspace, 'soul-link'))
    await symlink(path.join(legacyWorkspace, 'USER.md'), path.join(legacyWorkspace, 'absolute-user-link'))
    await writeFile(path.join(legacyWorkspace, 'fact-source.md'), 'remember this')
    await symlink('../fact-source.md', path.join(legacyWorkspace, 'memory', 'FACT.md'))
    await symlink('memory/FACT.md', path.join(legacyWorkspace, 'memory-link'))
    await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'workspace content')
    await symlink('ordinary.txt', path.join(legacyWorkspace, 'relative-link'))
    const sharedTarget = path.join(agentsDataRoot, 'shared', 'target.txt')
    await mkdir(path.dirname(sharedTarget), { recursive: true })
    await writeFile(sharedTarget, 'shared target')
    await symlink('../shared/target.txt', path.join(legacyWorkspace, 'external-relative-link'))
    await mkdir(path.join(legacyWorkspace, 'nested'))
    await symlink('../../shared/target.txt', path.join(legacyWorkspace, 'nested', 'external-relative-link'))
    const absoluteTarget = path.join(tempRoot, 'absolute-target.txt')
    await writeFile(absoluteTarget, 'external target')
    await symlink(absoluteTarget, path.join(legacyWorkspace, 'absolute-link'))
    await symlink('missing-target', path.join(legacyWorkspace, 'dangling-link'))

    const oldSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_old',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-07-20T00:00:00Z'),
      updatedAt: Date.parse('2026-07-21T00:00:00Z')
    })
    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })

    const input = {
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [oldSession, latestSession]
    }
    await stageLegacyAgentFiles(input)

    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('')
    expect((await lstat(path.join(agentDataPath, 'SOUL.md'))).isSymbolicLink()).toBe(false)
    expect(await readFile(path.join(agentDataPath, 'USER.md'), 'utf8')).toBe('agent user')
    await expect(access(path.join(agentDataPath, 'memory', 'FACT.md'))).rejects.toThrow()

    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'ordinary.txt'), 'utf8')).toBe(
      'workspace content'
    )
    for (const skippedEntry of [
      'relative-link',
      'external-relative-link',
      'absolute-link',
      'dangling-link',
      'soul-link',
      'absolute-user-link',
      'memory-link'
    ]) {
      await expect(access(path.join(latestSession.systemWorkspacePath!, skippedEntry))).rejects.toThrow()
    }
    await expect(
      access(path.join(latestSession.systemWorkspacePath!, 'nested', 'external-relative-link'))
    ).rejects.toThrow()
    // The shared v1 workspace is materialized only into the latest session; the
    // older session keeps an empty system workspace (issue #17830).
    expect((await lstat(oldSession.systemWorkspacePath!)).isDirectory()).toBe(true)
    expect(await readdir(oldSession.systemWorkspacePath!)).toEqual([])

    // The complete v1 workspace remains available for downgrade compatibility
    // even after the v2 destinations have been verified and published.
    expect(await readFile(path.join(legacyWorkspace, 'SOUL.md'), 'utf8')).toBe('agent soul')
    expect((await lstat(path.join(legacyWorkspace, 'SOUL.md'))).isSymbolicLink()).toBe(true)
    expect(await readFile(path.join(legacyWorkspace, 'USER.md'), 'utf8')).toBe('agent user')
    expect(await readFile(path.join(legacyWorkspace, 'memory', 'FACT.md'), 'utf8')).toBe('remember this')
    expect(await readFile(path.join(legacyWorkspace, 'ordinary.txt'), 'utf8')).toBe('workspace content')

    // Stable remapped IDs make a retry converge on the same destinations.
    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 0 })
    expect(await readFile(path.join(legacyWorkspace, 'ordinary.txt'), 'utf8')).toBe('workspace content')
    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'ordinary.txt'), 'utf8')).toBe(
      'workspace content'
    )
  })

  it('copies the shared workspace content only into the most recently active managed session', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'workspace content')

    const oldSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_old',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-05-01T00:00:00Z'),
      updatedAt: Date.parse('2026-05-02T00:00:00Z')
    })
    const recentSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [oldSession, recentSession]
    })

    // Every managed session still gets its own system workspace directory, but the
    // shared v1 content lands only in the latest one (issue #17830).
    expect((await lstat(oldSession.systemWorkspacePath!)).isDirectory()).toBe(true)
    expect(await readdir(oldSession.systemWorkspacePath!)).toEqual([])
    expect(await readFile(path.join(recentSession.systemWorkspacePath!, 'ordinary.txt'), 'utf8')).toBe(
      'workspace content'
    )
  })

  it('copies a workspace shared by many managed sessions exactly once', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceFile = path.join(legacyWorkspace, 'ordinary.txt')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourceFile, 'workspace content')

    // Many historical sessions sharing one v1 default workspace must not fan the
    // source out into one full copy per session (issue #17830 → ENOSPC).
    const sessions = Array.from({ length: 12 }, (_, index) =>
      sessionPlan(agentsDataRoot, legacyWorkspace, {
        sourceSessionId: `session_${index.toString().padStart(2, '0')}`,
        finalSessionId: `0000000${index.toString(16).padStart(4, '0')}-34a7-5ff9-994d-bf78596c777c`,
        createdAt: Date.parse('2026-05-01T00:00:00Z') + index * 86_400_000,
        updatedAt: Date.parse('2026-05-02T00:00:00Z') + index * 86_400_000
      })
    )
    const latestSession = sessions.at(-1)!

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions
    })

    expect(copyMutation.copyFileCalls.filter(([sourcePath]) => sourcePath === sourceFile)).toHaveLength(1)
    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'ordinary.txt'), 'utf8')).toBe(
      'workspace content'
    )
    for (const session of sessions.slice(0, -1)) {
      expect(await readdir(session.systemWorkspacePath!)).toEqual([])
    }
  })

  it('bounds and continuously refills filesystem work for a high-fan-out workspace', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceBundle = path.join(legacyWorkspace, 'bundle', 'nested')
    const fileCount = 64
    await mkdir(sourceBundle, { recursive: true })
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        writeFile(path.join(sourceBundle, `file-${index.toString().padStart(3, '0')}.txt`), `content ${index}`)
      )
    )

    const session = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const originalAdd = PQueue.prototype.add
    let maxRunning = 0
    let maxOutstanding = 0
    const trackedAdd = function (this: PQueue, ...args: Parameters<PQueue['add']>): ReturnType<PQueue['add']> {
      const result = originalAdd.apply(this, args)
      maxRunning = Math.max(maxRunning, this.pending)
      maxOutstanding = Math.max(maxOutstanding, this.pending + this.size)
      return result
    }
    const addSpy = vi.spyOn(PQueue.prototype, 'add').mockImplementation(trackedAdd as PQueue['add'])
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    copyMutation.afterCopyFile = async (sourcePath) => {
      if (sourcePath.endsWith('file-000.txt')) await firstBlocked
    }

    try {
      const migration = stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [session]
      })
      try {
        await vi.waitFor(
          () => {
            expect(copyMutation.copyFileCalls.some(([source]) => source.endsWith('file-016.txt'))).toBe(true)
          },
          { timeout: 10_000 }
        )
      } finally {
        releaseFirst()
        await migration
      }
    } finally {
      addSpy.mockRestore()
    }

    expect(maxRunning).toBeGreaterThan(1)
    expect(maxOutstanding).toBeLessThanOrEqual(16)
    expect(await readdir(path.join(session.systemWorkspacePath!, 'bundle', 'nested'))).toHaveLength(fileCount)
  })

  it('verifies the first private copy before publishing it', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceFile = path.join(legacyWorkspace, 'ordinary.txt')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourceFile, 'AAAA')

    const session = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    copyMutation.afterCopyFile = async (copiedSourcePath, copiedDestinationPath) => {
      if (
        copiedSourcePath !== sourceFile ||
        !path.basename(copiedDestinationPath).startsWith(`.${FINAL_LATEST_SESSION_ID}.migration-`)
      ) {
        return
      }
      await writeFile(copiedDestinationPath, 'BBBB')
    }

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [session]
      })
    ).rejects.toThrow(/copy verification failed/)

    expect(await readFile(sourceFile, 'utf8')).toBe('AAAA')
    await expect(access(path.join(session.systemWorkspacePath!, 'ordinary.txt'))).rejects.toThrow()
  })

  it.runIf(process.platform !== 'win32')(
    'copies regular directory content while skipping nested symlinks',
    async () => {
      const { agentsDataRoot, legacyWorkspace } = await createFixture()
      const sourceBundle = path.join(legacyWorkspace, 'bundle')
      await mkdir(sourceBundle, { recursive: true })
      await writeFile(path.join(sourceBundle, 'payload.txt'), 'workspace content')
      await symlink('payload.txt', path.join(sourceBundle, 'payload-link'))
      await symlink(path.join(sourceBundle, 'payload.txt'), path.join(sourceBundle, 'absolute-payload-link'))

      const oldSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
        sourceSessionId: 'session_old',
        finalSessionId: FINAL_OLD_SESSION_ID,
        createdAt: Date.parse('2026-05-01T00:00:00Z'),
        updatedAt: Date.parse('2026-05-02T00:00:00Z')
      })
      const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
        sourceSessionId: 'session_latest',
        finalSessionId: FINAL_LATEST_SESSION_ID,
        createdAt: Date.parse('2026-07-22T00:00:00Z'),
        updatedAt: Date.parse('2026-07-23T00:00:00Z')
      })

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [oldSession, latestSession]
      })

      expect(
        copyMutation.copyFileCalls.filter(([sourcePath]) => sourcePath === path.join(sourceBundle, 'payload.txt'))
      ).toHaveLength(1)
      expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'bundle', 'payload.txt'), 'utf8')).toBe(
        'workspace content'
      )
      await expect(access(path.join(latestSession.systemWorkspacePath!, 'bundle', 'payload-link'))).rejects.toThrow()
      await expect(
        access(path.join(latestSession.systemWorkspacePath!, 'bundle', 'absolute-payload-link'))
      ).rejects.toThrow()
      expect(await readdir(oldSession.systemWorkspacePath!)).toEqual([])
    }
  )

  it('publishes the verified workspace snapshot if the source changes after its private copy', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceFile = path.join(legacyWorkspace, 'ordinary.txt')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourceFile, 'original workspace content')

    const oldSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_old',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-05-01T00:00:00Z'),
      updatedAt: Date.parse('2026-05-02T00:00:00Z')
    })
    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    copyMutation.afterCopyFile = async (copiedSourcePath) => {
      if (copiedSourcePath !== sourceFile) return
      copyMutation.afterCopyFile = undefined
      await writeFile(sourceFile, 'changed workspace content')
    }

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [oldSession, latestSession]
    })

    expect(await readFile(sourceFile, 'utf8')).toBe('changed workspace content')
    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'ordinary.txt'), 'utf8')).toBe(
      'original workspace content'
    )
    expect(await readdir(oldSession.systemWorkspacePath!)).toEqual([])
  })

  it('keeps the newest identity entry when first-migration sources differ', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const olderWorkspace = path.join(tempRoot, 'older-workspace')
    const newestWorkspace = path.join(tempRoot, 'newest-workspace')
    await mkdir(olderWorkspace, { recursive: true })
    await mkdir(newestWorkspace, { recursive: true })
    await writeFile(path.join(olderWorkspace, 'SOUL.md'), 'older soul')
    await writeFile(path.join(newestWorkspace, 'SOUL.md'), 'newest soul')

    const olderSession = sessionPlan(agentsDataRoot, olderWorkspace, {
      sourceSessionId: 'session_old',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-07-20T00:00:00Z'),
      updatedAt: Date.parse('2026-07-21T00:00:00Z'),
      managed: false
    })
    const newestSession = sessionPlan(agentsDataRoot, newestWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [olderSession, newestSession]
    })

    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('newest soul')
    expect(await readFile(path.join(newestWorkspace, 'SOUL.md'), 'utf8')).toBe('newest soul')
    expect(await readFile(path.join(olderWorkspace, 'SOUL.md'), 'utf8')).toBe('older soul')
  })

  it('fills identity entries missing from the newest source using the next source', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const olderWorkspace = path.join(tempRoot, 'older-workspace')
    const newestWorkspace = path.join(tempRoot, 'newest-workspace')
    await mkdir(path.join(olderWorkspace, 'memory'), { recursive: true })
    await mkdir(newestWorkspace, { recursive: true })
    await writeFile(path.join(newestWorkspace, 'SOUL.md'), 'newest soul')
    await writeFile(path.join(olderWorkspace, 'USER.md'), 'fallback user')
    await writeFile(path.join(olderWorkspace, 'memory', 'FACT.md'), 'fallback fact')

    const olderSession = sessionPlan(agentsDataRoot, olderWorkspace, {
      sourceSessionId: 'session_old',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-07-20T00:00:00Z'),
      updatedAt: Date.parse('2026-07-21T00:00:00Z'),
      managed: false
    })
    const newestSession = sessionPlan(agentsDataRoot, newestWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [olderSession, newestSession]
    })

    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('newest soul')
    expect(await readFile(path.join(agentDataPath, 'USER.md'), 'utf8')).toBe('fallback user')
    expect(await readFile(path.join(agentDataPath, 'memory', 'FACT.md'), 'utf8')).toBe('fallback fact')
  })

  it('allows identity source metadata to change when its content stays unchanged', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourcePath = path.join(legacyWorkspace, 'USER.md')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourcePath, 'user identity')
    const originalStat = await stat(sourcePath)
    copyMutation.afterCopyFile = async (copiedSourcePath) => {
      if (copiedSourcePath !== sourcePath) return
      await utimes(sourcePath, originalStat.atime, new Date(originalStat.mtimeMs + 60_000))
    }

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: []
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'USER.md'), 'utf8')).toBe('user identity')
  })

  it('publishes the verified identity snapshot when source content changes after it is copied', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourcePath = path.join(legacyWorkspace, 'USER.md')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourcePath, 'original identity')
    copyMutation.afterCopyFile = async (copiedSourcePath) => {
      if (copiedSourcePath !== sourcePath) return
      await writeFile(sourcePath, 'changed identity')
    }

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: []
    })

    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    expect(await readFile(path.join(agentDataPath, 'USER.md'), 'utf8')).toBe('original identity')
    expect((await readdir(agentDataPath)).every((entry) => !entry.startsWith('.USER.md.migration-'))).toBe(true)
    expect(await readFile(sourcePath, 'utf8')).toBe('changed identity')
  })

  it.runIf(process.platform !== 'win32')(
    'skips a symlinked identity entry and falls back to an older real identity file',
    async () => {
      const { tempRoot, agentsDataRoot } = await createFixture()
      const olderWorkspace = path.join(tempRoot, 'older-workspace')
      const newestWorkspace = path.join(tempRoot, 'newest-workspace')
      const newestIdentitySource = path.join(newestWorkspace, 'identity-source.md')
      const newestSoulPath = path.join(newestWorkspace, 'SOUL.md')
      const olderSoulPath = path.join(olderWorkspace, 'SOUL.md')
      await mkdir(olderWorkspace, { recursive: true })
      await mkdir(newestWorkspace, { recursive: true })
      await writeFile(newestIdentitySource, 'newest soul')
      await symlink('identity-source.md', newestSoulPath)
      await writeFile(olderSoulPath, 'older soul')

      const olderSession = sessionPlan(agentsDataRoot, olderWorkspace, {
        sourceSessionId: 'session_old',
        finalSessionId: FINAL_OLD_SESSION_ID,
        createdAt: Date.parse('2026-07-20T00:00:00Z'),
        updatedAt: Date.parse('2026-07-21T00:00:00Z'),
        managed: false
      })
      const newestSession = sessionPlan(agentsDataRoot, newestWorkspace, {
        sourceSessionId: 'session_latest',
        finalSessionId: FINAL_LATEST_SESSION_ID,
        createdAt: Date.parse('2026-07-22T00:00:00Z'),
        updatedAt: Date.parse('2026-07-23T00:00:00Z'),
        managed: false
      })

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [olderSession, newestSession]
      })

      const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
      expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('older soul')
      expect((await readdir(agentDataPath)).every((entry) => !entry.startsWith('.SOUL.md.migration-'))).toBe(true)
      expect(await readlink(newestSoulPath)).toBe('identity-source.md')
      expect(await readFile(newestIdentitySource, 'utf8')).toBe('newest soul')
      expect(await readFile(olderSoulPath, 'utf8')).toBe('older soul')
    }
  )

  it('preserves an overlapping source while clearing unrelated stale targets', async () => {
    const { agentsDataRoot } = await createFixture()
    const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
    const overlappingSource = path.join(agentsDataRoot, 'overlap')
    await mkdir(preservedTarget, { recursive: true })
    await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')
    await mkdir(overlappingSource, { recursive: true })
    await writeFile(path.join(overlappingSource, 'SOUL.md'), 'legacy source')

    const externalSession = sessionPlan(agentsDataRoot, overlappingSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    externalSession.sourceAgentId = 'source-owner'
    externalSession.finalAgentId = 'source-owner-final'

    const input = {
      agentsDataRoot,
      agents: [
        { sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID },
        { sourceAgentId: 'target-owner', finalAgentId: 'overlap' },
        { sourceAgentId: 'source-owner', finalAgentId: 'source-owner-final' }
      ],
      sessions: [externalSession]
    }

    const result = await stageLegacyAgentFiles(input)

    expect(result.skippedTargetCount).toBe(1)
    await expect(access(path.join(preservedTarget, 'keep.txt'))).rejects.toThrow()
    expect(await readFile(path.join(overlappingSource, 'SOUL.md'), 'utf8')).toBe('legacy source')
    expect(await readFile(path.join(agentsDataRoot, 'source-owner-final', 'SOUL.md'), 'utf8')).toBe('legacy source')

    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 1 })
    expect(await readFile(path.join(overlappingSource, 'SOUL.md'), 'utf8')).toBe('legacy source')
    expect(await readFile(path.join(agentsDataRoot, 'source-owner-final', 'SOUL.md'), 'utf8')).toBe('legacy source')
  })

  it('skips filesystem output when an external virtual-drive workspace cannot be resolved', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const externalWorkspace = path.join(tempRoot, 'virtual-drive')
    await mkdir(externalWorkspace)
    await writeFile(path.join(externalWorkspace, 'SOUL.md'), 'cloud workspace')

    const externalSession = sessionPlan(agentsDataRoot, externalWorkspace, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    const realpathError = Object.assign(new Error(`UNKNOWN: unknown error, realpath '${externalWorkspace}'`), {
      code: 'UNKNOWN',
      errno: -4094,
      path: externalWorkspace,
      syscall: 'realpath'
    })
    realpathFailures.set(path.resolve(externalWorkspace), realpathError)

    const input = {
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    }

    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 1 })
    expect(await readFile(path.join(externalWorkspace, 'SOUL.md'), 'utf8')).toBe('cloud workspace')
    await expect(access(path.join(agentsDataRoot, FINAL_AGENT_ID))).rejects.toThrow()
    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 1 })
  })

  it('preserves existing targets when an external virtual-drive workspace cannot be resolved', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const externalWorkspace = path.join(tempRoot, 'virtual-drive')
    const existingTargetId = 'existing-target'
    const existingTarget = path.join(agentsDataRoot, existingTargetId)
    await mkdir(externalWorkspace)
    await writeFile(path.join(externalWorkspace, 'SOUL.md'), 'cloud workspace')
    await mkdir(existingTarget)
    await writeFile(path.join(existingTarget, 'keep.txt'), 'keep existing target')

    const externalSession = sessionPlan(agentsDataRoot, externalWorkspace, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    realpathFailures.set(
      path.resolve(externalWorkspace),
      Object.assign(new Error(`UNKNOWN: unknown error, realpath '${externalWorkspace}'`), {
        code: 'UNKNOWN',
        errno: -4094,
        path: externalWorkspace,
        syscall: 'realpath'
      })
    )

    const input = {
      agentsDataRoot,
      agents: [
        { sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID },
        { sourceAgentId: 'unrelated-source', finalAgentId: existingTargetId }
      ],
      sessions: [externalSession]
    }

    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 2 })
    expect(await readFile(path.join(externalWorkspace, 'SOUL.md'), 'utf8')).toBe('cloud workspace')
    expect(await readFile(path.join(existingTarget, 'keep.txt'), 'utf8')).toBe('keep existing target')
    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 2 })
    expect(await readFile(path.join(existingTarget, 'keep.txt'), 'utf8')).toBe('keep existing target')
  })

  it('keeps realpath UNKNOWN fatal for a source inside the agents root', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    const managedSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_managed',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    realpathFailures.set(
      path.resolve(legacyWorkspace),
      Object.assign(new Error(`UNKNOWN: unknown error, realpath '${legacyWorkspace}'`), {
        code: 'UNKNOWN',
        errno: -4094,
        path: legacyWorkspace,
        syscall: 'realpath'
      })
    )

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [managedSession]
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN', syscall: 'realpath' })
  })

  it('keeps realpath UNKNOWN fatal for a case-only agents root on Windows', async () => {
    const { agentsDataRoot } = await createFixture()
    platformState.isWin = true
    const caseVariantRoot = agentsDataRoot.toUpperCase()
    const managedSession = sessionPlan(agentsDataRoot, caseVariantRoot, {
      sourceSessionId: 'session_managed',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    realpathFailures.set(
      path.resolve(caseVariantRoot),
      Object.assign(new Error(`UNKNOWN: unknown error, realpath '${caseVariantRoot}'`), {
        code: 'UNKNOWN',
        errno: -4094,
        path: caseVariantRoot,
        syscall: 'realpath'
      })
    )

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [managedSession]
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN', syscall: 'realpath' })
  })

  it('preserves an Agent target that is also its own legacy Session workspace', async () => {
    const { agentsDataRoot } = await createFixture()
    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(path.join(agentDataPath, 'memory'), { recursive: true })
    await writeFile(path.join(agentDataPath, 'SOUL.md'), 'legacy soul')
    await writeFile(path.join(agentDataPath, 'USER.md'), 'legacy user')
    await writeFile(path.join(agentDataPath, 'workspace.txt'), 'legacy workspace')

    const externalSession = sessionPlan(agentsDataRoot, agentDataPath, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    expect(await readFile(path.join(agentDataPath, 'USER.md'), 'utf8')).toBe('legacy user')
    expect(await readFile(path.join(agentDataPath, 'workspace.txt'), 'utf8')).toBe('legacy workspace')
  })

  it('preserves an Agent target when another Agent also references its legacy workspace', async () => {
    const { agentsDataRoot } = await createFixture()
    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(path.join(agentDataPath, 'memory'), { recursive: true })
    await writeFile(path.join(agentDataPath, 'SOUL.md'), 'shared legacy soul')
    await writeFile(path.join(agentDataPath, 'memory', 'FACT.md'), 'shared legacy memory')
    await writeFile(path.join(agentDataPath, 'workspace.txt'), 'shared legacy workspace')

    const otherAgentSession = sessionPlan(agentsDataRoot, agentDataPath, {
      sourceSessionId: 'other_agent_session',
      finalSessionId: FINAL_OLD_SESSION_ID,
      createdAt: Date.parse('2026-07-20T00:00:00Z'),
      updatedAt: Date.parse('2026-07-21T00:00:00Z'),
      managed: false
    })
    otherAgentSession.sourceAgentId = 'other-source-agent'
    otherAgentSession.finalAgentId = 'other-final-agent'
    const owningAgentSession = sessionPlan(agentsDataRoot, agentDataPath, {
      sourceSessionId: 'owning_agent_session',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    const input = {
      agentsDataRoot,
      agents: [
        { sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID },
        { sourceAgentId: 'other-source-agent', finalAgentId: 'other-final-agent' }
      ],
      sessions: [otherAgentSession, owningAgentSession]
    }

    await stageLegacyAgentFiles(input)

    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('shared legacy soul')
    expect(await readFile(path.join(agentDataPath, 'memory', 'FACT.md'), 'utf8')).toBe('shared legacy memory')
    expect(await readFile(path.join(agentDataPath, 'workspace.txt'), 'utf8')).toBe('shared legacy workspace')
    expect(await readFile(path.join(agentsDataRoot, 'other-final-agent', 'SOUL.md'), 'utf8')).toBe('shared legacy soul')

    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 0 })
    expect(await readFile(path.join(agentDataPath, 'workspace.txt'), 'utf8')).toBe('shared legacy workspace')
  })

  it.each([
    { platform: 'macOS', isMac: true, isWin: false },
    { platform: 'Windows', isMac: false, isWin: true }
  ])('preserves a same-Agent case-only source/target overlap on $platform', async ({ isMac, isWin }) => {
    platformState.isMac = isMac
    platformState.isWin = isWin
    const { agentsDataRoot } = await createFixture()
    const finalAgentId = 'CaseSensitiveTarget'
    const agentDataPath = path.join(agentsDataRoot, finalAgentId)
    const caseVariantSource = path.join(agentsDataRoot, finalAgentId.toLowerCase())
    await mkdir(agentDataPath, { recursive: true })
    await writeFile(path.join(agentDataPath, 'keep.txt'), 'preserved target')
    await mkdir(caseVariantSource, { recursive: true })
    await writeFile(path.join(caseVariantSource, 'SOUL.md'), 'legacy soul')

    const externalSession = sessionPlan(agentsDataRoot, caseVariantSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    externalSession.finalAgentId = finalAgentId

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(agentDataPath, 'keep.txt'), 'utf8')).toBe('preserved target')
    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    expect(await readFile(path.join(caseVariantSource, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it('rejects nested cleanup targets before deleting either destination', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(preservedTarget, { recursive: true })
    await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    latestSession.systemWorkspacePath = path.join(preservedTarget, 'nested-session')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).rejects.toThrow(/cleanup targets overlap/i)

    expect(await readFile(path.join(preservedTarget, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it('skips an Agent target containing a nested legacy source', async () => {
    const { agentsDataRoot } = await createFixture()
    const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
    const nestedSource = path.join(preservedTarget, 'legacy-source')
    await mkdir(nestedSource, { recursive: true })
    await writeFile(path.join(nestedSource, 'SOUL.md'), 'legacy source')

    const externalSession = sessionPlan(agentsDataRoot, nestedSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(nestedSource, 'SOUL.md'), 'utf8')).toBe('legacy source')
  })

  it('skips an Agent target nested inside a legacy source', async () => {
    const { agentsDataRoot } = await createFixture()
    const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(preservedTarget, { recursive: true })
    await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')

    const externalSession = sessionPlan(agentsDataRoot, agentsDataRoot, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(preservedTarget, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it('skips a managed Session target that overlaps its legacy workspace', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'legacy soul')
    await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'legacy workspace')

    const session = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_overlap',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    session.systemWorkspacePath = legacyWorkspace

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [session]
    })

    expect(await readFile(path.join(legacyWorkspace, 'ordinary.txt'), 'utf8')).toBe('legacy workspace')
    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it('does not treat a path-component prefix as an ancestor', async () => {
    const { agentsDataRoot } = await createFixture()
    const prefixSource = path.join(agentsDataRoot, `${FINAL_AGENT_ID}-legacy`)
    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(prefixSource, { recursive: true })
    await writeFile(path.join(prefixSource, 'SOUL.md'), 'legacy soul')
    await mkdir(agentDataPath, { recursive: true })
    await writeFile(path.join(agentDataPath, 'stale.txt'), 'stale target')

    const externalSession = sessionPlan(agentsDataRoot, prefixSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    await expect(access(path.join(agentDataPath, 'stale.txt'))).rejects.toThrow()
    expect(await readFile(path.join(prefixSource, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it.each([
    { platform: 'macOS', isMac: true, isWin: false },
    { platform: 'Windows', isMac: false, isWin: true }
  ])('skips cross-Agent case-only path overlaps on $platform', async ({ isMac, isWin }) => {
    platformState.isMac = isMac
    platformState.isWin = isWin
    const { agentsDataRoot } = await createFixture()
    const finalAgentId = 'CaseSensitiveTarget'
    const preservedTarget = path.join(agentsDataRoot, finalAgentId)
    const caseVariantSource = path.join(agentsDataRoot, finalAgentId.toLowerCase())
    await mkdir(preservedTarget, { recursive: true })
    await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')

    const externalSession = sessionPlan(agentsDataRoot, caseVariantSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    externalSession.sourceAgentId = 'other-source-agent'
    externalSession.finalAgentId = 'other-final-agent'

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [
        { sourceAgentId: SOURCE_AGENT_ID, finalAgentId },
        { sourceAgentId: 'other-source-agent', finalAgentId: 'other-final-agent' }
      ],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(preservedTarget, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it('rejects case-only cleanup target duplicates on case-insensitive platforms', async () => {
    platformState.isMac = true
    const { agentsDataRoot } = await createFixture()
    const firstTarget = path.join(agentsDataRoot, 'CaseSensitiveTarget')
    await mkdir(firstTarget, { recursive: true })
    await writeFile(path.join(firstTarget, 'keep.txt'), 'keep me')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [
          { sourceAgentId: 'source-agent-one', finalAgentId: 'CaseSensitiveTarget' },
          { sourceAgentId: 'source-agent-two', finalAgentId: 'casesensitivetarget' }
        ],
        sessions: []
      })
    ).rejects.toThrow(/cleanup targets overlap/i)

    expect(await readFile(path.join(firstTarget, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it.runIf(process.platform === 'linux')('keeps case-only path variants distinct on Linux', async () => {
    const { agentsDataRoot } = await createFixture()
    const finalAgentId = 'CaseSensitiveTarget'
    const agentDataPath = path.join(agentsDataRoot, finalAgentId)
    const caseVariantSource = path.join(agentsDataRoot, finalAgentId.toLowerCase())
    await mkdir(caseVariantSource, { recursive: true })
    await writeFile(path.join(caseVariantSource, 'SOUL.md'), 'legacy soul')
    await mkdir(agentDataPath, { recursive: true })
    await writeFile(path.join(agentDataPath, 'stale.txt'), 'stale target')

    const externalSession = sessionPlan(agentsDataRoot, caseVariantSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    expect(await readFile(path.join(caseVariantSource, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it.runIf(process.platform !== 'win32')('skips a target whose real path is also a legacy source', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
    const linkedSource = path.join(tempRoot, 'linked-source')
    await mkdir(preservedTarget, { recursive: true })
    await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')
    await symlink(preservedTarget, linkedSource)

    const externalSession = sessionPlan(agentsDataRoot, linkedSource, {
      sourceSessionId: 'session_external',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [externalSession]
    })

    expect(await readFile(path.join(preservedTarget, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it.runIf(process.platform !== 'win32')(
    'skips an absent target whose resolved parent is a legacy source',
    async () => {
      const { tempRoot, agentsDataRoot } = await createFixture()
      const linkedSource = path.join(tempRoot, 'linked-source')
      const session = sessionPlan(agentsDataRoot, linkedSource, {
        sourceSessionId: 'session_resolved_parent_overlap',
        finalSessionId: FINAL_LATEST_SESSION_ID,
        createdAt: Date.parse('2026-07-22T00:00:00Z'),
        updatedAt: Date.parse('2026-07-23T00:00:00Z')
      })
      const targetPath = session.systemWorkspacePath!
      const targetParent = path.dirname(targetPath)
      await mkdir(targetParent, { recursive: true })
      await writeFile(path.join(targetParent, 'SOUL.md'), 'legacy source')
      await symlink(targetParent, linkedSource)

      const result = await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [session]
      })

      expect(result.skippedTargetCount).toBe(1)
      await expect(access(targetPath)).rejects.toThrow()
      expect(await readFile(path.join(targetParent, 'SOUL.md'), 'utf8')).toBe('legacy source')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'removes a destination symlink without touching its external target',
    async () => {
      const { tempRoot, agentsDataRoot, legacyWorkspace } = await createFixture()
      const externalTarget = path.join(tempRoot, 'external-target')
      const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
      await mkdir(legacyWorkspace, { recursive: true })
      await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'legacy soul')
      await mkdir(externalTarget)
      await writeFile(path.join(externalTarget, 'keep.txt'), 'external data')
      await symlink(externalTarget, agentDataPath)

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: []
      })

      expect((await lstat(agentDataPath)).isDirectory()).toBe(true)
      expect((await lstat(agentDataPath)).isSymbolicLink()).toBe(false)
      expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
      expect(await readFile(path.join(externalTarget, 'keep.txt'), 'utf8')).toBe('external data')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked cleanup parent before deleting another destination',
    async () => {
      const { tempRoot, agentsDataRoot, legacyWorkspace } = await createFixture()
      const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
        sourceSessionId: 'session_latest',
        finalSessionId: FINAL_LATEST_SESSION_ID,
        createdAt: Date.parse('2026-07-22T00:00:00Z'),
        updatedAt: Date.parse('2026-07-23T00:00:00Z')
      })
      const preservedTarget = path.join(agentsDataRoot, FINAL_AGENT_ID)
      const externalSystemRoot = path.join(tempRoot, 'external-system')
      await mkdir(legacyWorkspace, { recursive: true })
      await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'legacy workspace')
      await mkdir(preservedTarget)
      await writeFile(path.join(preservedTarget, 'keep.txt'), 'keep me')
      await mkdir(externalSystemRoot)
      await writeFile(path.join(externalSystemRoot, 'keep.txt'), 'external data')
      await symlink(externalSystemRoot, path.join(agentsDataRoot, 'system'))

      await expect(
        stageLegacyAgentFiles({
          agentsDataRoot,
          agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
          sessions: [latestSession]
        })
      ).rejects.toThrow(/contains a symbolic link/i)

      expect(await readFile(path.join(preservedTarget, 'keep.txt'), 'utf8')).toBe('keep me')
      expect(await readFile(path.join(externalSystemRoot, 'keep.txt'), 'utf8')).toBe('external data')
    }
  )

  it('preserves an Agent data directory that already contains identity files', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'legacy soul')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(agentDataPath, { recursive: true })
    await writeFile(path.join(agentDataPath, 'SOUL.md'), 'existing soul')
    await writeFile(path.join(agentDataPath, 'V2-ONLY.md'), 'stale agent data')

    const input = {
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [latestSession]
    }

    // First run: source exists, target is cleared and re-populated.
    const result1 = await stageLegacyAgentFiles(input)
    expect(result1.skippedTargetCount).toBe(0)
    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    // V2-ONLY.md is removed because the target was cleared.
    await expect(access(path.join(agentDataPath, 'V2-ONLY.md'))).rejects.toThrow()

    // Remove the v1 source workspace to simulate an app update cleanup.
    await rm(legacyWorkspace, { recursive: true })

    // Second run: source is gone, target with identity files is preserved.
    const result2 = await stageLegacyAgentFiles(input)
    expect(result2.skippedTargetCount).toBe(1)
    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it('replaces an existing identity target without changing the legacy source', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'legacy soul')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
    await mkdir(path.join(agentDataPath, 'memory'), { recursive: true })
    await writeFile(path.join(agentDataPath, 'SOUL.md'), 'existing soul')
    await writeFile(path.join(agentDataPath, 'V2-ONLY.md'), 'stale agent data')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('legacy soul')
    await expect(access(path.join(agentDataPath, 'V2-ONLY.md'))).rejects.toThrow()
    expect(await readFile(path.join(legacyWorkspace, 'SOUL.md'), 'utf8')).toBe('legacy soul')
  })

  it('clears existing memory before copying retry data', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceMemoryPath = path.join(legacyWorkspace, 'memory')
    await mkdir(sourceMemoryPath, { recursive: true })
    await writeFile(path.join(sourceMemoryPath, 'JOURNAL.jsonl'), '{"legacy":true}\n')
    await writeFile(path.join(sourceMemoryPath, 'FACT.md'), 'new legacy fact')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z'),
      managed: false
    })
    const destinationMemoryPath = path.join(agentsDataRoot, FINAL_AGENT_ID, 'memory')
    await mkdir(destinationMemoryPath, { recursive: true })
    await writeFile(path.join(destinationMemoryPath, 'JOURNAL.jsonl'), '{"stale":true}\n')
    await writeFile(path.join(destinationMemoryPath, 'V2-ONLY.md'), 'existing v2 memory')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(destinationMemoryPath, 'FACT.md'), 'utf8')).toBe('new legacy fact')
    expect(await readFile(path.join(destinationMemoryPath, 'JOURNAL.jsonl'), 'utf8')).toBe('{"legacy":true}\n')
    await expect(access(path.join(destinationMemoryPath, 'V2-ONLY.md'))).rejects.toThrow()
    expect(await readFile(path.join(sourceMemoryPath, 'FACT.md'), 'utf8')).toBe('new legacy fact')
  })

  it('replaces identity when the v1 source changes before a retry', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(path.join(legacyWorkspace, 'memory'), { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'first soul')
    await writeFile(path.join(legacyWorkspace, 'memory', 'FACT.md'), 'first fact')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const input = {
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [latestSession]
    }

    await stageLegacyAgentFiles(input)
    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 0 })

    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'newer soul')
    await writeFile(path.join(legacyWorkspace, 'memory', 'FACT.md'), 'newer fact')
    await expect(stageLegacyAgentFiles(input)).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(legacyWorkspace, 'SOUL.md'), 'utf8')).toBe('newer soul')
    expect(await readFile(path.join(legacyWorkspace, 'memory', 'FACT.md'), 'utf8')).toBe('newer fact')
    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('newer soul')
    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'memory', 'FACT.md'), 'utf8')).toBe('newer fact')
  })

  it('does not overwrite an identity target created after cleanup', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceSoulPath = path.join(legacyWorkspace, 'SOUL.md')
    const destinationSoulPath = path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourceSoulPath, 'legacy soul')
    copyMutation.afterCopyFile = async (sourcePath) => {
      if (sourcePath !== sourceSoulPath) return
      await writeFile(destinationSoulPath, 'concurrent soul')
    }

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).rejects.toThrow(/identity destination conflict/i)

    expect(await readFile(destinationSoulPath, 'utf8')).toBe('concurrent soul')
    expect(await readFile(sourceSoulPath, 'utf8')).toBe('legacy soul')
  })

  it('publishes an identity file when Windows reports EISDIR for hard links', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceSoulPath = path.join(legacyWorkspace, 'SOUL.md')
    const destinationSoulPath = path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourceSoulPath, 'legacy soul')
    copyMutation.linkFailure = Object.assign(new Error('illegal operation on a directory'), {
      code: 'EISDIR',
      syscall: 'link'
    })

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(copyMutation.linkCalls).toHaveLength(1)
    expect(copyMutation.copyFileCalls.some(([, destinationPath]) => destinationPath === destinationSoulPath)).toBe(true)
    expect(await readFile(destinationSoulPath, 'utf8')).toBe('legacy soul')
    expect(await readFile(sourceSoulPath, 'utf8')).toBe('legacy soul')
  })

  it('replaces an existing ordinary workspace target without changing the source', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'conflict.txt'), 'legacy workspace value')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    await mkdir(latestSession.systemWorkspacePath!, { recursive: true })
    await writeFile(path.join(latestSession.systemWorkspacePath!, 'conflict.txt'), 'existing workspace value')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'conflict.txt'), 'utf8')).toBe(
      'legacy workspace value'
    )
    expect(await readFile(path.join(legacyWorkspace, 'conflict.txt'), 'utf8')).toBe('legacy workspace value')
    expect(
      (await readdir(path.dirname(latestSession.systemWorkspacePath!))).every(
        (entry) => !entry.startsWith(`.${FINAL_LATEST_SESSION_ID}.migration-`)
      )
    ).toBe(true)
  })

  it('does not overwrite a workspace target created after cleanup', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourcePath = path.join(legacyWorkspace, 'conflict.txt')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourcePath, 'legacy workspace value')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const destinationPath = path.join(latestSession.systemWorkspacePath!, 'conflict.txt')
    copyMutation.afterCopyFile = async (copiedSourcePath) => {
      if (copiedSourcePath !== sourcePath) return
      await writeFile(destinationPath, 'concurrent workspace value')
    }

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).rejects.toThrow(/workspace migration conflict/i)

    expect(await readFile(destinationPath, 'utf8')).toBe('concurrent workspace value')
    expect(await readFile(sourcePath, 'utf8')).toBe('legacy workspace value')
  })

  it('replaces a partial directory destination and removes destination-only data', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourceBundle = path.join(legacyWorkspace, 'bundle')
    await mkdir(sourceBundle, { recursive: true })
    await writeFile(path.join(sourceBundle, 'first.txt'), 'first')
    await writeFile(path.join(sourceBundle, 'second.txt'), 'second')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const destinationBundle = path.join(latestSession.systemWorkspacePath!, 'bundle')
    await mkdir(destinationBundle, { recursive: true })
    await writeFile(path.join(destinationBundle, 'first.txt'), 'first')
    await writeFile(path.join(destinationBundle, 'V2-ONLY.txt'), 'stale')

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(path.join(destinationBundle, 'first.txt'), 'utf8')).toBe('first')
    expect(await readFile(path.join(sourceBundle, 'second.txt'), 'utf8')).toBe('second')
    expect(await readFile(path.join(destinationBundle, 'second.txt'), 'utf8')).toBe('second')
    await expect(access(path.join(destinationBundle, 'V2-ONLY.txt'))).rejects.toThrow()
    expect(
      (await readdir(path.dirname(latestSession.systemWorkspacePath!))).every(
        (entry) => !entry.startsWith(`.${FINAL_LATEST_SESSION_ID}.migration-`)
      )
    ).toBe(true)
  })

  it('does not delete unrelated staging-shaped entries from the managed destination root', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'workspace content')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    const stagingParent = path.dirname(latestSession.systemWorkspacePath!)
    const unrelatedPath = path.join(stagingParent, `.${FINAL_LATEST_SESSION_ID}.migration-user-data`)
    await mkdir(unrelatedPath, { recursive: true })
    await writeFile(path.join(unrelatedPath, 'keep.txt'), 'keep me')

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [latestSession]
    })

    expect(await readFile(path.join(unrelatedPath, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it('rebuilds an identical completed destination while keeping the v1 source', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'completed.txt'), 'copied value')

    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })
    await mkdir(latestSession.systemWorkspacePath!, { recursive: true })
    await writeFile(path.join(latestSession.systemWorkspacePath!, 'completed.txt'), 'copied value')

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [latestSession]
    })

    expect(
      copyMutation.copyFileCalls.filter(([sourcePath]) => sourcePath === path.join(legacyWorkspace, 'completed.txt'))
    ).toHaveLength(1)
    expect(await readFile(path.join(legacyWorkspace, 'completed.txt'), 'utf8')).toBe('copied value')
    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'completed.txt'), 'utf8')).toBe('copied value')
  })

  it('allows workspace source metadata to change during the copy window', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    const sourcePath = path.join(legacyWorkspace, 'race.txt')
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(sourcePath, 'copied value')
    const originalStat = await stat(sourcePath)
    copyMutation.afterCopyFile = async (copiedSourcePath) => {
      if (copiedSourcePath !== sourcePath) return
      await utimes(sourcePath, originalStat.atime, new Date(originalStat.mtimeMs + 60_000))
    }
    const latestSession = sessionPlan(agentsDataRoot, legacyWorkspace, {
      sourceSessionId: 'session_latest',
      finalSessionId: FINAL_LATEST_SESSION_ID,
      createdAt: Date.parse('2026-07-22T00:00:00Z'),
      updatedAt: Date.parse('2026-07-23T00:00:00Z')
    })

    await expect(
      stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [latestSession]
      })
    ).resolves.toEqual({ skippedTargetCount: 0 })

    expect(await readFile(sourcePath, 'utf8')).toBe('copied value')
    expect(await readFile(path.join(latestSession.systemWorkspacePath!, 'race.txt'), 'utf8')).toBe('copied value')
  })

  it.runIf(process.platform !== 'win32')(
    'skips a symlinked v1 workspace root without following or deleting it',
    async () => {
      const { tempRoot, agentsDataRoot, legacyWorkspace } = await createFixture()
      const externalWorkspace = path.join(tempRoot, 'external-workspace')
      await mkdir(externalWorkspace)
      await writeFile(path.join(externalWorkspace, 'SOUL.md'), 'external soul')
      await writeFile(path.join(externalWorkspace, 'ordinary.txt'), 'external ordinary')
      await symlink(externalWorkspace, legacyWorkspace)

      expect(await isManagedLegacyAgentWorkspace(agentsDataRoot, SOURCE_AGENT_ID, legacyWorkspace)).toBe(false)

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [
          sessionPlan(agentsDataRoot, legacyWorkspace, {
            sourceSessionId: 'session_external',
            finalSessionId: FINAL_LATEST_SESSION_ID,
            createdAt: Date.parse('2026-07-22T00:00:00Z'),
            updatedAt: Date.parse('2026-07-23T00:00:00Z'),
            managed: false
          })
        ]
      })

      expect((await lstat(legacyWorkspace)).isSymbolicLink()).toBe(true)
      expect(await readFile(path.join(externalWorkspace, 'SOUL.md'), 'utf8')).toBe('external soul')
      expect(await readFile(path.join(externalWorkspace, 'ordinary.txt'), 'utf8')).toBe('external ordinary')
      expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'does not follow external, dangling, or cyclic identity links from a user workspace',
    async () => {
      const { tempRoot, agentsDataRoot } = await createFixture()
      const userWorkspace = path.join(tempRoot, 'user-workspace')
      const externalFile = path.join(tempRoot, 'external-soul.md')
      await mkdir(userWorkspace)
      await writeFile(externalFile, 'must not copy')
      await symlink(externalFile, path.join(userWorkspace, 'SOUL.md'))
      await symlink('missing-user.md', path.join(userWorkspace, 'USER.md'))
      await symlink('cycle-b', path.join(userWorkspace, 'cycle-a'))
      await symlink('cycle-a', path.join(userWorkspace, 'cycle-b'))
      await symlink('cycle-a', path.join(userWorkspace, 'memory'))

      await stageLegacyAgentFiles({
        agentsDataRoot,
        agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
        sessions: [
          {
            ...sessionPlan(agentsDataRoot, userWorkspace, {
              sourceSessionId: 'session_user',
              finalSessionId: FINAL_LATEST_SESSION_ID,
              createdAt: Date.parse('2026-07-22T00:00:00Z'),
              updatedAt: Date.parse('2026-07-23T00:00:00Z'),
              managed: false
            }),
            sourceWorkspacePath: userWorkspace
          }
        ]
      })

      const agentDataPath = path.join(agentsDataRoot, FINAL_AGENT_ID)
      expect(await readFile(path.join(agentDataPath, 'SOUL.md'), 'utf8')).toBe('')
      expect(await readFile(path.join(agentDataPath, 'USER.md'), 'utf8')).toBe('')
      expect((await lstat(path.join(agentDataPath, 'memory'))).isDirectory()).toBe(true)
      expect((await lstat(path.join(userWorkspace, 'SOUL.md'))).isSymbolicLink()).toBe(true)
      expect((await lstat(path.join(userWorkspace, 'USER.md'))).isSymbolicLink()).toBe(true)
      expect((await lstat(path.join(userWorkspace, 'memory'))).isSymbolicLink()).toBe(true)
    }
  )

  it('copies identity without moving any content from an external user workspace', async () => {
    const { tempRoot, agentsDataRoot } = await createFixture()
    const userWorkspace = path.join(tempRoot, 'user-workspace')
    await mkdir(userWorkspace)
    await writeFile(path.join(userWorkspace, 'SOUL.md'), 'external user identity')
    await writeFile(path.join(userWorkspace, 'ordinary.txt'), 'external project content')

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: [
        {
          ...sessionPlan(agentsDataRoot, userWorkspace, {
            sourceSessionId: 'session_user',
            finalSessionId: FINAL_LATEST_SESSION_ID,
            createdAt: Date.parse('2026-07-22T00:00:00Z'),
            updatedAt: Date.parse('2026-07-23T00:00:00Z'),
            managed: false
          }),
          sourceWorkspacePath: userWorkspace
        }
      ]
    })

    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('external user identity')
    expect(await readFile(path.join(userWorkspace, 'SOUL.md'), 'utf8')).toBe('external user identity')
    expect(await readFile(path.join(userWorkspace, 'ordinary.txt'), 'utf8')).toBe('external project content')
  })

  it('keeps ordinary v1 content in place when the agent has no sessions', async () => {
    const { agentsDataRoot, legacyWorkspace } = await createFixture()
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(path.join(legacyWorkspace, 'SOUL.md'), 'agent soul')
    await writeFile(path.join(legacyWorkspace, 'ordinary.txt'), 'keep me')

    await stageLegacyAgentFiles({
      agentsDataRoot,
      agents: [{ sourceAgentId: SOURCE_AGENT_ID, finalAgentId: FINAL_AGENT_ID }],
      sessions: []
    })

    expect(await readFile(path.join(agentsDataRoot, FINAL_AGENT_ID, 'SOUL.md'), 'utf8')).toBe('agent soul')
    expect(await readFile(path.join(legacyWorkspace, 'ordinary.txt'), 'utf8')).toBe('keep me')
    await expect(access(path.join(agentsDataRoot, 'system'))).rejects.toThrow()
  })
})
