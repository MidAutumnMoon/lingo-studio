import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type * as ReactI18nextModule from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WindowFrameProvider } from '@renderer/components/chat/shell/WindowFrameContext'
import { useCommandHandler } from '@renderer/hooks/command'

const initialTopic: Topic = {
  id: 'topic-initial',
  assistantId: 'assistant-1',
  name: 'Initial topic',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [],
  pinned: false,
  isNameManuallyEdited: false
}

const historyTopic: Topic = {
  id: 'topic-history',
  assistantId: 'assistant-1',
  name: 'History topic',
  lastActivityAt: '2026-01-02T00:00:00.000Z',
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  messages: [],
  pinned: false,
  isNameManuallyEdited: false
}

const createdTopic: Topic = {
  id: 'topic-created',
  assistantId: 'assistant-2',
  name: '',
  lastActivityAt: '2026-01-03T00:00:00.000Z',
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  messages: [],
  pinned: false,
  isNameManuallyEdited: false
}

const homeMocks = vi.hoisted(() => ({
  activeTopicOptions: undefined as
    | {
        activeTopicId?: string | null
        setActiveTopicId?: (id: string | null) => void
      }
    | undefined,
  cacheSetPersist: vi.fn(),
  createTopic: vi.fn(),
  // The shared topic source: one list for the whole page, scoped per assistant by the pane.
  topics: [] as Array<{
    id: string
    assistantId?: string
    name: string
    activeNodeId?: string
    isNameManuallyEdited?: boolean
    lastActivityAt?: string
    createdAt?: string
    updatedAt: string
  }>,
  isTopicsFirstPageLoading: false,
  isTopicsLoadingAll: false,
  isTopicsFullyLoaded: true,
  assistants: [{ id: 'assistant-default' }] as Array<{
    id: string
    modelId?: string | null
    name?: string
    emoji?: string
  }>,
  assistantsError: undefined as Error | undefined,
  assistantsLoaded: true,
  assistantsLoading: false,
  assistantsRefreshing: false,
  activeTopicLoading: false,
  activeTopicError: undefined as Error | undefined,
  activeTopicOverride: undefined as Topic | undefined,
  activeTopicSource: 'query' as 'query' | 'pending' | 'none',
  topicsPaneSource: undefined as unknown,
  sharedTopicsSource: undefined as unknown,
  forceActiveTopicUndefined: false,
  // The topic the entry interceptor resolved before the page mounted; `undefined` → bare entry.
  entryTopic: undefined as Topic | undefined,
  persistCacheValues: new Map<string, unknown>(),
  preferenceValues: new Map<string, unknown>(),
  refreshTopics: vi.fn(),
  reuseOrCreateTopic: vi.fn(),
  navigate: vi.fn(),
  routeSearch: {} as Record<string, unknown>,
  setShowSidebar: vi.fn(),
  isActiveTab: false
}))

const ipcMocks = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: ipcMocks.request }, useIpcOn: vi.fn() }))

vi.mock('@renderer/hooks/command', () => ({
  useCommandHandler: vi.fn(),
  useResolvedCommand: () => ({
    enabled: true,
    execute: vi.fn(),
    label: 'Toggle sidebar',
    shortcutLabel: ''
  })
}))

vi.mock('@data/hooks/usePreference', async () => {
  const React = await import('react')

  return {
    usePreference: (key: string) => {
      const [value, setValue] = React.useState(() => homeMocks.preferenceValues.get(key))
      const setPreference = vi.fn(async (nextValue: unknown) => {
        homeMocks.preferenceValues.set(key, nextValue)
        if (key === 'topic.tab.show') {
          homeMocks.setShowSidebar(nextValue)
        }
        setValue(nextValue)
      })

      return [value, setPreference]
    }
  }
})

vi.mock('@renderer/data/hooks/useCache', async () => {
  const React = await import('react')

  return {
    usePersistCache: (key: string) => {
      const [value, setValue] = React.useState<unknown>(() => {
        if (homeMocks.persistCacheValues.has(key)) {
          return homeMocks.persistCacheValues.get(key)
        }

        return null
      })
      const setPersistCache = vi.fn((nextValue: unknown) => {
        homeMocks.persistCacheValues.set(key, nextValue)
        homeMocks.cacheSetPersist(key, nextValue)
        setValue(nextValue)
      })

      return [value, setPersistCache]
    }
  }
})

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  ResourceCatalogView: ({
    onOpenAssistantChat,
    resourceType,
    toolbarLeading
  }: {
    onOpenAssistantChat?: (assistantId: string) => void
    resourceType: string
    toolbarLeading?: ReactNode
  }) => (
    <div data-testid={`resource-catalog-${resourceType}`}>
      {toolbarLeading && <div data-testid="resource-toolbar-leading">{toolbarLeading}</div>}
      {resourceType === 'assistant' && (
        <button type="button" onClick={() => onOpenAssistantChat?.('assistant-2')}>
          Go to chat with assistant 2
        </button>
      )}
    </div>
  )
}))

vi.mock('@renderer/hooks/tab', () => ({
  useCurrentTabId: () => 'chat-tab',
  useIsActiveTab: () => homeMocks.isActiveTab,
  useTabSelfVisuals: vi.fn()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistantsApi: () => ({
    assistants: homeMocks.assistants,
    hasLoaded: homeMocks.assistantsLoaded,
    isLoading: homeMocks.assistantsLoading,
    isRefreshing: homeMocks.assistantsRefreshing,
    error: homeMocks.assistantsError,
    refetch: vi.fn()
  })
}))

vi.mock('@renderer/hooks/resourceViewSources', async () => {
  const React = await import('react')

  return {
    // Match the real source shape: loading flags plus the shared reuse-or-create lookup.
    useAssistantTopicsSource: () => {
      const source = React.useMemo(
        () => ({
          topics: homeMocks.topics,
          // The mocked mapApiTopicToRendererTopic below is the identity, so the
          // shared renderer view is the same list.
          rendererTopics: homeMocks.topics,
          orderSignature: '',
          isLoading: homeMocks.isTopicsFirstPageLoading,
          isLoadingAll: homeMocks.isTopicsLoadingAll,
          isFullyLoaded: homeMocks.isTopicsFullyLoaded,
          error: undefined,
          reuseOrCreateTopic: homeMocks.reuseOrCreateTopic
        }),
        []
      )
      homeMocks.sharedTopicsSource = source
      return source
    }
  }
})

vi.mock('@renderer/hooks/useTopic', async () => {
  const React = await import('react')

  return {
    mapApiTopicToRendererTopic: (topic: Topic) => topic,
    useTopicMutations: () => ({
      createTopic: homeMocks.createTopic,
      refreshTopics: homeMocks.refreshTopics
    }),
    useActiveTopic: (options: { activeTopicId: string | null; setActiveTopicId: (id: string | null) => void }) => {
      const [activeTopic, setActiveTopic] = React.useState<Topic | undefined>(homeMocks.entryTopic)
      const commitActiveTopicId = options.setActiveTopicId
      const setActiveTopicId = React.useCallback(
        (id: string | null) => {
          if (id === null) {
            homeMocks.activeTopicOverride = undefined
            setActiveTopic(undefined)
          }
          commitActiveTopicId(id)
        },
        [commitActiveTopicId]
      )
      const setActiveTopicValue = React.useCallback(
        (topic: Topic) => {
          homeMocks.activeTopicOverride = topic
          setActiveTopic(topic)
          commitActiveTopicId(topic.id)
        },
        [commitActiveTopicId]
      )
      homeMocks.activeTopicOptions = {
        activeTopicId: options.activeTopicId,
        setActiveTopicId
      }
      const clearActiveTopic = React.useCallback(() => {
        homeMocks.activeTopicOverride = undefined
        setActiveTopic(undefined)
        commitActiveTopicId(null)
      }, [commitActiveTopicId])
      return {
        activeTopic: homeMocks.forceActiveTopicUndefined ? undefined : (homeMocks.activeTopicOverride ?? activeTopic),
        setActiveTopic: setActiveTopicValue,
        clearActiveTopic,
        isLoading: homeMocks.activeTopicLoading,
        error: homeMocks.activeTopicError,
        topicSource: homeMocks.activeTopicSource
      }
    }
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => homeMocks.navigate,
  getRouteApi: () => ({ useSearch: () => homeMocks.routeSearch })
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18nextModule>()),
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'chat.home.welcome_title': 'Welcome',
        'chat.topics.title': '对话',
        'common.loading': 'Loading...'
      })[key] ?? key
  })
}))

vi.mock('../Chat', () => ({
  default: ({
    activeTopic,
    centerSurface,
    pane,
    paneOpen,
    panePosition,
    showResourceListControls,
    onSidebarToggle,
    locateMessageId,
    onCreateEmptyTopic,
    onNewTopic,
    onLocateMessageHandled,
    onPaneCollapse,
    onPaneAutoCollapseChange,
    paneManualToggle
  }: {
    activeTopic?: Topic
    centerSurface?: { content?: ReactNode } | null
    pane?: ReactNode
    paneOpen?: boolean
    panePosition?: string
    showResourceListControls?: boolean
    onSidebarToggle?: () => void
    locateMessageId?: string
    onCreateEmptyTopic?: (payload?: { assistantId?: string | null }) => void | Promise<void>
    onNewTopic?: (payload?: { assistantId?: string | null }) => void | Promise<void>
    onLocateMessageHandled?: () => void
    onPaneCollapse?: () => void
    onPaneAutoCollapseChange?: (collapsed: boolean) => void
    paneManualToggle?: { seq: number; open: boolean }
  }) => {
    const showConversation = Boolean(activeTopic && !centerSurface)

    return (
      <section data-testid="home-chat-shell" data-active-topic-id={activeTopic?.id ?? ''}>
        <output data-testid="pane-open">{String(paneOpen)}</output>
        <output data-testid="pane-position">{panePosition ?? ''}</output>
        <output data-testid="pane-manual-toggle">
          {paneManualToggle ? `${paneManualToggle.seq}:${paneManualToggle.open}` : 'none'}
        </output>
        {centerSurface?.content}
        {showConversation && activeTopic && (
          <>
            <output data-testid="active-topic">{activeTopic.id}</output>
            <output data-testid="active-topic-assistant">{activeTopic.assistantId ?? ''}</output>
            <output data-testid="show-resource-list-controls">{String(showResourceListControls)}</output>
            <output data-testid="locate-message-id">{locateMessageId ?? ''}</output>
            {showResourceListControls && onSidebarToggle && (
              <button type="button" onClick={onSidebarToggle}>
                Toggle sidebar
              </button>
            )}
            {onNewTopic && (
              <button type="button" onClick={() => onNewTopic()}>
                New topic
              </button>
            )}
            {onNewTopic && (
              <button type="button" onClick={() => onNewTopic({ assistantId: 'assistant-2' })}>
                New topic with assistant 2
              </button>
            )}
            {onNewTopic && (
              <button type="button" onClick={() => onNewTopic({ assistantId: 'missing-assistant' })}>
                New topic with missing assistant
              </button>
            )}
            {onCreateEmptyTopic && (
              // The composer resolves its own selection, so it names the assistant it is showing.
              <button type="button" onClick={() => onCreateEmptyTopic({ assistantId: activeTopic.assistantId })}>
                Create empty topic from composer
              </button>
            )}
            {onLocateMessageHandled && (
              <button type="button" onClick={() => onLocateMessageHandled()}>
                Locate handled
              </button>
            )}
          </>
        )}
        {onPaneCollapse && (
          <button type="button" onClick={onPaneCollapse}>
            Collapse pane
          </button>
        )}
        {onPaneAutoCollapseChange && (
          <>
            <button type="button" onClick={() => onPaneAutoCollapseChange(true)}>
              Auto collapse pane
            </button>
            <button type="button" onClick={() => onPaneAutoCollapseChange(false)}>
              Auto restore pane
            </button>
          </>
        )}
        <div data-testid="topic-right-pane-viewport" />
        {pane}
      </section>
    )
  }
}))

vi.mock('../Tabs/components/Topics', () => ({
  Topics: ({
    activeAssistantId,
    activeTopic,
    assistantTopicsSource,
    dataEnabled,
    historyRecordsActive,
    manageAssistantsActive,
    onManageAssistants,
    onNewTopic,
    onOpenHistoryRecords,
    revealRequest,
    setActiveTopic
  }: {
    activeAssistantId?: string | null
    activeTopic?: Topic
    assistantTopicsSource?: unknown
    dataEnabled?: boolean
    historyRecordsActive?: boolean
    manageAssistantsActive?: boolean
    onManageAssistants?: () => void | Promise<void>
    onNewTopic?: (payload?: { assistantId?: string | null }) => void | Promise<void>
    onOpenHistoryRecords?: () => void
    revealRequest?: unknown
    setActiveTopic?: (topic: Topic) => void
  }) => {
    homeMocks.topicsPaneSource = assistantTopicsSource

    return (
      <div
        data-active-assistant-id={activeAssistantId ?? ''}
        data-active-topic-id={activeTopic?.id ?? ''}
        data-data-enabled={String(dataEnabled)}
        data-history-records-active={String(Boolean(historyRecordsActive))}
        data-manage-assistants-active={String(Boolean(manageAssistantsActive))}
        data-reveal-request={JSON.stringify(revealRequest ?? null)}
        data-testid="topic-pane">
        {onManageAssistants && (
          // The list's options menu is the way into the assistant library.
          <button type="button" onClick={() => void onManageAssistants()}>
            Manage assistants
          </button>
        )}
        {onOpenHistoryRecords && (
          <button type="button" onClick={onOpenHistoryRecords}>
            Open history records
          </button>
        )}
        {onNewTopic && (
          // The list header creates for the scope it was handed (`activeAssistantId ?? null`).
          <button type="button" onClick={() => void onNewTopic({ assistantId: activeAssistantId ?? null })}>
            Create topic from header
          </button>
        )}
        {setActiveTopic && (
          <button
            type="button"
            onClick={() =>
              setActiveTopic({
                id: 'topic-next',
                assistantId: 'assistant-default',
                name: 'Topic Next',
                messages: [],
                lastActivityAt: '2026-01-02T00:00:00.000Z',
                createdAt: '2026-01-02T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
                pinned: false,
                isNameManuallyEdited: false
              })
            }>
            Select topic next
          </button>
        )}
      </div>
    )
  }
}))

vi.mock('../components/TopicRightPane', () => {
  const TopicRightPaneScope = ({
    children,
    present,
    revealRequest,
    topicId
  }: {
    children: ReactNode
    present?: boolean
    revealRequest?: unknown
    topicId?: string
  }) => (
    <div
      data-present={String(present !== false)}
      data-reveal-request={JSON.stringify(revealRequest ?? null)}
      data-topic-id={topicId ?? ''}
      data-testid="topic-right-pane-provider">
      {children}
    </div>
  )
  const TopicRightPane = {
    Scope: TopicRightPaneScope,
    Viewport: () => <div data-testid="topic-right-pane-viewport" />,
    Shortcuts: () => <button type="button">Topic right pane shortcuts</button>
  }

  return {
    TopicRightPane
  }
})

vi.mock('@renderer/components/history/HistoryRecordsView', () => ({
  default: ({
    open,
    onRecordSelect,
    onActiveRecordChange
  }: {
    open?: boolean
    onRecordSelect?: (topic: Topic) => void
    onActiveRecordChange?: (topic: Topic | null) => void
  }) =>
    open ? (
      <div data-testid="history-records-view">
        <button type="button" onClick={() => onRecordSelect?.(historyTopic)}>
          Open history topic
        </button>
        <button type="button" onClick={() => onActiveRecordChange?.(historyTopic)}>
          Replace deleted topic
        </button>
        <button type="button" onClick={() => onActiveRecordChange?.(null)}>
          Clear history selection
        </button>
      </div>
    ) : null
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    FOCUS_CHAT_COMPOSER: 'FOCUS_CHAT_COMPOSER',
    GLOBAL_SEARCH_SELECT_TOPIC: 'GLOBAL_SEARCH_SELECT_TOPIC',
    GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE: 'GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE'
  },
  EventEmitter: {
    emit: vi.fn(),
    on: vi.fn(() => vi.fn())
  }
}))

import { useTabSelfVisuals } from '@renderer/hooks/tab'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { toast } from '@renderer/services/toast'
import type { Topic } from '@renderer/types/topic'

import HomePage from '../HomePage'

describe('HomePage', () => {
  const topicPaneScope = () => screen.getByTestId('topic-pane').getAttribute('data-active-assistant-id')
  const eventHandler = (name: string) =>
    vi.mocked(EventEmitter.on).mock.calls.find(([eventName]) => eventName === name)?.[1] as
      | ((payload: unknown) => void)
      | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    homeMocks.entryTopic = initialTopic
    homeMocks.assistants = [{ id: 'assistant-default' }]
    homeMocks.topics = []
    homeMocks.isTopicsFirstPageLoading = false
    homeMocks.isTopicsLoadingAll = false
    homeMocks.isTopicsFullyLoaded = true
    homeMocks.assistantsError = undefined
    homeMocks.assistantsLoaded = true
    homeMocks.assistantsLoading = false
    homeMocks.assistantsRefreshing = false
    homeMocks.routeSearch = {}
    // HomePage writes its write-only persist keys (global-search recents) straight
    // through cacheService, bypassing the hook mock below.
    MockCacheUtils.resetMocks()
    homeMocks.activeTopicOptions = undefined
    homeMocks.sharedTopicsSource = undefined
    homeMocks.topicsPaneSource = undefined
    homeMocks.persistCacheValues.clear()
    homeMocks.isActiveTab = false
    homeMocks.createTopic.mockResolvedValue(createdTopic)
    homeMocks.refreshTopics.mockResolvedValue(undefined)
    homeMocks.reuseOrCreateTopic.mockReset().mockImplementation(async (assistantId: string | null) => {
      const candidates = [homeMocks.activeTopicOverride, homeMocks.entryTopic, ...homeMocks.topics]
        .filter((topic): topic is NonNullable<typeof topic> => !!topic)
        .filter(
          (topic) =>
            (assistantId === null ? !topic.assistantId : topic.assistantId === assistantId) &&
            !topic.activeNodeId &&
            !topic.name.trim() &&
            !topic.isNameManuallyEdited
        )
      const reusable = [...candidates].sort((left, right) => {
        const leftMs = Date.parse(left.updatedAt)
        const rightMs = Date.parse(right.updatedAt)
        return (
          (Number.isFinite(rightMs) ? rightMs : Number.NEGATIVE_INFINITY) -
          (Number.isFinite(leftMs) ? leftMs : Number.NEGATIVE_INFINITY)
        )
      })[0]
      if (reusable) return { topic: reusable, created: false }

      const topic = await homeMocks.createTopic(assistantId ? { assistantId } : {})
      return { topic, created: true }
    })
    homeMocks.activeTopicLoading = false
    homeMocks.activeTopicError = undefined
    homeMocks.activeTopicOverride = undefined
    homeMocks.activeTopicSource = 'query'
    homeMocks.forceActiveTopicUndefined = false
    homeMocks.navigate.mockResolvedValue(undefined)
    homeMocks.preferenceValues.clear()
    homeMocks.preferenceValues.set('topic.tab.show', false)
    homeMocks.preferenceValues.set('chat.message.style', 'message-style')

    ipcMocks.request.mockClear()
  })

  it('warms the visible assistant model from the assistant list', () => {
    homeMocks.assistants = [{ id: 'assistant-1', modelId: 'provider-a::model-a' }]

    render(<HomePage />)

    // Chat is mocked in this suite, so the enabled model query can only come from HomePage's list hint.
    expect(
      mockUseQuery.mock.calls.some(
        ([path, options]) => path === '/models/provider-a::model-a' && options?.enabled !== false
      )
    ).toBe(true)
  })

  it("scopes the topic pane to the visible topic's assistant, ahead of the route", () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
    homeMocks.entryTopic = { ...initialTopic, assistantId: 'assistant-1' }
    homeMocks.routeSearch = { assistantId: 'assistant-2' }

    render(<HomePage />)

    expect(topicPaneScope()).toBe('assistant-1')
  })

  it('falls back to the route, then the remembered, then the first assistant, and only trusts live ids', () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
    homeMocks.entryTopic = undefined

    homeMocks.routeSearch = { assistantId: 'assistant-2' }
    const routed = render(<HomePage />)
    expect(topicPaneScope()).toBe('assistant-2')
    routed.unmount()

    homeMocks.routeSearch = { assistantId: 'assistant-gone' }
    homeMocks.persistCacheValues.set('ui.chat.last_used_assistant_id', 'assistant-2')
    const remembered = render(<HomePage />)
    expect(topicPaneScope()).toBe('assistant-2')
    remembered.unmount()

    homeMocks.routeSearch = {}
    homeMocks.persistCacheValues.set('ui.chat.last_used_assistant_id', 'assistant-gone')
    render(<HomePage />)
    expect(topicPaneScope()).toBe('assistant-1')
  })

  it('scopes the topic pane to the unlinked conversations when no assistant is left', () => {
    homeMocks.assistants = []
    homeMocks.entryTopic = { ...initialTopic, assistantId: 'assistant-gone' }

    render(<HomePage />)

    // `null` is the pane's "conversations whose assistant is gone" scope, not the empty string.
    expect(topicPaneScope()).toBe('')
  })

  it('keeps one left pane fed by the shared topic source', () => {
    render(<HomePage />)

    expect(screen.getByTestId('pane-position')).toHaveTextContent('left')
    expect(homeMocks.topicsPaneSource).toBe(homeMocks.sharedTopicsSource)
  })

  it('marks the sidebar collapse control as a manual pane toggle', () => {
    render(<HomePage />)

    expect(screen.getByTestId('pane-manual-toggle')).toHaveTextContent('none')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse pane' }))

    expect(screen.getByTestId('pane-manual-toggle')).toHaveTextContent('1:false')
  })

  it('collapses the topic sidebar when the shared shell requests it', async () => {
    homeMocks.preferenceValues.set('topic.tab.show', true)

    render(<HomePage />)

    expect(screen.getByTestId('pane-open')).toHaveTextContent('true')
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-data-enabled', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse pane' }))

    await waitFor(() => expect(homeMocks.setShowSidebar).toHaveBeenCalledWith(false))
    expect(screen.getByTestId('pane-open')).toHaveTextContent('false')
    // The list stops loading topics while its pane is hidden.
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-data-enabled', 'false')
  })

  it('temporarily hides and restores the topic sidebar for responsive auto-collapse without changing the user preference', async () => {
    homeMocks.preferenceValues.set('topic.tab.show', true)

    render(<HomePage />)

    expect(screen.getByTestId('pane-open')).toHaveTextContent('true')

    fireEvent.click(screen.getByRole('button', { name: 'Auto collapse pane' }))

    await waitFor(() => expect(screen.getByTestId('pane-open')).toHaveTextContent('false'))
    expect(homeMocks.setShowSidebar).not.toHaveBeenCalled()
    expect(homeMocks.preferenceValues.get('topic.tab.show')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Auto restore pane' }))

    await waitFor(() => expect(screen.getByTestId('pane-open')).toHaveTextContent('true'))
    expect(homeMocks.setShowSidebar).not.toHaveBeenCalled()
    expect(homeMocks.preferenceValues.get('topic.tab.show')).toBe(true)
  })

  it('toggles the topic sidebar off with the sidebar shortcut', () => {
    homeMocks.preferenceValues.set('topic.tab.show', true)

    render(<HomePage />)

    const shortcutHandler = vi
      .mocked(useCommandHandler)
      .mock.calls.filter(([command]) => command === 'app.sidebar.toggle')
      .at(-1)?.[1]

    expect(shortcutHandler).toBeDefined()

    act(() => {
      void shortcutHandler?.()
    })

    expect(homeMocks.setShowSidebar).toHaveBeenCalledWith(false)
  })

  it('keeps detached topic sidebar state local, default-closed, and left-anchored', () => {
    homeMocks.preferenceValues.set('topic.tab.show', true)

    const { unmount } = render(
      <WindowFrameProvider value={{ mode: 'window' }}>
        <HomePage />
      </WindowFrameProvider>
    )

    expect(screen.getByTestId('pane-open')).toHaveTextContent('false')
    expect(screen.getByTestId('pane-position')).toHaveTextContent('left')
    expect(screen.getByTestId('show-resource-list-controls')).toHaveTextContent('true')
    expect(screen.getByTestId('topic-pane')).toBeInTheDocument()
    // Detached windows have no history records surface and no assistant library.
    expect(screen.queryByRole('button', { name: 'Open history records' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage assistants' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(screen.getByTestId('pane-open')).toHaveTextContent('true')

    fireEvent.click(screen.getByRole('button', { name: 'Select topic next' }))
    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-next')
    expect(screen.getByTestId('pane-open')).toHaveTextContent('true')

    const shortcutHandler = vi
      .mocked(useCommandHandler)
      .mock.calls.filter(([command]) => command === 'app.sidebar.toggle')
      .at(-1)?.[1]

    act(() => {
      void shortcutHandler?.()
    })

    expect(screen.getByTestId('pane-open')).toHaveTextContent('false')
    expect(homeMocks.setShowSidebar).not.toHaveBeenCalled()

    unmount()
    homeMocks.persistCacheValues.set('ui.global_search.recent_items', [])
    render(
      <WindowFrameProvider value={{ mode: 'window' }}>
        <HomePage />
      </WindowFrameProvider>
    )
    expect(screen.getByTestId('pane-open')).toHaveTextContent('false')
  })

  it('labels the tab with the visible topic and preserves visuals while the bound topic loads', () => {
    homeMocks.assistants = [{ id: 'assistant-1', name: 'Assistant One', emoji: '🤖' }]

    const { rerender } = render(<HomePage />)

    expect(vi.mocked(useTabSelfVisuals)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: initialTopic.name,
        emoji: '🤖',
        routePrefix: '/app/chat',
        preserveVisuals: false
      })
    )

    homeMocks.routeSearch = { topicId: 'topic-not-loaded' }
    homeMocks.activeTopicLoading = true
    homeMocks.forceActiveTopicUndefined = true
    rerender(<HomePage />)

    // The tab keeps the title it already shows instead of stamping a generic one mid-load.
    expect(vi.mocked(useTabSelfVisuals)).toHaveBeenLastCalledWith(
      expect.objectContaining({ routePrefix: '/app/chat', preserveVisuals: true })
    )
  })

  it('clears a remembered assistant that no longer exists', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }]
    homeMocks.entryTopic = undefined
    homeMocks.persistCacheValues.set('ui.chat.last_used_assistant_id', 'assistant-gone')

    render(<HomePage />)

    await waitFor(() => expect(homeMocks.persistCacheValues.get('ui.chat.last_used_assistant_id')).toBeNull())
    expect(topicPaneScope()).toBe('assistant-1')
  })

  it('never auto-creates a topic on entry, even with an empty topic library', async () => {
    // The seeder guarantees a first topic and every delete path creates its replacement, so a bare
    // entry that resolves to nothing shows the empty state instead of silently creating a topic.
    homeMocks.entryTopic = undefined
    homeMocks.topics = []

    render(<HomePage />)

    await waitFor(() => expect(screen.getByTestId('home-chat-shell')).toBeInTheDocument())
    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
  })

  it('creates a new topic for the assistant named by the payload', async () => {
    homeMocks.assistants = [{ id: 'assistant-default' }, { id: 'assistant-2' }]
    homeMocks.createTopic.mockResolvedValue({ ...createdTopic, assistantId: 'assistant-2' })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'New topic with assistant 2' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalledWith({ assistantId: 'assistant-2' }))
    expect(screen.getByTestId('active-topic-assistant')).toHaveTextContent('assistant-2')
  })

  it('prefers a valid payload assistant over the remembered and first assistants', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
    homeMocks.persistCacheValues.set('ui.chat.last_used_assistant_id', 'assistant-1')

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'New topic with assistant 2' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalledWith({ assistantId: 'assistant-2' }))
    expect(screen.getByTestId('active-topic-assistant')).toHaveTextContent('assistant-2')
  })

  it('ignores a payload assistant that no longer exists', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
    homeMocks.persistCacheValues.set('ui.chat.last_used_assistant_id', 'assistant-1')

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'New topic with missing assistant' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalledWith({ assistantId: 'assistant-1' }))
  })

  it('reuses an empty topic from the shared topic source instead of stacking a new blank', async () => {
    homeMocks.assistants = [{ id: 'assistant-default' }, { id: 'assistant-2' }]
    homeMocks.topics = [
      {
        id: 'topic-empty-shared',
        assistantId: 'assistant-2',
        name: '',
        createdAt: '2026-01-04T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z'
      }
    ]

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'New topic with assistant 2' }))

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-empty-shared'))
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
  })

  it('reuses the open empty topic before the topic source refreshes', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-default' }]
    homeMocks.entryTopic = {
      ...initialTopic,
      id: 'topic-empty-current',
      name: '',
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z'
    }
    homeMocks.topics = []

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create empty topic from composer' }))

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-empty-current'))
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
  })

  it('reuses the open empty topic for the composer button', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-default' }]
    homeMocks.topics = [
      {
        id: 'topic-empty-latest',
        assistantId: 'assistant-1',
        name: '',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z'
      }
    ]

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create empty topic from composer' }))

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-empty-latest'))
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
    expect(homeMocks.refreshTopics).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(EventEmitter.emit).toHaveBeenCalledWith('FOCUS_CHAT_COMPOSER', {
        topicId: 'topic-empty-latest'
      })
    )
  })

  it('creates and activates a fresh empty topic when no empty topic exists', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-default' }]
    homeMocks.topics = [
      {
        id: 'topic-real-latest',
        assistantId: 'assistant-1',
        name: 'Real chat',
        activeNodeId: 'node-real',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z'
      }
    ]
    homeMocks.createTopic.mockResolvedValue({
      ...createdTopic,
      id: 'topic-composer-empty',
      assistantId: 'assistant-1'
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create empty topic from composer' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalledWith({ assistantId: 'assistant-1' }))
    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-composer-empty')
    expect(homeMocks.refreshTopics).toHaveBeenCalled()
    await waitFor(() =>
      expect(EventEmitter.emit).toHaveBeenCalledWith('FOCUS_CHAT_COMPOSER', {
        topicId: 'topic-composer-empty'
      })
    )
  })

  it('creates an unassigned topic from the topic pane header when no assistant is scoped', async () => {
    homeMocks.assistants = []
    homeMocks.entryTopic = { ...initialTopic, assistantId: 'assistant-gone' }
    homeMocks.createTopic.mockResolvedValue({ ...createdTopic, assistantId: undefined })

    render(<HomePage />)

    expect(topicPaneScope()).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Create topic from header' }))

    await waitFor(() => expect(homeMocks.reuseOrCreateTopic).toHaveBeenCalledWith(null))
    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-created')
    expect(homeMocks.createTopic).toHaveBeenCalledWith({})
  })

  it('ignores a rapid double-click on the composer new-topic action', () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-default' }]
    homeMocks.topics = []
    // Never resolves: the first create stays in flight so the re-entry guard must drop the second click.
    homeMocks.createTopic.mockReturnValue(new Promise(() => {}))

    render(<HomePage />)

    const button = screen.getByRole('button', { name: 'Create empty topic from composer' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(homeMocks.createTopic).toHaveBeenCalledTimes(1)
  })

  it('toasts and leaves the active topic untouched when topic creation fails', async () => {
    homeMocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-default' }]
    homeMocks.topics = []
    homeMocks.createTopic.mockRejectedValue(new Error('create failed'))

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create empty topic from composer' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalled())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.queryByTestId('active-topic')?.textContent).not.toBe('topic-created')
  })

  it('opens the assistant library from the conversation list options', () => {
    render(<HomePage />)

    expect(screen.queryByTestId('resource-catalog-assistant')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Manage assistants' }))

    expect(screen.getByTestId('resource-catalog-assistant')).toBeInTheDocument()
    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()
    expect(screen.getByTestId('topic-right-pane-provider')).toHaveAttribute('data-present', 'false')
    // The pane keeps the note of which assistant owns the conversations it lists.
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-manage-assistants-active', 'true')
  })

  it('replaces the history center surface when opening assistant management', () => {
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Open history records' }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage assistants' }))

    expect(screen.queryByTestId('history-records-view')).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-catalog-assistant')).toBeInTheDocument()
    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()
  })

  it('keeps a sidebar toggle beside resource search so a collapsed pane can be reopened', async () => {
    homeMocks.preferenceValues.set('topic.tab.show', true)

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage assistants' }))

    const shell = screen.getByTestId('home-chat-shell')
    expect(within(shell).getByTestId('pane-open')).toHaveTextContent('true')

    const toolbarLeading = within(shell).getByTestId('resource-toolbar-leading')

    // Collapse the pane from the resource toolbar toggle, then confirm the toggle survives the collapse.
    fireEvent.click(within(toolbarLeading).getByRole('button'))
    await waitFor(() => expect(within(shell).getByTestId('pane-open')).toHaveTextContent('false'))

    fireEvent.click(within(toolbarLeading).getByRole('button'))
    await waitFor(() => expect(within(shell).getByTestId('pane-open')).toHaveTextContent('true'))
  })

  it('creates an empty topic from the inline assistant catalog go-to-chat action', async () => {
    homeMocks.assistants = [{ id: 'assistant-default' }, { id: 'assistant-2' }]
    homeMocks.createTopic.mockResolvedValue({ ...createdTopic, assistantId: 'assistant-2' })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage assistants' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to chat with assistant 2' }))

    await waitFor(() => expect(homeMocks.createTopic).toHaveBeenCalledWith({ assistantId: 'assistant-2' }))
    expect(screen.queryByTestId('resource-catalog-assistant')).not.toBeInTheDocument()
    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-created')
    expect(screen.getByTestId('active-topic-assistant')).toHaveTextContent('assistant-2')
  })

  it('renders history records in the chat center and toggles them from the topic pane', () => {
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Open history records' }))

    expect(screen.getByTestId('history-records-view')).toBeInTheDocument()
    expect(screen.getByTestId('home-chat-shell')).toBeInTheDocument()
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-history-records-active', 'true')
    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open history records' }))

    expect(screen.queryByTestId('history-records-view')).not.toBeInTheDocument()
    expect(screen.getByTestId('active-topic')).toBeInTheDocument()
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-history-records-active', 'false')
  })

  it('keeps the topic pane provider and viewport mounted across center surfaces', () => {
    render(<HomePage />)
    const provider = screen.getByTestId('topic-right-pane-provider')
    const viewport = screen.getByTestId('topic-right-pane-viewport')

    expect(provider).toHaveAttribute('data-present', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Manage assistants' }))

    expect(screen.getByTestId('resource-catalog-assistant')).toBeInTheDocument()
    expect(screen.getByTestId('home-chat-shell')).toBeInTheDocument()
    expect(screen.getByTestId('topic-right-pane-provider')).toBe(provider)
    expect(screen.getByTestId('topic-right-pane-viewport')).toBe(viewport)
    expect(provider).toHaveAttribute('data-present', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Select topic next' }))

    expect(screen.queryByTestId('resource-catalog-assistant')).not.toBeInTheDocument()
    expect(screen.getByTestId('topic-right-pane-provider')).toBe(provider)
    expect(screen.getByTestId('topic-right-pane-viewport')).toBe(viewport)
    expect(provider).toHaveAttribute('data-present', 'true')
  })

  it('keeps history open while replacing the active topic and its URL', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

    await user.click(screen.getByRole('button', { name: 'Open history records' }))
    await user.click(screen.getByRole('button', { name: 'Replace deleted topic' }))

    await waitFor(() =>
      expect(homeMocks.navigate).toHaveBeenCalledWith({
        to: '/app/chat',
        search: { topicId: historyTopic.id },
        replace: true
      })
    )
    expect(screen.getByTestId('home-chat-shell')).toHaveAttribute('data-active-topic-id', historyTopic.id)
    expect(screen.getByTestId('history-records-view')).toBeInTheDocument()
  })

  it('keeps history open after clearing the last topic and requesting route re-entry', async () => {
    const user = userEvent.setup()
    let finishNavigation!: () => void
    homeMocks.navigate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishNavigation = resolve
      })
    )
    render(<HomePage />)

    await user.click(screen.getByRole('button', { name: 'Open history records' }))
    await user.click(screen.getByRole('button', { name: 'Clear history selection' }))

    expect(homeMocks.navigate).toHaveBeenCalledWith({ to: '/app/chat', search: {}, replace: true })

    await act(async () => {
      finishNavigation()
    })

    expect(screen.getByTestId('home-chat-shell')).toHaveAttribute('data-active-topic-id', '')
    expect(screen.getByTestId('history-records-view')).toBeInTheDocument()
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
  })

  it('closes history and activates the selected topic in the same-tab fallback', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

    await user.click(screen.getByRole('button', { name: 'Open history records' }))
    await user.click(screen.getByRole('button', { name: 'Open history topic' }))

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent(historyTopic.id))
    expect(homeMocks.navigate).toHaveBeenCalledWith({
      to: '/app/chat',
      search: { topicId: historyTopic.id },
      replace: true
    })
    expect(screen.queryByTestId('history-records-view')).not.toBeInTheDocument()
  })

  it('forwards a reveal request to the topic pane when a global-search topic is selected', async () => {
    render(<HomePage />)

    expect(JSON.parse(screen.getByTestId('topic-pane').getAttribute('data-reveal-request') ?? 'null')).toBeNull()

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC)?.({ topic: historyTopic, targetTabId: 'chat-tab' })
    })

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent(historyTopic.id))
    expect(screen.getByTestId('topic-pane')).toHaveAttribute('data-active-topic-id', historyTopic.id)
    const request = JSON.parse(screen.getByTestId('topic-pane').getAttribute('data-reveal-request') ?? 'null')
    expect(request).toMatchObject({ clearFilters: true, clearQuery: true, itemId: historyTopic.id })
    expect(request.requestId).toBeGreaterThan(0)
    expect(
      JSON.parse(screen.getByTestId('topic-right-pane-provider').getAttribute('data-reveal-request') ?? 'null')
    ).toMatchObject({ itemId: historyTopic.id })
  })

  it('ignores a global-search topic selection aimed at another tab', async () => {
    render(<HomePage />)

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC)?.({ topic: historyTopic, targetTabId: 'other-chat-tab' })
    })

    expect(screen.getByTestId('active-topic')).toHaveTextContent(initialTopic.id)
    expect(JSON.parse(screen.getByTestId('topic-pane').getAttribute('data-reveal-request') ?? 'null')).toBeNull()
  })

  it('keeps a pending locate message when selecting a global-search topic message', async () => {
    render(<HomePage />)

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE)?.({
        topic: historyTopic,
        messageId: 'message-target',
        targetTabId: 'chat-tab'
      })
    })

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-history'))
    expect(screen.getByTestId('locate-message-id')).toHaveTextContent('message-target')

    fireEvent.click(screen.getByRole('button', { name: 'Locate handled' }))
    expect(screen.getByTestId('locate-message-id')).toHaveTextContent('')
  })

  it('cancels a pending message locate when the user selects another topic', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE)?.({
        topic: historyTopic,
        messageId: 'message-target',
        targetTabId: 'chat-tab'
      })
    })
    await waitFor(() => expect(screen.getByTestId('locate-message-id')).toHaveTextContent('message-target'))

    await user.click(screen.getByRole('button', { name: 'Select topic next' }))

    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-next')
    expect(screen.getByTestId('locate-message-id')).toHaveTextContent('')
  })

  it('drops a pending message locate when the route swaps the topic underneath', async () => {
    const { rerender } = render(<HomePage />)

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE)?.({
        topic: historyTopic,
        messageId: 'message-target',
        targetTabId: 'chat-tab'
      })
    })
    await waitFor(() => expect(screen.getByTestId('locate-message-id')).toHaveTextContent('message-target'))

    homeMocks.routeSearch = { topicId: 'topic-b' }
    homeMocks.activeTopicOverride = { ...historyTopic, id: 'topic-b', name: 'Topic B' }
    rerender(<HomePage />)

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-b'))
    expect(screen.getByTestId('locate-message-id')).toHaveTextContent('')
  })

  it('ignores a global-search topic message targeted at another tab', async () => {
    render(<HomePage />)

    act(() => {
      eventHandler(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE)?.({
        topic: historyTopic,
        messageId: 'message-target',
        targetTabId: 'other-chat-tab'
      })
    })

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-initial'))
    expect(screen.getByTestId('locate-message-id')).toHaveTextContent('')
  })

  it('keeps the current topic visible while the active topic is reloading', async () => {
    homeMocks.routeSearch = { topicId: 'topic-initial' }
    const { rerender } = render(<HomePage />)

    await waitFor(() => expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-initial'))

    homeMocks.activeTopicLoading = true
    homeMocks.forceActiveTopicUndefined = true
    rerender(<HomePage />)

    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-initial')
  })

  it('keeps the topic pane mounted while the entry topic is still loading', () => {
    homeMocks.entryTopic = undefined
    homeMocks.activeTopicLoading = true
    homeMocks.forceActiveTopicUndefined = true

    const { rerender } = render(<HomePage />)

    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
    const provider = screen.getByTestId('topic-right-pane-provider')
    const viewport = screen.getByTestId('topic-right-pane-viewport')

    homeMocks.activeTopicLoading = false
    homeMocks.forceActiveTopicUndefined = false
    homeMocks.activeTopicOverride = initialTopic
    rerender(<HomePage />)

    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-initial')
    expect(screen.getByTestId('topic-right-pane-provider')).toBe(provider)
    expect(screen.getByTestId('topic-right-pane-viewport')).toBe(viewport)
    expect(homeMocks.createTopic).not.toHaveBeenCalled()
  })

  it('passes URL topicId to useActiveTopic as activeTopicId', async () => {
    homeMocks.entryTopic = undefined
    homeMocks.routeSearch = { topicId: 'topic-from-url' }
    homeMocks.activeTopicLoading = true

    await act(async () => {
      render(<HomePage />)
    })

    expect(homeMocks.activeTopicOptions?.activeTopicId).toBe('topic-from-url')
  })

  it('does not expose the previous topic while the new route topic is loading', async () => {
    homeMocks.entryTopic = undefined
    homeMocks.routeSearch = { topicId: 'topic-a' }
    homeMocks.activeTopicOverride = { ...historyTopic, id: 'topic-a', name: 'Topic A' }

    const { rerender } = render(<HomePage />)

    expect(screen.getByTestId('active-topic')).toHaveTextContent('topic-a')

    homeMocks.routeSearch = { topicId: 'topic-b' }
    homeMocks.activeTopicLoading = true
    homeMocks.forceActiveTopicUndefined = true
    rerender(<HomePage />)

    await waitFor(() => expect(homeMocks.activeTopicOptions?.activeTopicId).toBe('topic-b'))
    expect(screen.queryByTestId('active-topic')).not.toBeInTheDocument()
    expect(vi.mocked(useTabSelfVisuals)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routePrefix: '/app/chat',
        preserveVisuals: true
      })
    )
  })

  it('writes same-tab topic changes to the URL', async () => {
    homeMocks.entryTopic = undefined
    homeMocks.routeSearch = {}

    await act(async () => {
      render(<HomePage />)
    })

    const setActiveTopicId = homeMocks.activeTopicOptions?.setActiveTopicId
    expect(typeof setActiveTopicId).toBe('function')

    await act(async () => {
      setActiveTopicId?.('topic-next')
    })

    await waitFor(() => expect(homeMocks.activeTopicOptions?.activeTopicId).toBe('topic-next'))
    expect(homeMocks.navigate).toHaveBeenCalledWith({
      to: '/app/chat',
      search: { topicId: 'topic-next' },
      replace: true
    })
  })

  it('clears the local active topic without mutating URL search', async () => {
    homeMocks.entryTopic = undefined
    homeMocks.routeSearch = { topicId: 'topic-x' }

    await act(async () => {
      render(<HomePage />)
    })

    await act(async () => {
      homeMocks.activeTopicOptions?.setActiveTopicId?.(null)
    })

    await waitFor(() => expect(homeMocks.activeTopicOptions?.activeTopicId).toBeNull())
    expect(homeMocks.navigate).not.toHaveBeenCalled()
  })
})
