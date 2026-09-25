import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'

vi.unmock('@data/CacheService')
vi.unmock('@data/hooks/useCache')

import { useClassicLayoutRightPaneOpen } from '../useClassicLayoutRightPaneOpen'
import { WindowFrameContext } from '../useWindowFrame'
import { useWindowScopedPersistCache } from '../useWindowScopedPersistCache'

const detachedWindowWrapper = ({ children }: { children: ReactNode }) =>
  createElement(WindowFrameContext, { value: { mode: 'window' } }, children)

const useMismatchedWindowCachePair = () => {
  // @ts-expect-error boolean persistence cannot seed a number window cache
  return useWindowScopedPersistCache('ui.agent.right_pane_open_override', 'ui.window.chat.sidebar.width')
}
void useMismatchedWindowCachePair

const PERSIST_CACHE_KEY = 'ui.agent.right_pane_open_override'
const WINDOW_CACHE_KEY = 'ui.window.agent.right_pane_open_override'

describe('useClassicLayoutRightPaneOpen', () => {
  beforeEach(() => {
    cacheService.setPersist(PERSIST_CACHE_KEY, null)
  })

  afterEach(() => {
    cleanup()
    cacheService.cleanup()
  })

  it('uses the page default while no explicit override is stored', () => {
    cacheService.setPersist(PERSIST_CACHE_KEY, null)

    const right = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))
    const left = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }))

    expect(right.result.current[0]).toBe(true)
    expect(left.result.current[0]).toBe(false)
  })

  it('keeps an explicit close across remounts', () => {
    const first = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))

    const setFirstOpen = first.result.current[1]
    act(() => setFirstOpen(false))
    expect(cacheService.getPersist(PERSIST_CACHE_KEY)).toBe(false)
    first.unmount()

    const second = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }))
    expect(second.result.current[0]).toBe(false)
  })

  it('stays closed and ignores normal writes outside the classic layout', () => {
    cacheService.setPersist(PERSIST_CACHE_KEY, true)
    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: false, defaultOpen: true }))

    expect(result.current[0]).toBe(false)
    const setOpen = result.current[1]
    act(() => setOpen(false))
    expect(cacheService.getPersist(PERSIST_CACHE_KEY)).toBe(true)
  })

  it('allows a forced write while the layout preference is changing', () => {
    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: false, defaultOpen: false }))

    const setOpen = result.current[1]
    act(() => setOpen(true, { force: true }))

    expect(cacheService.getPersist(PERSIST_CACHE_KEY)).toBe(true)
  })

  it('keeps detached writes out of the persisted cache', () => {
    cacheService.setPersist(PERSIST_CACHE_KEY, false)
    cacheService.set(WINDOW_CACHE_KEY, false)
    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: true }), {
      wrapper: detachedWindowWrapper
    })

    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))

    expect(cacheService.get(WINDOW_CACHE_KEY)).toBe(true)
    expect(cacheService.getPersist(PERSIST_CACHE_KEY)).toBe(false)
  })

  it('keeps a detached pane independent of persisted changes once it holds its own value', () => {
    cacheService.setPersist(PERSIST_CACHE_KEY, true)
    cacheService.set(WINDOW_CACHE_KEY, true)

    const { result } = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }), {
      wrapper: detachedWindowWrapper
    })
    expect(result.current[0]).toBe(true)

    // A main-window toggle reaches a detached renderer only through the persisted broadcast;
    // once the detached pane holds its own value it must not follow that broadcast.
    act(() => cacheService.setPersist(PERSIST_CACHE_KEY, false))

    expect(result.current[0]).toBe(true)
    expect(cacheService.getPersist(PERSIST_CACHE_KEY)).toBe(false)
  })

  it('keeps an untouched detached pane at its default after a main-window toggle and remount', () => {
    const main = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }))
    const detached = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }), {
      wrapper: detachedWindowWrapper
    })
    expect(detached.result.current[0]).toBe(false)

    act(() => main.result.current[1](true))

    expect(main.result.current[0]).toBe(true)
    expect(detached.result.current[0]).toBe(false)
    detached.unmount()

    const reopened = renderHook(() => useClassicLayoutRightPaneOpen({ enabled: true, defaultOpen: false }), {
      wrapper: detachedWindowWrapper
    })
    expect(reopened.result.current[0]).toBe(false)
  })
})
