import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { useActiveComposerOverride } from '@renderer/components/composer/ComposerContext'
import { useOverflowIconOnly } from '@renderer/hooks/useOverflowIconOnly'
import { cn } from '@renderer/utils/style'

type ConversationTopBarPortalContextValue = {
  enabled: boolean
  iconOnly: boolean
  target: HTMLDivElement | null
  setTarget: (target: HTMLDivElement | null) => void
}

const ConversationTopBarPortalContext = createContext<ConversationTopBarPortalContextValue | undefined>(undefined)

/**
 * `enabled` says whether this surface hosts the composer's conversation controls in its top bar.
 * A surface that does not (the chat page shows the topic there instead) leaves them in the composer:
 * the same control either way, only its placement differs.
 */
export function ConversationTopBarPortalProvider({
  children,
  enabled = true
}: {
  children: ReactNode
  enabled?: boolean
}) {
  const { iconOnly, containerRef } = useOverflowIconOnly()
  const [target, setPortalTarget] = useState<HTMLDivElement | null>(null)
  const setTarget = useCallback(
    (nextTarget: HTMLDivElement | null) => {
      containerRef(nextTarget)
      setPortalTarget(nextTarget)
    },
    [containerRef]
  )
  const value = useMemo(() => ({ enabled, iconOnly, setTarget, target }), [enabled, iconOnly, setTarget, target])

  return <ConversationTopBarPortalContext value={value}>{children}</ConversationTopBarPortalContext>
}

export function ConversationTopBarPortalHost({ children, className }: { children?: ReactNode; className?: string }) {
  const context = use(ConversationTopBarPortalContext)

  if (!context?.enabled) return null

  return (
    <div
      ref={context.setTarget}
      data-conversation-topbar-controls
      className={cn(
        'ml-2 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden [-webkit-app-region:no-drag] [&_button]:h-7 [&_button]:px-1.5',
        className
      )}>
      {children}
    </div>
  )
}

export function ConversationTopBarPortal({ children }: { children: ReactNode }) {
  const context = use(ConversationTopBarPortalContext)
  const composerOverridden = useActiveComposerOverride() !== null

  if (!context?.enabled) return children
  if (!context.target || composerOverridden) return null

  return createPortal(children, context.target)
}

/** `available` means a top bar will show these controls; otherwise the composer keeps them. */
export function useConversationTopBarPortalLayout() {
  const context = use(ConversationTopBarPortalContext)
  return { available: context?.enabled ?? false, iconOnly: context?.iconOnly ?? false }
}
