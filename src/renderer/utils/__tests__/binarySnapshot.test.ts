import { describe, expect, it } from 'vitest'

import type { BinaryToolSnapshot } from '@shared/types/binary'

import { interpretBinarySnapshot } from '../binarySnapshot'

describe('interpretBinarySnapshot', () => {
  it('reads an absent snapshot as a not-installed tool', () => {
    const view = interpretBinarySnapshot(undefined)
    expect(view).toEqual({ source: 'none', installed: false })
    expect(view.systemPath).toBeUndefined()
    expect(view.resolvedPath).toBeUndefined()
  })

  it('reads an explicit none-availability snapshot as not installed', () => {
    const snapshot: BinaryToolSnapshot = { name: 'gh', availability: { source: 'none' } }
    expect(interpretBinarySnapshot(snapshot)).toEqual({ source: 'none', installed: false })
  })

  it('exposes systemPath and resolvedPath for a tool resolved on the PATH', () => {
    const snapshot: BinaryToolSnapshot = { name: 'gh', availability: { source: 'system', path: '/usr/bin/gh' } }
    expect(interpretBinarySnapshot(snapshot)).toEqual({
      source: 'system',
      installed: true,
      systemPath: '/usr/bin/gh',
      resolvedPath: '/usr/bin/gh'
    })
  })
})
