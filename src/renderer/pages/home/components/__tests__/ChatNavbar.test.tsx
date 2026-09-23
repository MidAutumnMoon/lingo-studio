import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryUi from '@cherrystudio/ui'

const preferenceMock = vi.hoisted(() => ({
  setShowSidebar: vi.fn(),
  showSidebar: false
}))

vi.mock('@cherrystudio/ui', async () => {
  const actual = await vi.importActual<typeof CherryUi>('@cherrystudio/ui')
  return {
    ...actual,
    Tooltip: ({ children }: { children: ReactNode }) => children
  }
})

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: () => [preferenceMock.showSidebar, preferenceMock.setShowSidebar]
}))

vi.mock('@renderer/components/Navbar', () => ({
  NavbarHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/icons/SidebarToggleIcons', () => ({
  SidebarCollapseIcon: () => <span data-testid="collapse-icon" />,
  SidebarExpandIcon: () => <span data-testid="expand-icon" />
}))

vi.mock('i18next', () => ({
  t: (key: string) => key
}))

import ChatNavbar from '../ChatNavbar'

describe('ChatNavbar', () => {
  beforeEach(() => {
    preferenceMock.showSidebar = false
    preferenceMock.setShowSidebar.mockClear()
  })

  it('reflects sidebar visibility through the toggle state', () => {
    const { rerender } = render(<ChatNavbar />)

    expect(screen.getByRole('button', { name: 'navbar.show_sidebar' })).toHaveAttribute('aria-pressed', 'false')

    preferenceMock.showSidebar = true
    rerender(<ChatNavbar />)

    expect(screen.getByRole('button', { name: 'navbar.hide_sidebar' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('toggles the sidebar through the page handler that owns its state', async () => {
    const user = userEvent.setup()
    const onSidebarToggle = vi.fn()
    render(<ChatNavbar onSidebarToggle={onSidebarToggle} />)

    await user.click(screen.getByRole('button', { name: 'navbar.show_sidebar' }))

    expect(onSidebarToggle).toHaveBeenCalledTimes(1)
    expect(preferenceMock.setShowSidebar).not.toHaveBeenCalled()
  })

  it('names the open conversation with its emoji', () => {
    render(<ChatNavbar topicTitle={{ label: 'Trip planning', emoji: '🧭' }} />)

    expect(screen.getByText('Trip planning')).toBeInTheDocument()
    // EmojiIcon paints the glyph twice (blurred backdrop plus foreground), so only presence matters.
    expect(screen.getAllByText('🧭').length).toBeGreaterThan(0)
  })

  it('leaves the composer controls and the new-topic action to the composer', () => {
    const { container } = render(<ChatNavbar topicTitle={{ label: 'Trip planning' }} />)

    // Hosting the controls here would duplicate the assistant + model control the composer renders.
    expect(container.querySelector('[data-conversation-topbar-controls]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'chat.conversation.new' })).not.toBeInTheDocument()
  })
})
