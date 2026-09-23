import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import babeldocIcon from '@renderer/assets/images/dependencies/babeldoc.png'
import { PRESETS_BINARY_TOOLS } from '@shared/data/presets/binaryTools'
import type { BinaryToolSnapshot } from '@shared/types/binary'

import EnvironmentDependencies from '../EnvironmentDependencies'

const ipcMocks = vi.hoisted(() => ({ snapshots: vi.fn(), openPath: vi.fn() }))
const navigateMock = vi.hoisted(() => vi.fn())
const translationMock = vi.hoisted(() => ({ t: (key: string) => key }))

const systemSnapshot = (name: string, path = `/usr/local/bin/${name}`): BinaryToolSnapshot => ({
  name,
  availability: { source: 'system', path }
})

const missingSnapshot = (name: string): BinaryToolSnapshot => ({
  name,
  availability: { source: 'none' }
})

/** A snapshot record covering every preset, with per-tool overrides. */
const snapshotsForPresets = (overrides: Record<string, BinaryToolSnapshot> = {}) =>
  Object.fromEntries(PRESETS_BINARY_TOOLS.map((tool) => [tool.name, overrides[tool.name] ?? systemSnapshot(tool.name)]))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input?: unknown) => {
      switch (route) {
        case 'binary.get_tool_snapshots':
          return ipcMocks.snapshots(input)
        case 'system.shell.open_path':
          return ipcMocks.openPath(input)
        default:
          throw new Error(`unexpected route: ${route}`)
      }
    }
  }
}))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => translationMock
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }))
vi.mock('@cherrystudio/ui', () => ({
  Badge: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('span', props, children),
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    disabled,
    title
  }: {
    children?: React.ReactNode
    onClick?: () => void
    'aria-label'?: string
    disabled?: boolean
    title?: string
  }) => React.createElement('button', { onClick, 'aria-label': ariaLabel, disabled, title }, children)
}))

describe('EnvironmentDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ipcMocks.snapshots.mockImplementation(async () => snapshotsForPresets())
    ipcMocks.openPath.mockResolvedValue(undefined)
  })

  it('renders one read-only card per preset from the resolved snapshots', async () => {
    render(<EnvironmentDependencies />)

    expect(await screen.findByText('BabelDOC Stream')).toBeInTheDocument()
    for (const tool of PRESETS_BINARY_TOOLS) {
      expect(screen.getByText(tool.displayName)).toBeInTheDocument()
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(PRESETS_BINARY_TOOLS.length)
    expect(screen.getByText('settings.dependencies.description')).toBeInTheDocument()
    // One fetch on mount — no latest-version read, no re-fetch.
    expect(ipcMocks.snapshots).toHaveBeenCalledTimes(1)
    expect(ipcMocks.snapshots).toHaveBeenCalledWith(PRESETS_BINARY_TOOLS.map((tool) => tool.name))
  })

  it('renders the BabelDOC preset with its bundled image icon (not the fallback glyph)', async () => {
    render(<EnvironmentDependencies />)

    const card = (await screen.findByText('BabelDOC Stream')).closest<HTMLElement>('[role="listitem"]')
    expect(card).not.toBeNull()
    const icon = card!.querySelector('img')
    expect(icon?.getAttribute('src')).toBe(babeldocIcon)
  })

  it('marks a PATH-resolved tool as system with its resolved path in the badge tooltip', async () => {
    ipcMocks.snapshots.mockImplementation(async () =>
      snapshotsForPresets({ uv: systemSnapshot('uv', '/opt/tools/uv') })
    )
    render(<EnvironmentDependencies />)

    const badge = await screen.findByTitle('/opt/tools/uv')
    expect(badge).toHaveTextContent('settings.dependencies.source.system')
  })

  it('marks a missing tool as not found, without a path or an open-directory affordance', async () => {
    ipcMocks.snapshots.mockImplementation(async () => snapshotsForPresets({ rg: missingSnapshot('rg') }))
    render(<EnvironmentDependencies />)

    const card = (await screen.findByText('ripgrep')).closest<HTMLElement>('[role="listitem"]')!
    expect(within(card).getByText('settings.dependencies.source.none')).toBeInTheDocument()
    expect(within(card).queryByTitle('settings.dependencies.openBinariesDir')).toBeNull()
    // The found tools keep their system badge with the resolved path.
    const foundCard = screen.getByText('fd').closest<HTMLElement>('[role="listitem"]')!
    expect(within(foundCard).getByTitle('/usr/local/bin/fd')).toBeInTheDocument()
  })

  it('opens the containing directory of a resolved tool', async () => {
    render(<EnvironmentDependencies />)

    const card = (await screen.findByText('uv')).closest<HTMLElement>('[role="listitem"]')!
    fireEvent.click(within(card).getByTitle('settings.dependencies.openBinariesDir'))

    expect(ipcMocks.openPath).toHaveBeenCalledWith('/usr/local/bin')
  })

  it('offers no install or management controls', async () => {
    ipcMocks.snapshots.mockImplementation(async () => snapshotsForPresets({ fd: missingSnapshot('fd') }))
    render(<EnvironmentDependencies />)

    expect(await screen.findByText('fd')).toBeInTheDocument()
    for (const label of [
      'settings.dependencies.addTool',
      'settings.dependencies.installSettings.title',
      'settings.dependencies.checkUpdates',
      'settings.dependencies.uninstall',
      'settings.dependencies.update',
      'settings.dependencies.installing',
      'settings.dependencies.remove',
      'settings.mcp.install',
      'common.retry'
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
    // The management routes are gone from the wire too — the ipc mock throws on any
    // unexpected route, and only the snapshot read ever happened.
    expect(ipcMocks.snapshots).toHaveBeenCalledTimes(1)
  })

  it('renders nothing in mini mode until snapshots resolve', () => {
    ipcMocks.snapshots.mockImplementation(() => new Promise<Record<string, BinaryToolSnapshot>>(() => {}))
    const { container } = render(<EnvironmentDependencies mini />)

    expect(ipcMocks.snapshots).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing in mini mode when both uv and bun are on the PATH', async () => {
    let resolved = false
    ipcMocks.snapshots.mockImplementation(async () => {
      resolved = true
      return snapshotsForPresets()
    })
    const { container } = render(<EnvironmentDependencies mini />)

    await waitFor(() => expect(resolved).toBe(true))
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a warning button navigating to the dependencies page when a runtime is missing', async () => {
    ipcMocks.snapshots.mockImplementation(async () => snapshotsForPresets({ bun: missingSnapshot('bun') }))
    render(<EnvironmentDependencies mini />)

    const warning = await screen.findByRole('button', { name: 'settings.dependencies.title' })
    fireEvent.click(warning)

    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings/dependencies' })
  })

  it('renders the mini warning when uv is missing even if bun is present', async () => {
    ipcMocks.snapshots.mockImplementation(async () => snapshotsForPresets({ uv: missingSnapshot('uv') }))
    render(<EnvironmentDependencies mini />)

    expect(await screen.findByRole('button', { name: 'settings.dependencies.title' })).toBeInTheDocument()
  })
})
