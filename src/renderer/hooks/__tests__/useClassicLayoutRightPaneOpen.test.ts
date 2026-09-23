import { MockUseCacheUtils } from '@test-mocks/renderer/useCache'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/data/hooks/useCache', async () => {
  const { MockUseCache } = await import('@test-mocks/renderer/useCache')
  return MockUseCache
})

import { useClassicLayoutRightPaneOpen } from '../useClassicLayoutRightPaneOpen'

const CACHE_KEY = 'ui.agent.right_pane_open_override'

describe('useClassicLayoutRightPaneOpen', () => {
  beforeEach(() => {
    MockUseCacheUtils.resetMocks()
  })

  it('uses the page default while no explicit override is stored', () => {
    MockUseCacheUtils.setPersistCacheValue(CACHE_KEY, null)

    const right = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))
    const left = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }))

    expect(right.result.current[0]).toBe(true)
    expect(left.result.current[0]).toBe(false)
  })

  it('keeps an explicit close across remounts', () => {
    const first = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))

    const setFirstOpen = first.result.current[1]
    act(() => setFirstOpen(false))
    expect(MockUseCacheUtils.getPersistCacheValue(CACHE_KEY)).toBe(false)
    first.unmount()

    const second = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))
    expect(second.result.current[0]).toBe(false)
  })

  it('stays closed and ignores normal writes outside the classic layout', () => {
    MockUseCacheUtils.setPersistCacheValue(CACHE_KEY, true)
    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: false, defaultOpen: true }))

    expect(result.current[0]).toBe(false)
    const setOpen = result.current[1]
    act(() => setOpen(false))
    expect(MockUseCacheUtils.getPersistCacheValue(CACHE_KEY)).toBe(true)
  })

  it('allows a forced write while the layout preference is changing', () => {
    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: false, defaultOpen: false }))

    const setOpen = result.current[1]
    act(() => setOpen(true, { force: true }))

    expect(MockUseCacheUtils.getPersistCacheValue(CACHE_KEY)).toBe(true)
  })
})
