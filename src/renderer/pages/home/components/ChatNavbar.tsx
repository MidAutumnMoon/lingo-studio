import type { FC } from 'react'

import { EmojiIcon } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import { ConversationSidebarToggleButton } from '@renderer/components/chat/shell/ConversationSidebarToggleButton'
import { NavbarHeader } from '@renderer/components/Navbar'

interface HeaderNavbarProps {
  /** The open conversation, named where the assistant + model control used to sit. */
  topicTitle?: { label: string; emoji?: string }
  showSidebarControls?: boolean
  sidebarOpen?: boolean
  onSidebarToggle?: () => void
}

const HeaderNavbar: FC<HeaderNavbarProps> = ({
  topicTitle,
  showSidebarControls = true,
  sidebarOpen,
  onSidebarToggle
}) => {
  const [preferredShowSidebar] = usePreference('topic.tab.show')
  const showSidebar = sidebarOpen ?? preferredShowSidebar

  return (
    <NavbarHeader className="home-navbar relative" style={{ height: 'var(--navbar-height)' }}>
      <div className="-mx-1 flex h-full min-w-0 flex-1 items-center justify-between overflow-hidden">
        <div data-navbar-left-occupant className="flex min-w-0 flex-1 items-center overflow-hidden">
          {showSidebarControls && (
            <ConversationSidebarToggleButton
              sidebarOpen={showSidebar}
              onSidebarToggle={onSidebarToggle}
              tooltipPlacement="bottom"
            />
          )}
          {topicTitle && (
            <div data-conversation-topic-title className="ml-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
              {topicTitle.emoji && <EmojiIcon emoji={topicTitle.emoji} size={16} />}
              <span className="truncate font-medium text-sm">{topicTitle.label}</span>
            </div>
          )}
        </div>
      </div>
    </NavbarHeader>
  )
}

export default HeaderNavbar
