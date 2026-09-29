// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { cacheState, mocks } = vi.hoisted(() => ({
  cacheState: { sidebarWidth: 50 },
  mocks: {
    openSettingsTab: vi.fn(),
    showDoctorPopup: vi.fn(),
    showSearchPopup: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn()
    })
  }
}))

vi.mock('@cherrystudio/ui', () => ({
  Button: ({
    children,
    type = 'button',
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => {
    const { variant, size, ...buttonProps } = props
    void variant
    void size

    return (
      <button data-slot="button" type={type} {...buttonProps}>
        {children}
      </button>
    )
  },
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Kbd: ({ children }: { children?: React.ReactNode }) => children
}))

vi.mock('@data/hooks/useCache', () => ({
  usePersistCache: () => [cacheState.sidebarWidth, vi.fn()]
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: mocks.openSettingsTab
}))

vi.mock('@renderer/components/GlobalSearch/GlobalSearchPopup', () => ({
  default: {
    show: mocks.showSearchPopup
  }
}))

vi.mock('@renderer/components/doctor', () => ({
  DoctorPopup: {
    show: mocks.showDoctorPopup
  }
}))

vi.mock('@renderer/components/command', () => ({
  CommandTooltip: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'globalSearch.open': 'Open global search',
        'settings.doctor.entry.title': 'System diagnostics',
        'settings.title': 'Settings'
      })[key] ?? key
  })
}))

vi.mock('../../WindowControls', () => ({
  WindowControls: () => null
}))

vi.mock('../HelpMenu', () => ({
  HelpMenu: ({
    layout,
    onFeedbackClick,
    onOverlayOpenChange
  }: {
    layout: string
    onFeedbackClick: () => void
    onOverlayOpenChange?: (open: boolean) => void
  }) => (
    <>
      <button aria-label="Help & Feedback" type="button" onClick={() => onOverlayOpenChange?.(true)}>
        help-{layout}
      </button>
      <button aria-label="Open feedback" type="button" onClick={onFeedbackClick} />
    </>
  )
}))

import { ShellTabBarActions, SidebarShellActions } from '../ShellTabBarActions'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  cacheState.sidebarWidth = 50
})

describe('ShellTabBarActions', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'toast', {
      configurable: true,
      value: { error: vi.fn() }
    })
  })

  it('opens global search from the action area', async () => {
    const user = userEvent.setup()

    render(<ShellTabBarActions />)

    await user.click(screen.getByRole('button', { name: 'Open global search' }))

    expect(screen.getByRole('button', { name: 'Open global search' })).toHaveAttribute('data-slot', 'button')
    expect(screen.getByRole('button', { name: 'Open global search' })).toHaveClass(
      'text-muted-foreground',
      'dark:text-muted-foreground'
    )
    expect(mocks.showSearchPopup).toHaveBeenCalledTimes(1)
  })

  it('uses its natural width in the header flex layout with one right padding', () => {
    const { container } = render(<ShellTabBarActions />)
    const actionArea = container.firstElementChild

    expect(actionArea).toHaveClass('shrink-0')
    expect(actionArea).not.toHaveClass('absolute')
    expect(actionArea?.firstElementChild).toHaveClass('pr-2')
  })

  it('keeps theme and settings actions out of the tab bar while the sidebar is visible', () => {
    render(<ShellTabBarActions />)

    expect(screen.queryByRole('button', { name: 'Light' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeInTheDocument()
  })

  it('opens settings from the tab bar when the sidebar is hidden', async () => {
    const user = userEvent.setup()
    cacheState.sidebarWidth = 0

    render(<ShellTabBarActions />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(mocks.openSettingsTab).toHaveBeenCalledWith()
  })

  it('opens system diagnostics from the keyboard when the sidebar is hidden', async () => {
    const user = userEvent.setup()
    cacheState.sidebarWidth = 0

    render(<ShellTabBarActions />)

    await user.tab()
    expect(screen.getByRole('button', { name: 'System diagnostics' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(mocks.showDoctorPopup).toHaveBeenCalledWith({ initialPanel: 'checks' })
  })

  it('does not render the theme toggle in the sidebar footer action', () => {
    render(<SidebarShellActions layout="icon" onFeedbackClick={vi.fn()} onSettingsClick={mocks.openSettingsTab} />)

    expect(screen.queryByRole('button', { name: 'Light' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /settings/i })).toHaveAttribute('data-slot', 'button')
    expect(screen.getByRole('button', { name: /settings/i })).toHaveClass(
      'text-muted-foreground',
      'dark:text-muted-foreground'
    )
    expect(screen.getByRole('button', { name: 'Help & Feedback' })).toHaveTextContent('help-icon')
  })

  it('opens the settings tab from the sidebar footer action', async () => {
    const user = userEvent.setup()

    render(<SidebarShellActions layout="icon" onFeedbackClick={vi.fn()} onSettingsClick={mocks.openSettingsTab} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(mocks.openSettingsTab).toHaveBeenCalledTimes(1)
  })

  it('forwards help overlay state from the sidebar footer', async () => {
    const user = userEvent.setup()
    const onOverlayOpenChange = vi.fn()

    render(
      <SidebarShellActions
        layout="icon"
        onFeedbackClick={vi.fn()}
        onSettingsClick={mocks.openSettingsTab}
        onOverlayOpenChange={onOverlayOpenChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Help & Feedback' }))

    expect(onOverlayOpenChange).toHaveBeenCalledWith(true)
  })

  it('forwards feedback requests from the sidebar footer', async () => {
    const user = userEvent.setup()
    const onFeedbackClick = vi.fn()

    render(
      <SidebarShellActions layout="icon" onFeedbackClick={onFeedbackClick} onSettingsClick={mocks.openSettingsTab} />
    )

    await user.click(screen.getByRole('button', { name: 'Open feedback' }))

    expect(onFeedbackClick).toHaveBeenCalledOnce()
  })

  it('renders sidebar full footer actions with visible labels', () => {
    render(<SidebarShellActions layout="full" onFeedbackClick={vi.fn()} onSettingsClick={mocks.openSettingsTab} />)

    expect(screen.queryByRole('button', { name: 'Light' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /settings/i })).toHaveAttribute('data-slot', 'button')
    expect(screen.getByRole('button', { name: /settings/i })).toHaveClass('justify-start', 'text-foreground')
    expect(screen.getByRole('button', { name: /settings/i })).not.toHaveClass('text-muted-foreground')
    expect(screen.getByRole('button', { name: /settings/i })).toHaveTextContent('Settings')
    expect(screen.getByRole('button', { name: 'Help & Feedback' })).toHaveTextContent('help-full')
  })
})
