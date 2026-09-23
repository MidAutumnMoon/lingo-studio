import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BinaryToolSnapshot } from '@shared/types/binary'
import { CodeCli } from '@shared/types/codeCli'

import { useCliVersionStatuses } from '../useCliVersionStatuses'

const snapshotRecords = vi.hoisted(() => ({ value: {} as Record<string, BinaryToolSnapshot> }))
const ipcMocks = vi.hoisted(() => ({ snapshots: vi.fn() }))

const setSnapshots = (records: Record<string, BinaryToolSnapshot>) => {
  snapshotRecords.value = records
}

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input?: unknown) => {
      if (route !== 'binary.get_tool_snapshots') throw new Error(`unexpected route: ${route}`)
      return ipcMocks.snapshots(input)
    }
  }
}))

vi.mock('@renderer/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ error: vi.fn() }) }
}))

describe('useCliVersionStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSnapshots({})
    ipcMocks.snapshots.mockImplementation(async (names: string[]) =>
      Object.fromEntries(
        names.flatMap((name) => (snapshotRecords.value[name] ? [[name, snapshotRecords.value[name]]] : []))
      )
    )
  })

  it('marks a system PATH tool installed with its resolved path', async () => {
    setSnapshots({ claude: { name: 'claude', availability: { source: 'system', path: '/usr/local/bin/claude' } } })

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.CLAUDE_CODE]))

    await waitFor(() => expect(result.current.statuses[CodeCli.CLAUDE_CODE]?.installed).toBe(true))
    expect(result.current.statuses[CodeCli.CLAUDE_CODE]).toEqual({
      installed: true,
      source: 'system',
      systemPath: '/usr/local/bin/claude'
    })
    expect(ipcMocks.snapshots).toHaveBeenCalledWith(['claude'])
  })

  it('reads each tool through its preset executable name', async () => {
    setSnapshots({
      openclaw: { name: 'openclaw', availability: { source: 'system', path: '/usr/local/bin/openclaw' } }
    })

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.OPENCLAW]))

    await waitFor(() => expect(result.current.statuses[CodeCli.OPENCLAW]?.installed).toBe(true))
    expect(result.current.statuses[CodeCli.OPENCLAW]).toEqual({
      installed: true,
      source: 'system',
      systemPath: '/usr/local/bin/openclaw'
    })
  })

  it('reports an absent executable as not installed with no path', async () => {
    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.CLAUDE_CODE, CodeCli.OPENAI_CODEX]))

    await waitFor(() => expect(result.current.resolved).toBe(true))
    expect(result.current.statuses).toEqual({
      [CodeCli.CLAUDE_CODE]: { installed: false, source: 'none' },
      [CodeCli.OPENAI_CODEX]: { installed: false, source: 'none' }
    })
  })

  // Nothing else re-runs this read, so without a retry a first attempt that
  // races main-process readiness strands every tool for the session.
  it('retries a rejected snapshot read so a transient failure still yields statuses', async () => {
    vi.useFakeTimers()
    setSnapshots({ claude: { name: 'claude', availability: { source: 'system', path: '/usr/bin/claude' } } })
    const succeed = ipcMocks.snapshots.getMockImplementation()!
    ipcMocks.snapshots.mockRejectedValueOnce(new Error('main not ready')).mockImplementation(succeed)

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.CLAUDE_CODE]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.statuses).toEqual({})

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.statuses[CodeCli.CLAUDE_CODE]?.installed).toBe(true)

    vi.useRealTimers()
  })

  it('settles as resolved once the retries are exhausted, instead of retrying forever', async () => {
    vi.useFakeTimers()
    ipcMocks.snapshots.mockRejectedValue(new Error('ipc unavailable'))

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.CLAUDE_CODE]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 10)
    })

    expect(ipcMocks.snapshots).toHaveBeenCalledTimes(5)
    // Consumers gate their "tool is genuinely absent" fallback on this; never flipping it
    // leaves a selected-but-hidden tool with no way out.
    expect(result.current.resolved).toBe(true)

    vi.useRealTimers()
  })

  it('stays unresolved while the first read is still in flight', async () => {
    let release!: (value: Record<string, BinaryToolSnapshot>) => void
    ipcMocks.snapshots.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.CLAUDE_CODE]))
    await act(async () => {})
    // Resolving early would let a consumer treat an in-flight read as a confirmed absence.
    expect(result.current.resolved).toBe(false)

    await act(async () => {
      release({ claude: { name: 'claude', availability: { source: 'system', path: '/usr/bin/claude' } } })
    })
    await waitFor(() => expect(result.current.resolved).toBe(true))
  })
})
