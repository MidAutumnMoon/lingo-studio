import { getRouteApi, useNavigate } from '@tanstack/react-router'
import type { FC, HTMLAttributes } from 'react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import type { ResourceListRevealRequest } from '@renderer/components/chat/resourceList/base'
import { ConversationSidebarToggleButton } from '@renderer/components/chat/shell/ConversationSidebarToggleButton'
import {
  createRecentTopicEntryFromTopic,
  recordGlobalSearchRecentEntry
} from '@renderer/components/GlobalSearch/globalSearchGroups'
import {
  type GlobalSearchTopicMessageSelectionPayload,
  type GlobalSearchTopicSelectionPayload,
  isGlobalSearchSelectionForTab
} from '@renderer/components/GlobalSearch/globalSearchSelectionEvents'
import HistoryRecordsView from '@renderer/components/history/HistoryRecordsView'
import { ConversationResourceView } from '@renderer/components/resourceCatalog/conversation'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { useCommandHandler } from '@renderer/hooks/command'
import { useAssistantTopicsSource } from '@renderer/hooks/resourceViewSources'
import { useCurrentTabId } from '@renderer/hooks/tab'
import { useAssistantsApi } from '@renderer/hooks/useAssistant'
import { useComposerFocusRequest } from '@renderer/hooks/useComposerFocusRequest'
import { useConversationCenterSurface } from '@renderer/hooks/useConversationCenterSurface'
import { useConversationLocateRequest } from '@renderer/hooks/useConversationLocateRequest'
import { useConversationShellPaneState } from '@renderer/hooks/useConversationShellPaneState'
import { useModelById } from '@renderer/hooks/useModel'
import { mapApiTopicToRendererTopic, useActiveTopic, useTopicMutations } from '@renderer/hooks/useTopic'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { toast } from '@renderer/services/toast'
import type { AppRouter } from '@renderer/types/router'
import type { Topic } from '@renderer/types/topic'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { getDefaultRouteTitle } from '@renderer/utils/routeTitle'
import { cn } from '@renderer/utils/style'
import { isDataApiNotFoundError } from '@shared/data/api/errors'

import Chat from './Chat'
import { HomeTabRuntime } from './components/HomeTabRuntime'
import { TopicRightPane } from './components/TopicRightPane'
import { Topics } from './Tabs/components/Topics'
import type { AddNewTopicPayload } from './types'

const logger = loggerService.withContext('HomePage')
const chatRouteApi = getRouteApi('/app/chat')
const LAST_USED_ASSISTANT_CACHE_KEY = 'ui.chat.last_used_assistant_id'
type AssistantConversationResourceKind = 'assistant'
const ASSISTANT_CONVERSATION_RESOURCE_KINDS = [
  'assistant'
] as const satisfies readonly AssistantConversationResourceKind[]

type NewTopicAssistantSelectionSource = 'explicit' | 'route' | 'last-used' | 'first-assistant' | 'runtime-fallback'
type ResolvedNewTopicAssistantSelection = { assistantId?: string; source: NewTopicAssistantSelectionSource }

type NewTopicAssistantTargetOptions = {
  excludedAssistantIds?: readonly string[]
}

const HomePage: FC = () => {
  const { t } = useTranslation()
  const [topicRevealRequest, setTopicRevealRequest] = useState<ResourceListRevealRequest>()
  // Guards the topic-create paths against re-entry: a rapid double-click would otherwise read the
  // same pre-refresh topic list twice and stack duplicate blank topics.
  const isCreatingTopicRef = useRef(false)
  const ownerFallbackRequestIdRef = useRef(0)
  const [lastUsedAssistantId, setLastUsedAssistantId] = usePersistCache(LAST_USED_ASSISTANT_CACHE_KEY)
  const lastRecordedRecentTopicRef = useRef<string | undefined>(undefined)
  const [showSidebar, setShowSidebar] = usePreference('topic.tab.show')

  const routeSearch = chatRouteApi.useSearch<AppRouter>()
  const navigate = useNavigate()
  const routeTopicId = routeSearch.topicId
  const routeAssistantId = routeSearch.assistantId
  const {
    isWindowFrame,
    shellPaneOpen,
    paneManualToggle,
    setShellPaneOpen,
    setShellPaneOpenManually,
    toggleShellPane,
    handlePaneAutoCollapseChange
  } = useConversationShellPaneState({
    persistedPaneOpen: showSidebar,
    setPersistedPaneOpen: setShowSidebar
  })
  // Shared full-topics list source plus exact latest/reusable lookups.
  const assistantTopicsSource = useAssistantTopicsSource()
  const { reuseOrCreateTopic } = assistantTopicsSource

  const { createTopic, refreshTopics } = useTopicMutations()
  const {
    assistants,
    hasLoaded: hasAssistantsLoaded,
    isLoading: isAssistantsLoading,
    isRefreshing: isAssistantsRefreshing
  } = useAssistantsApi()
  const assistantIdSet = useMemo(() => new Set(assistants.map((assistant) => assistant.id)), [assistants])
  const validLastUsedAssistantId =
    lastUsedAssistantId && assistantIdSet.has(lastUsedAssistantId) ? lastUsedAssistantId : undefined
  const isAssistantListResolved = hasAssistantsLoaded && !isAssistantsLoading && !isAssistantsRefreshing
  const resolveNewTopicAssistantTarget = useCallback(
    (
      explicitAssistantId?: string | null,
      options: NewTopicAssistantTargetOptions = {}
    ): ResolvedNewTopicAssistantSelection => {
      const excludedAssistantIds = new Set(options.excludedAssistantIds ?? [])
      const isAvailableAssistantId = (assistantId: string | null | undefined): assistantId is string =>
        !!assistantId && assistantIdSet.has(assistantId) && !excludedAssistantIds.has(assistantId)

      if (explicitAssistantId === null) {
        return { source: 'explicit' }
      }
      if (isAvailableAssistantId(explicitAssistantId)) {
        return { assistantId: explicitAssistantId, source: 'explicit' }
      }
      // A sidebar `?assistantId=` entry whose assistant has no topics yet creates for that exact
      // assistant, not whatever was last focused (mirrors AgentPage's `preferredAgentId`).
      if (isAvailableAssistantId(routeAssistantId)) {
        return { assistantId: routeAssistantId, source: 'route' }
      }
      if (isAvailableAssistantId(validLastUsedAssistantId)) {
        return { assistantId: validLastUsedAssistantId, source: 'last-used' }
      }
      const fallbackAssistantId = assistants.find((assistant) => !excludedAssistantIds.has(assistant.id))?.id
      if (fallbackAssistantId) {
        return { assistantId: fallbackAssistantId, source: 'first-assistant' }
      }
      return { source: 'runtime-fallback' }
    },
    [assistantIdSet, assistants, routeAssistantId, validLastUsedAssistantId]
  )

  const routeActiveTopicId = routeTopicId ?? null
  const [activeTopicId, setActiveTopicIdState] = useState<string | null>(() => routeActiveTopicId)
  // Page-initiated selection writes the tab URL — the conversation's sole identity channel —
  // and mirrors into state immediately so the UI doesn't wait a router round trip. Route-driven
  // changes (entry interceptor, recovery) flow back through the sync effect below. Clearing
  // (`null`) never navigates: the next selection or the recovery path owns the URL then.
  const setActiveTopicId = useCallback(
    (id: string | null) => {
      ownerFallbackRequestIdRef.current += 1
      setActiveTopicIdState(id)
      if (id) {
        void navigate({ to: '/app/chat', search: { topicId: id }, replace: true })
      }
    },
    [navigate]
  )

  useLayoutEffect(() => {
    ownerFallbackRequestIdRef.current += 1
    setActiveTopicIdState(routeActiveTopicId)
    return () => {
      ownerFallbackRequestIdRef.current += 1
    }
  }, [routeActiveTopicId])

  const {
    activeTopic,
    setActiveTopic,
    clearActiveTopic,
    isLoading: isActiveTopicLoading,
    error: activeTopicError,
    topicSource: activeTopicSource
  } = useActiveTopic({
    activeTopicId,
    setActiveTopicId
  })
  const reenterChatRoute = useCallback(() => {
    clearActiveTopic()
    void navigate({ to: '/app/chat', search: {}, replace: true })
  }, [clearActiveTopic, navigate])
  // The URL-bound topic no longer exists: its by-id query settled with NOT_FOUND (deleted while
  // this tab was dormant, or a rotted deep link). Recovery is a plain replace-navigation back
  // through the entry interceptor, which resolves the next target — no in-page state surgery.
  useEffect(() => {
    if (!routeTopicId || activeTopicId !== routeTopicId) return
    if (activeTopic || isActiveTopicLoading) return
    if (!isDataApiNotFoundError(activeTopicError)) return
    reenterChatRoute()
  }, [activeTopic, activeTopicError, activeTopicId, isActiveTopicLoading, reenterChatRoute, routeTopicId])
  const lastVisibleTopicRef = useRef<Topic | undefined>(undefined)
  const visibleTopic =
    activeTopic ??
    (isActiveTopicLoading && lastVisibleTopicRef.current?.id === activeTopicId
      ? lastVisibleTopicRef.current
      : undefined)
  const requestComposerFocus = useComposerFocusRequest(visibleTopic?.id)
  const resourceConversationKey = useMemo(() => {
    if (visibleTopic?.id) return `topic:${visibleTopic.id}`
    return 'empty'
  }, [visibleTopic?.id])
  const conversationResourcesEnabled = !isWindowFrame
  const {
    activeResourceKind,
    closeSurface,
    historyActive: historyRecordsActive,
    openResource,
    toggleHistory: toggleHistoryRecords
  } = useConversationCenterSurface<AssistantConversationResourceKind>({
    conversationKey: resourceConversationKey,
    disabled: !conversationResourcesEnabled,
    resourceKinds: ASSISTANT_CONVERSATION_RESOURCE_KINDS
  })
  const manageAssistantsActive = activeResourceKind === 'assistant'
  const openAssistantsLibrary = useCallback(() => {
    openResource('assistant')
  }, [openResource])

  useEffect(() => {
    if (!isAssistantListResolved || !lastUsedAssistantId || assistantIdSet.has(lastUsedAssistantId)) return
    setLastUsedAssistantId(null)
  }, [assistantIdSet, isAssistantListResolved, lastUsedAssistantId, setLastUsedAssistantId])

  useEffect(() => {
    const assistantId = activeTopic?.assistantId
    if (assistantId) {
      setLastUsedAssistantId(assistantId)
    }
  }, [activeTopic, setLastUsedAssistantId])

  // All non-dormant tabs mount at once (Activity keep-alive), so each chat tab runs its
  // own HomePage. `currentTabId` is *this* tab's id.
  const currentTabId = useCurrentTabId()

  // The sidebar owns the assistant list, so opening the library from there arrives as an event
  // targeted at the tab that asked for it.
  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.OPEN_ASSISTANTS_LIBRARY, (payload) => {
      const { tabId } = payload as { tabId?: string }
      if (tabId && tabId !== currentTabId) return
      openAssistantsLibrary()
    })

    return unsubscribe
  }, [currentTabId, openAssistantsLibrary])

  // Label this tab with its assistant emoji + topic name so multiple chat tabs
  // are distinguishable in the tab bar (every tab labels itself — not gated on active).
  const visibleAssistantId = visibleTopic?.assistantId
  const visibleAssistant = assistants.find((assistant) => assistant.id === visibleAssistantId)
  // Start the managed model query before assistant details resolve; Chat shares the same SWR request.
  useModelById(visibleAssistant?.modelId)
  /**
   * Whose conversations the list shows. An open conversation decides it on its own: its assistant if
   * that assistant still exists, otherwise the unlinked set — so archiving an assistant never hides
   * the conversation that is still on screen. With nothing open, the route, the last assistant used,
   * and the first assistant decide in that order.
   */
  const activeAssistantId = useMemo(() => {
    if (visibleTopic) {
      return visibleAssistantId && assistantIdSet.has(visibleAssistantId) ? visibleAssistantId : null
    }
    const candidates = [routeAssistantId, validLastUsedAssistantId, assistants[0]?.id]
    return candidates.find((candidate): candidate is string => !!candidate && assistantIdSet.has(candidate)) ?? null
  }, [assistantIdSet, assistants, routeAssistantId, validLastUsedAssistantId, visibleAssistantId, visibleTopic])
  // While the bound topic is still loading, keep the tab's stored title/icon instead of stamping
  // a generic one.
  const targetTopicId = activeTopicId ?? undefined
  const { locateMessageId, requestLocate, clearLocate } = useConversationLocateRequest({
    activeConversationId: targetTopicId,
    visibleConversationId: visibleTopic?.id
  })
  const preserveTabVisuals = !!targetTopicId && visibleTopic?.id !== targetTopicId
  const tabTitle = visibleTopic?.name?.trim() || visibleAssistant?.name?.trim() || getDefaultRouteTitle('/app/chat')

  useEffect(() => {
    if (activeTopic) lastVisibleTopicRef.current = activeTopic
  }, [activeTopic])

  useEffect(() => {
    if (!activeTopic) return
    const signature = `${activeTopic.id}:${activeTopic.name}`
    if (lastRecordedRecentTopicRef.current === signature) return

    lastRecordedRecentTopicRef.current = signature
    recordGlobalSearchRecentEntry(createRecentTopicEntryFromTopic(activeTopic))
  }, [activeTopic])

  useCommandHandler('app.sidebar.toggle', toggleShellPane)

  const setActiveTopicAndCloseResourceView = useCallback(
    (topic: Topic) => {
      closeSurface()
      clearLocate()
      setActiveTopic(topic)
      return true
    },
    [clearLocate, closeSurface, setActiveTopic]
  )
  const clearActiveTopicAndCloseResourceView = useCallback(() => {
    closeSurface()
    reenterChatRoute()
  }, [closeSurface, reenterChatRoute])

  const activateCreatedTopic = useCallback(
    (topic: Topic) => {
      setActiveTopicAndCloseResourceView(topic)
      requestComposerFocus(topic.id)
    },
    [requestComposerFocus, setActiveTopicAndCloseResourceView]
  )

  const resolveEmptyTopic = useCallback(
    async (payload?: AddNewTopicPayload, options?: NewTopicAssistantTargetOptions): Promise<Topic> => {
      const selection = resolveNewTopicAssistantTarget(payload?.assistantId, options)
      const reuseTargetAssistantId = selection.assistantId ?? (payload?.assistantId === null ? null : undefined)
      const result =
        reuseTargetAssistantId === undefined
          ? {
              topic: await createTopic({
                ...(selection.assistantId ? { assistantId: selection.assistantId } : {})
              }),
              created: true
            }
          : await reuseOrCreateTopic(reuseTargetAssistantId)

      if (result.created) {
        void refreshTopics().catch((err) => {
          logger.warn('Failed to refresh topics after composer topic create', err as Error)
        })
      }
      return mapApiTopicToRendererTopic(result.topic)
    },
    [createTopic, refreshTopics, resolveNewTopicAssistantTarget, reuseOrCreateTopic]
  )

  const createAndActivateEmptyTopic = useCallback(
    async (payload?: AddNewTopicPayload, options?: NewTopicAssistantTargetOptions): Promise<Topic | null> => {
      if (isCreatingTopicRef.current) return null
      isCreatingTopicRef.current = true
      try {
        const topic = await resolveEmptyTopic(payload, options)
        activateCreatedTopic(topic)
        return topic
      } catch (err) {
        logger.error('Failed to create empty topic', err as Error)
        toast.error(formatErrorMessageWithPrefix(err, t('common.error')))
        return null
      } finally {
        isCreatingTopicRef.current = false
      }
    },
    [activateCreatedTopic, resolveEmptyTopic, t]
  )

  const handleCreateEmptyTopic = useCallback(
    async (payload?: AddNewTopicPayload) => {
      await createAndActivateEmptyTopic(payload)
    },
    [createAndActivateEmptyTopic]
  )

  // A bare entry with no resolvable topic stays empty until the user explicitly starts a conversation.

  // "去对话" from the assistant library (after adding a preset): create/open a real empty topic
  // with that assistant selected.
  const handleOpenAssistantChatFromLibrary = useCallback(
    (assistantId: string) => {
      void createAndActivateEmptyTopic({ assistantId })
    },
    [createAndActivateEmptyTopic]
  )

  const handleHistoryTopicSelect = useCallback(
    (topic: Topic, messageId?: string) => {
      closeSurface()
      if (!setActiveTopicAndCloseResourceView(topic)) return
      setShellPaneOpen(true)
      if (messageId) requestLocate(topic.id, messageId)
      setTopicRevealRequest((current) => ({
        clearFilters: true,
        clearQuery: true,
        itemId: topic.id,
        requestId: (current?.requestId ?? 0) + 1
      }))
    },
    [closeSurface, requestLocate, setActiveTopicAndCloseResourceView, setShellPaneOpen]
  )
  const closeHistoryRecords = useCallback(() => {
    closeSurface()
  }, [closeSurface])
  const openHistoryRecords = useCallback(() => {
    toggleHistoryRecords()
  }, [toggleHistoryRecords])
  const handleHistoryRecordsTopicSelect = useCallback(
    (topic: Topic) => {
      closeHistoryRecords()
      handleHistoryTopicSelect(topic)
    },
    [closeHistoryRecords, handleHistoryTopicSelect]
  )
  const handleHistoryActiveTopicChange = useCallback(
    (topic: Topic | null) => {
      clearLocate()
      if (topic) setActiveTopic(topic)
      else reenterChatRoute()
    },
    [clearLocate, reenterChatRoute, setActiveTopic]
  )
  const handleGlobalSearchTopicSelect = useEffectEvent((topic: Topic, messageId?: string) => {
    handleHistoryTopicSelect(topic, messageId)
  })

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC, (payload) => {
      const selection = payload as GlobalSearchTopicSelectionPayload
      if (!selection.topic || !isGlobalSearchSelectionForTab(selection, currentTabId)) return

      handleGlobalSearchTopicSelect(selection.topic)
    })
    const unsubscribeMessage = EventEmitter.on(EVENT_NAMES.GLOBAL_SEARCH_SELECT_TOPIC_MESSAGE, (payload) => {
      const selection = payload as GlobalSearchTopicMessageSelectionPayload
      if (!selection.topic || !selection.messageId || !isGlobalSearchSelectionForTab(selection, currentTabId)) return

      handleGlobalSearchTopicSelect(selection.topic, selection.messageId)
    })

    return () => {
      unsubscribe()
      unsubscribeMessage()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `useEffectEvent` reads latest tab/topic state without resubscribing.
  }, [currentTabId])

  const handleLocateMessageHandled = clearLocate
  const resourceCenter = useMemo(
    () =>
      activeResourceKind
        ? {
            className: 'relative',
            content: (
              <ConversationResourceView
                kind={activeResourceKind}
                onOpenAssistantChat={handleOpenAssistantChatFromLibrary}
                toolbarLeading={
                  !isWindowFrame ? (
                    <ConversationSidebarToggleButton
                      sidebarOpen={shellPaneOpen}
                      onSidebarToggle={toggleShellPane}
                      tooltipPlacement="bottom"
                    />
                  ) : undefined
                }
              />
            )
          }
        : null,
    [activeResourceKind, shellPaneOpen, handleOpenAssistantChatFromLibrary, isWindowFrame, toggleShellPane]
  )
  const historyRecordsCenter = historyRecordsActive
    ? {
        className: 'relative',
        content: (
          <HistoryRecordsView
            mode="assistant"
            open={historyRecordsActive && !isWindowFrame}
            activeRecordId={activeTopicId}
            onClose={closeHistoryRecords}
            onRecordSelect={handleHistoryRecordsTopicSelect}
            onActiveRecordChange={handleHistoryActiveTopicChange}
            toolbarLeading={
              !isWindowFrame ? (
                <ConversationSidebarToggleButton
                  sidebarOpen={shellPaneOpen}
                  onSidebarToggle={toggleShellPane}
                  tooltipPlacement="bottom"
                />
              ) : undefined
            }
          />
        )
      }
    : null
  // The navigation pane is the active assistant's conversation history.
  const pane = (
    <Topics
      activeTopic={visibleTopic}
      activeAssistantId={activeAssistantId}
      dataEnabled={shellPaneOpen}
      assistantTopicsSource={assistantTopicsSource}
      clearActiveTopic={clearActiveTopicAndCloseResourceView}
      setActiveTopic={setActiveTopicAndCloseResourceView}
      onNewTopic={handleCreateEmptyTopic}
      historyRecordsActive={historyRecordsActive}
      onOpenHistoryRecords={isWindowFrame ? undefined : openHistoryRecords}
      revealRequest={topicRevealRequest}
      manageAssistantsActive={manageAssistantsActive}
    />
  )

  const centerSurface = historyRecordsCenter ?? resourceCenter

  // The provider, conversation shell, and viewport stay at one React ownership path while the center
  // switches between loading, chat, history, and resource surfaces. Capability identity alone now
  // decides whether a visited right-panel subtree survives.
  return (
    <TopicRightPane.Scope
      topicId={visibleTopic?.id}
      topicName={visibleTopic?.name}
      traceId={visibleTopic?.traceId}
      present={!centerSurface}
      revealRequest={topicRevealRequest}>
      <HomeTabRuntime
        title={tabTitle}
        emoji={visibleAssistant?.emoji}
        preserveVisuals={preserveTabVisuals}
        activeTopicId={activeTopic?.id}
        activeTopicSource={activeTopicSource}
      />
      <Container id="home-page">
        <ContentContainer $detached={isWindowFrame}>
          <Chat
            activeTopic={visibleTopic}
            topicPending={isActiveTopicLoading}
            centerSurface={centerSurface}
            pane={pane}
            paneOpen={shellPaneOpen}
            panePosition="left"
            onPaneCollapse={() => setShellPaneOpenManually(false)}
            onPaneAutoCollapseChange={handlePaneAutoCollapseChange}
            paneManualToggle={paneManualToggle}
            onNewTopic={handleCreateEmptyTopic}
            onCreateEmptyTopic={handleCreateEmptyTopic}
            showResourceListControls
            sidebarOpen={shellPaneOpen}
            onSidebarToggle={toggleShellPane}
            locateMessageId={locateMessageId}
            onLocateMessageHandled={handleLocateMessageHandled}
          />
        </ContentContainer>
      </Container>
    </TopicRightPane.Scope>
  )
}

function Container({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('relative flex max-w-[100vw] flex-1 flex-col overflow-hidden', className)} {...props} />
}

function ContentContainer({
  $detached,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { $detached?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 overflow-hidden',
        $detached ? 'max-w-[100vw]' : 'max-w-[calc(100vw_-_12px)]',
        className
      )}
      {...props}
    />
  )
}

export default HomePage
