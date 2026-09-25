import { useCallback } from 'react'

import { useWindowScopedPersistCache } from './useWindowScopedPersistCache'

const AGENT_RIGHT_PANE_OPEN_OVERRIDE_CACHE_KEYS = {
  persist: 'ui.agent.right_pane_open_override',
  window: 'ui.window.agent.right_pane_open_override'
} as const

interface ClassicLayoutRightPaneOpenOptions {
  enabled: boolean
  defaultOpen: boolean
}

type ClassicLayoutPaneOpenSetter = (open: boolean, options?: { force?: boolean }) => void

/**
 * Classic-layout right-pane state for the Work page, cached independently of the panel's own
 * open state. A null override delegates to the page's position-derived default; an explicit
 * boolean preserves the user's choice across page re-entry. Outside classic layout the pane is
 * derived closed and normal writes are ignored.
 */
export function useClassicLayoutRightPaneOpen({
  enabled,
  defaultOpen
}: ClassicLayoutRightPaneOpenOptions): readonly [boolean, ClassicLayoutPaneOpenSetter] {
  const [storedOverride, setStoredOverride] = useWindowScopedPersistCache(
    AGENT_RIGHT_PANE_OPEN_OVERRIDE_CACHE_KEYS.persist,
    AGENT_RIGHT_PANE_OPEN_OVERRIDE_CACHE_KEYS.window
  )
  const paneOpen = enabled && (storedOverride ?? defaultOpen)
  const setPaneOpen = useCallback<ClassicLayoutPaneOpenSetter>(
    (open, options) => {
      if (enabled || options?.force) setStoredOverride(open)
    },
    [enabled, setStoredOverride]
  )

  return [paneOpen, setPaneOpen] as const
}
