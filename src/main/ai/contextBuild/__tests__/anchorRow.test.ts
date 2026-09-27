import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DataApiErrorFactory } from '@shared/data/api/errors'

import { hasAnchorRow } from '../anchorRow'

const { getByIdMock } = vi.hoisted(() => ({ getByIdMock: vi.fn() }))
vi.mock('@data/services/MessageService', () => ({ messageService: { getById: getByIdMock } }))

beforeEach(() => {
  getByIdMock.mockReset()
  getByIdMock.mockReturnValue({ id: 'anchor-1' })
})

// The lookup gates fs_read's admission and the offload adapter's eligibility, so
// its NOT_FOUND-vs-failure split is the contract.
describe('hasAnchorRow', () => {
  it('reports an anchored request when the id resolves to a message row', () => {
    getByIdMock.mockReturnValue({ id: 'anchor-1' })
    expect(hasAnchorRow('anchor-1')).toBe(true)
    expect(getByIdMock).toHaveBeenCalledWith('anchor-1')
  })

  it('treats a missing row as non-anchored (temp chat / one-shot streamPrompt)', () => {
    // Real MessageService.getById throws NOT_FOUND for missing rows — it never returns null.
    getByIdMock.mockImplementation(() => {
      throw DataApiErrorFactory.notFound('Message', 'anchor-1')
    })
    expect(hasAnchorRow('anchor-1')).toBe(false)
  })

  it('skips the lookup entirely when the request carries no message id', () => {
    expect(hasAnchorRow(undefined)).toBe(false)
    expect(getByIdMock).not.toHaveBeenCalled()
  })

  it('rethrows anything that is not a missing row', () => {
    getByIdMock.mockImplementation(() => {
      throw new Error('db is on fire')
    })
    expect(() => hasAnchorRow('anchor-1')).toThrow('db is on fire')
  })
})
