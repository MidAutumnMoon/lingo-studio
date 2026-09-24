import { MockUseCacheUtils } from '@test-mocks/renderer/useCache'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedAction } from '@renderer/components/chat/actions/actionTypes'
import type { ResourceEntityRailItem } from '@renderer/components/chat/resourceList/ResourceEntityRail'
import type { AgentSessionsSource } from '@renderer/hooks/resourceViewSources'
import type * as RecycleBinFeedback from '@renderer/services/recycleBinFeedback'
import { toast } from '@renderer/services/toast'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import { createSidebarShortcutId, type SidebarShortcutTarget } from '@shared/data/preference/preferenceTypes'
import { aiErrorCodes } from '@shared/ipc/errors/ai'
import { IpcError } from '@shared/ipc/errors/IpcError'

import { AgentResourceList } from '../AgentResourceList'

const agentDataMocks = vi.hoisted(() => ({
  error: null as Error | null,
  getActiveResource: vi.fn(),
  isLoading: false,
  agents: [
    {
      id: 'agent-1',
      name: 'Agent 1',
      orderKey: 'a',
      configuration: {},
      model: 'anthropic::claude-sonnet-4',
      modelName: 'Claude Sonnet 4'
    }
  ],
  deleteAgent: vi.fn(),
  invalidate: vi.fn(),
  ipcRequest: vi.fn(),
  refetchAgents: vi.fn(),
  restoreAgent: vi.fn(),
  restoreSession: vi.fn(),
  toggleAgentPin: vi.fn()
}))

const recycleBinFeedbackMocks = vi.hoisted(() => ({
  showRecycleBinBatchUndo: vi.fn(),
  showRecycleBinUndo: vi.fn()
}))

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}))

const preferenceMocks = vi.hoisted(() => ({
  setPreference: vi.fn(),
  values: new Map<string, unknown>()
}))

const resourceEntityRailMocks = vi.hoisted(() => ({
  collapsedGroupId: 'resource-entity-rail:section:["group","group-work"]'
}))

const tabsContextMocks = vi.hoisted(() => ({
  closeConversationTabs: vi.fn()
}))

const conversationOwnerPopupMocks = vi.hoisted(() => ({ show: vi.fn() }))

vi.mock('@renderer/components/chat/DeleteConversationOwnerConfirmDialog', () => ({
  deleteConversationOwnerPopup: conversationOwnerPopupMocks
}))

vi.mock('@cherrystudio/ui', () => ({
  BlurCancelPointerSensor: class BlurCancelPointerSensor {},
  Button: ({ children, onClick, ...props }: { children?: ReactNode; onClick?: () => void }) => (
    <button {...props} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  EmojiIcon: ({ emoji }: { emoji: string }) => <span>{emoji}</span>,
  MenuItem: ({ icon, label, onClick }: { icon?: ReactNode; label: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuDivider: () => <hr />,
  MenuList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => {
    const defaultValue = key === 'agent.session.display_mode' ? 'agent' : undefined

    return [
      preferenceMocks.values.get(key) ?? defaultValue,
      (value: unknown) => {
        preferenceMocks.values.set(key, value)
        preferenceMocks.setPreference(key, value)
        // Sidebar shortcut mutations call `.catch` on the returned
        // promise; resolve so those toggle paths do not throw.
        return Promise.resolve()
      }
    ]
  }
}))

vi.mock('@renderer/data/PreferenceService', () => ({
  preferenceService: {
    get: vi.fn(async (key: string) => preferenceMocks.values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      preferenceMocks.values.set(key, value)
      preferenceMocks.setPreference(key, value)
    })
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerMocks
  }
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <span data-testid="model-avatar" />
}))

vi.mock('@renderer/components/resourceCatalog/dialogs/edit', () => ({
  ResourceEditDialogHost: () => null
}))

vi.mock('@renderer/components/chat/resourceList/ResourceEntityRail', () => ({
  ResourceEntityRail: ({
    collapsedState,
    getContextMenuActions,
    groupByGroup,
    headerActions,
    items,
    onCollapsedStateChange,
    onContextMenuAction,
    onGroupReorder,
    onReorder,
    onSelect,
    onSelectedClick,
    reorderEnabled = true,
    selectedId,
    selectedClickId,
    selectionSuppressed
  }: {
    collapsedState?: readonly string[]
    getContextMenuActions?: (item: ResourceEntityRailItem) => readonly ResolvedAction[]
    groupByGroup?: boolean
    headerActions?: ReactNode
    items: readonly ResourceEntityRailItem[]
    onCollapsedStateChange?: (collapsedIds: string[]) => void
    onContextMenuAction?: (item: ResourceEntityRailItem, action: ResolvedAction) => void | Promise<void>
    onGroupReorder?: (groupId: string, anchor: { before: string }) => void | Promise<void>
    onReorder?: unknown
    onSelect: (item: ResourceEntityRailItem) => void | Promise<void>
    onSelectedClick?: (item: ResourceEntityRailItem) => void | Promise<void>
    reorderEnabled?: boolean
    selectedId?: string | null
    selectedClickId?: string | null
    selectionSuppressed?: boolean
  }) => {
    const flattenActions = (actions: readonly ResolvedAction[]): readonly ResolvedAction[] =>
      actions.flatMap((action) => [action, ...flattenActions(action.children)])

    return (
      <div
        data-testid="resource-entity-rail"
        data-group-by-group={String(!!groupByGroup)}
        data-reorder={(onReorder || onGroupReorder) && reorderEnabled ? 'enabled' : 'disabled'}
        data-item-reorder={onReorder && reorderEnabled ? 'enabled' : 'disabled'}
        data-group-reorder={onGroupReorder && reorderEnabled ? 'enabled' : 'disabled'}
        data-sortable-container={onReorder || onGroupReorder ? 'enabled' : 'disabled'}
        data-collapsed-state={collapsedState?.join(',') ?? 'uncontrolled'}
        data-selected-id={selectionSuppressed ? '' : (selectedId ?? '')}
        data-selected-click-id={selectedClickId ?? ''}
        data-selection-suppressed={String(!!selectionSuppressed)}>
        <button
          type="button"
          aria-label="Collapse work group"
          onClick={() => onCollapsedStateChange?.([resourceEntityRailMocks.collapsedGroupId])}
        />
        {headerActions}
        {items.map((item) => {
          const actions = getContextMenuActions?.(item) ?? []
          const renderedActions = flattenActions(actions)

          return (
            <section key={item.id} aria-label={item.name} title={item.tooltip}>
              <button
                type="button"
                aria-label={`Select ${item.name}`}
                onClick={() =>
                  selectedClickId === item.id && onSelectedClick ? onSelectedClick(item) : onSelect(item)
                }
              />
              {item.icon}
              <div data-testid={`${item.id}-context-menu`}>
                {renderedActions.map((action) => (
                  <button
                    key={`context-${action.id}`}
                    type="button"
                    disabled={!action.availability.enabled}
                    onClick={() => onContextMenuAction?.(item, action)}>
                    {action.label}
                  </button>
                ))}
              </div>
              <div data-testid={`${item.id}-more-menu`}>
                {renderedActions.map((action) => (
                  <button
                    key={`more-${action.id}`}
                    type="button"
                    disabled={!action.availability.enabled}
                    onClick={() => onContextMenuAction?.(item, action)}>
                    {action.label}
                  </button>
                ))}
              </div>
              {item.trailingAction}
            </section>
          )
        })}
      </div>
    )
  }
}))

vi.mock('@renderer/data/DataApiService', () => ({
  dataApiService: { get: agentDataMocks.getActiveResource }
}))

vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgents: () => ({
    agents: agentDataMocks.agents,
    deleteAgent: agentDataMocks.deleteAgent,
    error: agentDataMocks.error,
    isLoading: agentDataMocks.isLoading,
    refetch: agentDataMocks.refetchAgents
  })
}))

vi.mock('@renderer/hooks/usePins', () => ({
  usePins: () => ({
    isLoading: false,
    isMutating: false,
    isRefreshing: false,
    pinnedIds: [],
    togglePin: agentDataMocks.toggleAgentPin
  })
}))

vi.mock('@renderer/hooks/tab', () => ({
  useCloseConversationTabs: () => tabsContextMocks.closeConversationTabs
}))

vi.mock('@renderer/hooks/useGroups', () => ({
  useGroups: () => ({ groups: [], isLoading: false, error: undefined }),
  useGroupReorder: () => ({ reorderGroup: vi.fn() })
}))

function createAgentSessionsSource(overrides: Partial<AgentSessionsSource> = {}): AgentSessionsSource {
  return {
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
    error: null,
    hasMore: false,
    isFullyLoaded: true,
    isLoading: false,
    isLoadingAll: false,
    isLoadingMore: false,
    isPinsLoading: false,
    isValidating: false,
    loadLatestSession: vi.fn().mockResolvedValue(null),
    reuseOrCreateSession: vi.fn(),
    loadMore: vi.fn(),
    pinIdBySessionId: new Map(),
    reload: vi.fn(),
    reorderSession: vi.fn(),
    reorderSessions: vi.fn(),
    sessions: [{ id: 'session-1', agentId: 'agent-1', name: 'Session 1' }],
    togglePin: vi.fn(),
    total: 1,
    ...overrides
  } as unknown as AgentSessionsSource
}

function createAgentSession(overrides: Partial<AgentSessionEntity> = {}): AgentSessionEntity {
  const timestamp = '2026-09-04T00:00:00.000Z'

  return {
    id: 'session-1',
    agentId: 'agent-1',
    name: 'Session 1',
    isNameManuallyEdited: false,
    workspaceId: 'workspace-1',
    workspace: {
      id: 'workspace-1',
      name: 'Workspace 1',
      path: '/tmp/workspace-1',
      type: 'system',
      orderKey: 'a',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    orderKey: 'a',
    lastActivityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  }
}

vi.mock('@renderer/data/hooks/useDataApi', () => ({
  useInvalidateCache: () => agentDataMocks.invalidate,
  useMutation: () => ({ trigger: vi.fn() })
}))

vi.mock('@renderer/services/recycleBinFeedback', async (importOriginal) => ({
  ...(await importOriginal<typeof RecycleBinFeedback>()),
  ...recycleBinFeedbackMocks
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input: unknown) =>
      route === 'ai.agent.restore'
        ? agentDataMocks.restoreAgent(input)
        : route === 'ai.agent.session.restore'
          ? agentDataMocks.restoreSession(input)
          : agentDataMocks.ipcRequest(route, input),
    on: vi.fn(() => () => undefined)
  }
}))

vi.mock('@renderer/utils/chat/sessionListHelpers', () => ({
  SESSION_UNKNOWN_AGENT_GROUP_ID: 'session:agent:unknown',
  sortSessionsForDisplayGroups: (sessions: unknown[]) => sessions
}))

vi.mock('@renderer/utils/agent', () => ({
  getAgentAvatarFromConfiguration: () => 'A'
}))

vi.mock('@renderer/utils/error', () => ({
  formatErrorMessageWithPrefix: (_error: unknown, prefix: string) => prefix,
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

describe('entity resource list actions', () => {
  const sidebarShortcut = (providerId: string, resourceId: string, fallbackLabel?: string) => {
    const target: SidebarShortcutTarget = { kind: 'resource', locator: { providerId, resourceId } }
    return {
      type: 'shortcut' as const,
      id: createSidebarShortcutId(target),
      target,
      ...(fallbackLabel ? { fallbackLabel } : {})
    }
  }

  beforeEach(() => {
    MockUseCacheUtils.resetMocks()
    agentDataMocks.agents = [
      {
        id: 'agent-1',
        name: 'Agent 1',
        orderKey: 'a',
        configuration: {},
        model: 'anthropic::claude-sonnet-4',
        modelName: 'Claude Sonnet 4'
      }
    ]
    agentDataMocks.error = null
    agentDataMocks.isLoading = false
    preferenceMocks.values.clear()
    preferenceMocks.setPreference.mockClear()
    agentDataMocks.deleteAgent.mockResolvedValue({ deleted: true, deletedSessionIds: [] })
    agentDataMocks.deleteAgent.mockClear()
    agentDataMocks.invalidate.mockResolvedValue(undefined)
    agentDataMocks.invalidate.mockClear()
    agentDataMocks.ipcRequest.mockImplementation((_route, input) =>
      agentDataMocks.deleteAgent({
        params: { agentId: input.agentId },
        query: { deleteSessions: input.deleteSessions }
      })
    )
    agentDataMocks.ipcRequest.mockClear()
    agentDataMocks.refetchAgents.mockResolvedValue(undefined)
    agentDataMocks.refetchAgents.mockClear()
    agentDataMocks.restoreAgent.mockResolvedValue(undefined)
    agentDataMocks.restoreAgent.mockClear()
    agentDataMocks.restoreSession.mockResolvedValue(undefined)
    agentDataMocks.restoreSession.mockClear()
    agentDataMocks.getActiveResource.mockResolvedValue({ id: 'active-resource' })
    agentDataMocks.getActiveResource.mockClear()
    agentDataMocks.toggleAgentPin.mockResolvedValue(undefined)
    agentDataMocks.toggleAgentPin.mockClear()
    tabsContextMocks.closeConversationTabs.mockClear()
    loggerMocks.error.mockClear()
    loggerMocks.info.mockClear()
    loggerMocks.warn.mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.success).mockClear()
    recycleBinFeedbackMocks.showRecycleBinBatchUndo.mockClear()
    recycleBinFeedbackMocks.showRecycleBinUndo.mockClear()
    conversationOwnerPopupMocks.show.mockClear()
    conversationOwnerPopupMocks.show.mockImplementation(
      async ({ action }: { action: (deleteChildren: boolean) => void | Promise<void> }) => {
        await action(false)
        return true
      }
    )
  })

  it('shows and activates an agent without sessions', async () => {
    const createdSession = { id: 'session-created', agentId: 'agent-1', name: 'Created Session' }
    const onCreateSession = vi.fn().mockResolvedValue(createdSession)
    const onSelectSession = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource({ sessions: [] })}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    expect(screen.getByRole('region', { name: 'Agent 1' })).toBeInTheDocument()
    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-selected-id', 'agent-1')

    fireEvent.click(screen.getByRole('button', { name: 'Select Agent 1' }))

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledExactlyOnceWith('agent-1'))
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith('session-created', createdSession)
  })

  it('toggles the selected agent pane while its active session is absent from the loading snapshot', async () => {
    const user = userEvent.setup()
    const onSelectedAgentClick = vi.fn()
    const onCreateSession = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        activeSessionId="session-not-loaded"
        agentSessionsSource={createAgentSessionsSource({ isFullyLoaded: false, sessions: [] })}
        onSelectSession={vi.fn()}
        onSelectedAgentClick={onSelectedAgentClick}
        onCreateSession={onCreateSession}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Select Agent 1' }))

    expect(onSelectedAgentClick).toHaveBeenCalledOnce()
    expect(onCreateSession).not.toHaveBeenCalled()
  })

  it('keeps sortable rail containers mounted while refresh temporarily blocks reorder', () => {
    const { rerender } = render(
      <AgentResourceList
        activeAgentId="agent-1"
        activeSessionId="session-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-sortable-container', 'enabled')
    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-reorder', 'enabled')

    rerender(
      <AgentResourceList
        activeAgentId="agent-1"
        activeSessionId="session-1"
        agentSessionsSource={createAgentSessionsSource({ isValidating: true })}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-sortable-container', 'enabled')
    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-reorder', 'disabled')
  })

  it('keeps retained sessions accessible under a non-actionable unlinked Agent entry', async () => {
    const user = userEvent.setup()
    const latestSession = createAgentSession({
      id: 'session-latest-unlinked',
      agentId: null,
      name: 'Latest unlinked Session'
    })
    const loadLatestSession = vi.fn().mockResolvedValueOnce(latestSession).mockResolvedValueOnce(null)
    const onCreateSession = vi.fn().mockResolvedValue(null)
    const onSelectSession = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="missing-agent"
        agentSessionsSource={createAgentSessionsSource({
          loadLatestSession,
          sessions: [
            createAgentSession({
              id: 'session-stale-owner',
              agentId: 'missing-agent',
              name: 'Stale owner Session'
            }),
            createAgentSession({ id: 'session-null-owner', agentId: null, name: 'Null owner Session' })
          ]
        })}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    const unlinkedAgentRegion = screen.getByRole('region', { name: 'agent.session.group.unknown_agent' })

    expect(unlinkedAgentRegion).toHaveAttribute('title', 'agent.session.group.unknown_agent_tip')
    expect(within(unlinkedAgentRegion).getByTestId('session:agent:unknown-context-menu')).toBeEmptyDOMElement()
    expect(within(unlinkedAgentRegion).getByTestId('session:agent:unknown-more-menu')).toBeEmptyDOMElement()
    expect(within(unlinkedAgentRegion).queryByRole('button', { name: 'agent.session.new' })).toBeNull()
    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-selected-id', 'session:agent:unknown')
    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute(
      'data-selected-click-id',
      'session:agent:unknown'
    )

    await user.click(
      within(unlinkedAgentRegion).getByRole('button', { name: 'Select agent.session.group.unknown_agent' })
    )

    await waitFor(() => expect(loadLatestSession).toHaveBeenCalledExactlyOnceWith(null))
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(latestSession.id, latestSession)

    await user.click(
      within(unlinkedAgentRegion).getByRole('button', { name: 'Select agent.session.group.unknown_agent' })
    )

    await waitFor(() => expect(loadLatestSession).toHaveBeenCalledTimes(2))
    expect(loadLatestSession).toHaveBeenLastCalledWith(null)
    expect(onCreateSession).not.toHaveBeenCalled()
  })

  it('does not classify a non-null Session owner as unlinked before Agent metadata loads successfully', () => {
    agentDataMocks.isLoading = true
    const props = {
      activeAgentId: 'agent-arriving',
      agentSessionsSource: createAgentSessionsSource({
        sessions: [
          createAgentSession({
            id: 'session-arriving-agent',
            agentId: 'agent-arriving',
            name: 'Arriving Agent Session'
          })
        ]
      }),
      onSelectSession: vi.fn(),
      onCreateSession: vi.fn(),
      onShowMissingAgentSelection: vi.fn()
    }
    const { rerender } = render(<AgentResourceList {...props} />)

    expect(screen.queryByRole('region', { name: 'agent.session.group.unknown_agent' })).toBeNull()

    agentDataMocks.isLoading = false
    agentDataMocks.error = new Error('Agent metadata failed')
    rerender(<AgentResourceList {...props} />)

    expect(screen.queryByRole('region', { name: 'agent.session.group.unknown_agent' })).toBeNull()

    agentDataMocks.error = null
    rerender(<AgentResourceList {...props} />)

    expect(screen.getByRole('region', { name: 'agent.session.group.unknown_agent' })).toBeInTheDocument()
  })

  it('does not report a pin failure when the post-success agent refresh fails', async () => {
    const user = userEvent.setup()
    const refreshError = new Error('transient refresh failure')
    agentDataMocks.refetchAgents.mockRejectedValueOnce(refreshError)

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    await user.click(
      within(screen.getByTestId('agent-1-context-menu')).getByRole('button', { name: 'agent.pin.title' })
    )

    await waitFor(() => expect(agentDataMocks.toggleAgentPin).toHaveBeenCalledWith('agent-1'))
    await waitFor(() =>
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        'Failed to refresh agents after toggling pin from classic-layout rail',
        { agentId: 'agent-1', err: refreshError }
      )
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a pin failure and skips the agent refresh when the pin mutation fails', async () => {
    const user = userEvent.setup()
    agentDataMocks.toggleAgentPin.mockRejectedValueOnce(new Error('pin mutation failed'))

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    await user.click(
      within(screen.getByTestId('agent-1-context-menu')).getByRole('button', { name: 'agent.pin.title' })
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'))
    expect(agentDataMocks.refetchAgents).not.toHaveBeenCalled()
  })

  it('uses delete-agent actions for the classic layout agent context and more menus', async () => {
    const onShowMissingAgentSelection = vi.fn()
    const onActiveAgentDeleted = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={onShowMissingAgentSelection}
        onActiveAgentDeleted={onActiveAgentDeleted}
      />
    )

    expect(screen.getByTestId('agent-1-context-menu')).toHaveTextContent('common.archive')
    expect(screen.getByTestId('agent-1-context-menu')).not.toHaveTextContent('common.delete_permanently')
    expect(screen.getByTestId('agent-1-more-menu')).toHaveTextContent('common.archive')
    expect(screen.getByTestId('agent-1-more-menu')).not.toHaveTextContent('common.delete_permanently')
    expect(screen.getByTestId('agent-1-context-menu')).not.toHaveTextContent('agent.session.agent.delete.trigger')
    expect(screen.getByTestId('agent-1-more-menu')).not.toHaveTextContent('agent.session.agent.delete.trigger')

    fireEvent.click(screen.getAllByRole('button', { name: 'common.archive' })[0])

    await waitFor(() =>
      expect(agentDataMocks.deleteAgent).toHaveBeenCalledWith({
        params: { agentId: 'agent-1' },
        query: { deleteSessions: false }
      })
    )
    expect(onActiveAgentDeleted).not.toHaveBeenCalled()
    expect(tabsContextMocks.closeConversationTabs).not.toHaveBeenCalled()
    expect(onShowMissingAgentSelection).not.toHaveBeenCalled()
    expect(recycleBinFeedbackMocks.showRecycleBinUndo).toHaveBeenCalledWith({
      itemName: 'Agent 1',
      title: 'common.archived',
      description: 'agent.archive.related_resources',
      onUndo: expect.any(Function)
    })

    await recycleBinFeedbackMocks.showRecycleBinUndo.mock.calls.at(-1)?.[0].onUndo()

    expect(agentDataMocks.restoreAgent).toHaveBeenCalledWith({ agentId: 'agent-1' })
    expect(agentDataMocks.refetchAgents).toHaveBeenCalled()
  })

  it('cascades an Agent delete only to returned Sessions and reconciles the returned active Session', async () => {
    const onActiveAgentDeleted = vi.fn()
    conversationOwnerPopupMocks.show.mockImplementationOnce(
      async ({ action }: { action: (deleteChildren: boolean) => void | Promise<void> }) => {
        await action(true)
        return true
      }
    )
    agentDataMocks.deleteAgent.mockResolvedValueOnce({
      deleted: true,
      deletedSessionIds: ['session-1', 'session-not-loaded']
    })

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        activeSessionId="session-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
        onActiveAgentDeleted={onActiveAgentDeleted}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'common.archive' })[0])

    await waitFor(() =>
      expect(agentDataMocks.deleteAgent).toHaveBeenCalledWith({
        params: { agentId: 'agent-1' },
        query: { deleteSessions: true }
      })
    )
    expect(tabsContextMocks.closeConversationTabs).toHaveBeenCalledWith('agents', ['session-1', 'session-not-loaded'])
    expect(onActiveAgentDeleted).toHaveBeenCalledWith('agent-1')

    await recycleBinFeedbackMocks.showRecycleBinUndo.mock.calls.at(-1)?.[0].onUndo()

    expect(agentDataMocks.restoreAgent).toHaveBeenCalledWith({ agentId: 'agent-1' })
    expect(agentDataMocks.restoreSession).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(agentDataMocks.restoreSession).toHaveBeenCalledWith({ sessionId: 'session-not-loaded' })
  })

  it('does not fail Agent Undo when restore succeeds but follow-up refreshes reject', async () => {
    const reload = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('session refresh failed'))
    agentDataMocks.refetchAgents
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Agent refresh failed'))

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource({ reload })}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'common.archive' })[0])
    await waitFor(() => expect(recycleBinFeedbackMocks.showRecycleBinUndo).toHaveBeenCalled())

    await expect(recycleBinFeedbackMocks.showRecycleBinUndo.mock.calls.at(-1)?.[0].onUndo()).resolves.toBeUndefined()

    expect(agentDataMocks.restoreAgent).toHaveBeenCalledWith({ agentId: 'agent-1' })
    expect(loggerMocks.warn).toHaveBeenCalled()
  })

  it('treats Agent restore NOT_FOUND as complete only after refresh confirms the Agent is active', async () => {
    agentDataMocks.restoreAgent.mockRejectedValueOnce(new IpcError(aiErrorCodes.AI_AGENT_NOT_FOUND, 'Agent missing'))

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'common.archive' })[0])
    await waitFor(() => expect(recycleBinFeedbackMocks.showRecycleBinUndo).toHaveBeenCalled())

    await expect(recycleBinFeedbackMocks.showRecycleBinUndo.mock.calls.at(-1)?.[0].onUndo()).resolves.toBeUndefined()

    expect(agentDataMocks.getActiveResource).toHaveBeenCalledWith('/agents/agent-1')
  })

  it('refreshes a stale Agent delete without closing tabs, reconciling selection, or offering Undo', async () => {
    const onActiveAgentDeleted = vi.fn()
    agentDataMocks.deleteAgent.mockResolvedValueOnce({ deleted: false, deletedSessionIds: [] })

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
        onActiveAgentDeleted={onActiveAgentDeleted}
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'common.archive' })[0])

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('recycle_bin.already_moved'))
    expect(tabsContextMocks.closeConversationTabs).not.toHaveBeenCalled()
    expect(onActiveAgentDeleted).not.toHaveBeenCalled()
    expect(recycleBinFeedbackMocks.showRecycleBinUndo).not.toHaveBeenCalled()
    expect(agentDataMocks.refetchAgents).toHaveBeenCalled()
  })

  it('creates a new session for the hovered agent row', () => {
    const onCreateSession = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'agent.session.new' }))

    expect(onCreateSession).toHaveBeenCalledWith('agent-1')
  })

  it('lets the classic agent rail switch icon display mode from the context menu', () => {
    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    expect(screen.getByTestId('agent-1-context-menu')).toHaveTextContent('agent.icon.type')

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.assistant.icon.type.none' })[0])

    expect(preferenceMocks.setPreference).toHaveBeenCalledWith('agent.icon_type', 'none')
  })

  it('lets the classic agent rail switch back to the workdir session view', async () => {
    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'agent.session.display.workdir' }))

    await waitFor(() => {
      expect(preferenceMocks.setPreference).toHaveBeenCalledWith('agent.session.display_mode', 'workdir')
    })
  })

  it('clears the active agent selection while a resource view is active', () => {
    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        manageAgentsActive
        onManageAgents={vi.fn()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    expect(screen.getByTestId('resource-entity-rail')).toHaveAttribute('data-selected-id', '')
  })

  it('keeps classic agent rail history in the shared display menu without section toggles', () => {
    const onOpenHistoryRecords = vi.fn()

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onOpenHistoryRecords={onOpenHistoryRecords}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'history.records.shortTitle' }))

    expect(onOpenHistoryRecords).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('agent.session.group.expand_all')).not.toBeInTheDocument()
    expect(screen.queryByText('agent.session.group.collapse_all')).not.toBeInTheDocument()
  })

  it('offers toggling an agent into the sidebar from the classic rail context menu', async () => {
    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    const menu = screen.getByTestId('agent-1-context-menu')
    expect(menu).toHaveTextContent('launchpad.pin_to_sidebar')
    expect(menu).not.toHaveTextContent('launchpad.unpin_from_sidebar')

    fireEvent.click(within(menu).getByRole('button', { name: 'launchpad.pin_to_sidebar' }))

    await waitFor(() =>
      expect(preferenceMocks.setPreference).toHaveBeenCalledWith('ui.sidebar_shortcut', [
        sidebarShortcut('core.agent', 'agent-1', 'Agent 1')
      ])
    )
  })

  it('toggles an already-pinned agent out of the sidebar from the classic rail context menu', async () => {
    preferenceMocks.values.set('ui.sidebar_shortcut', [sidebarShortcut('core.agent', 'agent-1')])

    render(
      <AgentResourceList
        activeAgentId="agent-1"
        agentSessionsSource={createAgentSessionsSource()}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onShowMissingAgentSelection={vi.fn()}
      />
    )

    const menu = screen.getByTestId('agent-1-context-menu')
    expect(menu).toHaveTextContent('launchpad.unpin_from_sidebar')

    fireEvent.click(within(menu).getByRole('button', { name: 'launchpad.unpin_from_sidebar' }))

    await waitFor(() => expect(preferenceMocks.setPreference).toHaveBeenCalledWith('ui.sidebar_shortcut', []))
  })
})
