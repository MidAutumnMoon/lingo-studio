import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { VersionStatusCard } from '../VersionStatusCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/components/icons/CliIcon', () => ({
  CliIcon: ({ id }: { id: string }) => <span data-testid={`cli-icon-${id}`} />
}))

describe('VersionStatusCard', () => {
  it('shows the not-installed hint instead of any action for a missing CLI', () => {
    render(
      <VersionStatusCard toolId="claude-code" toolName="Claude Code" status={{ source: 'none', installed: false }} />
    )

    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('code.not_installed')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows the resolved PATH and only a launch action for a system tool', () => {
    render(
      <VersionStatusCard
        toolId="claude-code"
        toolName="Claude Code"
        status={{
          installed: true,
          source: 'system',
          systemPath: '/usr/local/bin/claude'
        }}
        onLaunch={vi.fn()}
        canLaunch
      />
    )

    expect(screen.getByText('settings.dependencies.source.system')).toHaveAttribute('title', '/usr/local/bin/claude')
    expect(screen.getByText('/usr/local/bin/claude')).toBeInTheDocument()
    expect(screen.queryByText('code.not_installed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'code.launch.label' })).toBeEnabled()
  })

  it('keeps an unavailable launch action focusable and exposes the reason', async () => {
    const user = userEvent.setup()
    const onLaunch = vi.fn()
    render(
      <VersionStatusCard
        toolId="qwen-code"
        toolName="Qwen Code"
        status={{ source: 'none', installed: true }}
        onLaunch={onLaunch}
        canLaunch={false}
        launchDisabledHint="Choose a provider"
      />
    )

    const launchButton = screen.getByRole('button', { name: 'code.launch.label' })
    await user.tab()

    expect(launchButton).toHaveFocus()
    expect(launchButton).toBeEnabled()
    expect(launchButton).toHaveAttribute('aria-disabled', 'true')
    expect(launchButton).toHaveAccessibleDescription('Choose a provider')
    expect(launchButton.parentElement).toHaveAttribute('data-title', 'Choose a provider')

    await user.keyboard('{Enter}')
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('renders the launching state', () => {
    render(
      <VersionStatusCard
        toolId="qwen-code"
        toolName="Qwen Code"
        status={{ source: 'none', installed: true }}
        onLaunch={vi.fn()}
        canLaunch
        launching
      />
    )

    expect(screen.getByRole('button', { name: 'code.launching' })).toBeDisabled()
  })

  it('renders an open-dashboard action when running and triggers it on click', () => {
    const onOpenDashboard = vi.fn()
    render(
      <VersionStatusCard
        toolId="openclaw"
        toolName="OpenClaw"
        status={{ source: 'none', installed: true }}
        onStop={vi.fn()}
        running
        onOpenDashboard={onOpenDashboard}
      />
    )

    const button = screen.getByRole('button', { name: 'code.open_web_ui' })
    expect(screen.getByRole('button', { name: 'code.stop' })).toBeInTheDocument()
    button.click()
    expect(onOpenDashboard).toHaveBeenCalledTimes(1)
  })

  it('omits the open-dashboard action when not running', () => {
    render(
      <VersionStatusCard
        toolId="openclaw"
        toolName="OpenClaw"
        status={{ source: 'none', installed: true }}
        onLaunch={vi.fn()}
        canLaunch
        onOpenDashboard={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'code.open_web_ui' })).not.toBeInTheDocument()
  })
})
