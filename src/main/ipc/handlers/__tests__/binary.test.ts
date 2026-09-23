import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getToolSnapshots } = vi.hoisted(() => ({ getToolSnapshots: vi.fn() }))
vi.mock('@main/services/SystemToolService', () => ({ systemToolService: { getToolSnapshots } }))

import { binaryHandlers } from '../binary'

beforeEach(() => {
  vi.clearAllMocks()
})

const ctx = { senderId: 'w1' }

describe('binaryHandlers', () => {
  it('get_tool_snapshots forwards names and returns the observed snapshots', async () => {
    getToolSnapshots.mockResolvedValue({
      fd: { name: 'fd', availability: { source: 'system', path: '/usr/bin/fd' } },
      rg: { name: 'rg', availability: { source: 'none' } }
    })

    const result = await binaryHandlers['binary.get_tool_snapshots'](['fd', 'rg'], ctx)

    expect(getToolSnapshots).toHaveBeenCalledWith(['fd', 'rg'])
    expect(result).toEqual({
      fd: { name: 'fd', availability: { source: 'system', path: '/usr/bin/fd' } },
      rg: { name: 'rg', availability: { source: 'none' } }
    })
  })
})
