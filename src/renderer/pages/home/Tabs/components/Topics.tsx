import dayjs from 'dayjs'
import { Archive, FilePenLine, PinIcon } from 'lucide-react'
import type { RefObject } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip } from '@cherrystudio/ui'
import { dataApiService } from '@data/DataApiService'
import { useCache, usePersistCache, useSharedCacheSelector } from '@data/hooks/useCache'
import { useMultiplePreferences, usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import { ResourceListActionContextMenu } from '@renderer/components/chat/actions/ResourceListActionContextMenu'
import type {
  TopicExportMenuOptions,
  TopicMoveAssistantTarget
} from '@renderer/components/chat/actions/topicContextMenuActions'
import { useOptionalRightPanelActions, useOptionalRightPanelState } from '@renderer/components/chat/panes/Shell'
import {
  CONVERSATION_ROW_STATUS_TITLE_CLASS,
  ConversationRowStatus,
  type ConversationRowStatusValue,
  renderAssistantEntityIcon,
  resolveDefaultCollapsedGroupIds,
  ResourceList,
  type ResourceListGroupHeaderKind,
  type ResourceListRevealRequest,
  RESOURCE_LIST_ROW_LAYOUTS,
  TopicListOptionsMenu,
  useResourceListActions,
  useResourceListPinnedState,
  useResourceListRowState
} from '@renderer/components/chat/resourceList/base'
import { ResourceRefreshErrorBanner } from '@renderer/components/chat/resourceList/ResourceRefreshErrorBanner'
import { TopicResourceList } from '@renderer/components/chat/resourceList/TopicResourceList'
import {
  readChatDraftPresence,
  subscribeChatDraftCache
} from '@renderer/components/composer/variants/chat/chatDraftCache'
import EditNameDialog from '@renderer/components/EditNameDialog'
import NewConversationIcon from '@renderer/components/icons/NewConversationIcon'
import { useClearTopicMessages } from '@renderer/hooks/chat/useClearTopicMessages'
import { useTopicMenuActions } from '@renderer/hooks/chat/useTopicMenuActions'
import type { AssistantTopicsSource } from '@renderer/hooks/resourceViewSources'
import { useOptionalTabsContext } from '@renderer/hooks/tab'
import { useAssistantsApi } from '@renderer/hooks/useAssistant'
import { useConversationNavigation } from '@renderer/hooks/useConversationNavigation'
import { useImageCaptureTargets } from '@renderer/hooks/useImageCaptureTargets'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { useOptimisticResourceName } from '@renderer/hooks/useOptimisticResourceName'
import { usePins } from '@renderer/hooks/usePins'
import { useSidebarShortcuts } from '@renderer/hooks/useSidebarShortcuts'
import {
  cancelTopicRenaming,
  finishTopicRenaming,
  getTopicMessages,
  startTopicRenaming,
  useTopicMutations
} from '@renderer/hooks/useTopic'
import { useTopicStreamStatus } from '@renderer/hooks/useTopicStreamStatus'
import { useWindowFrame } from '@renderer/hooks/useWindowFrame'
import { restoreRecycleBinItem, showRecycleBinUndo } from '@renderer/services/recycleBinFeedback'
import { toast } from '@renderer/services/toast'
import type { Topic } from '@renderer/types/topic'
import { fetchMessagesSummary } from '@renderer/utils/aiGeneration'
import { withSoleGroupLabelHidden } from '@renderer/utils/chat/resourceListBase'
import {
  createTopicTimeGroupResolver,
  sortTopicsForDisplayGroups,
  TOPIC_PINNED_GROUP_ID
} from '@renderer/utils/chat/topicsHelpers'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { findLatestActive, pickNeighbourAfterRemoval } from '@renderer/utils/resourceEntity'
import { createSidebarShortcutTarget, SIDEBAR_SHORTCUT_PROVIDER_IDS } from '@renderer/utils/sidebar'
import { cn } from '@renderer/utils/style'
import { formatListTimestamp } from '@renderer/utils/time'
import { classifyTurn, type TopicStatusSnapshotEntry } from '@shared/ai/transport'
import { isTrashTargetNotFoundError, isTrashTopicBusyError } from '@shared/ipc/errors/trash'

import {
  rejectPendingTopicImageActions,
  requestTopicImageAction,
  type TopicImageActionRequest,
  type TopicImageActionType
} from '../../messages/topicImageActionBus'
import TopicImageCaptureHost from '../../messages/TopicImageCaptureHost'
import type { AddNewTopicPayload } from '../../types'
import { EMPTY_TOPIC_LIST_ITEM_RECONCILIATION, reconcileTopicListItems } from './topicListItemSharing'

const logger = loggerService.withContext('Topics')
// Let the context menu close before mounting the heavier offscreen message list.
const IMAGE_CAPTURE_START_DELAY_MS = 160

const LEFT_PANEL_TIME_TOPIC_GROUP_VISIBLE_COUNT = 50
const TOPIC_EXPORT_MENU_PREFERENCE_KEYS = {
  docx: 'data.export.menus.docx',
  image: 'data.export.menus.image',
  joplin: 'data.export.menus.joplin',
  markdown: 'data.export.menus.markdown',
  markdown_reason: 'data.export.menus.markdown_reason',
  notion: 'data.export.menus.notion',
  obsidian: 'data.export.menus.obsidian',
  plain_text: 'data.export.menus.plain_text',
  siyuan: 'data.export.menus.siyuan',
  yuque: 'data.export.menus.yuque'
} as const

// Time buckets and "pinned" only gather rows — they never name a manageable entity, and they stay
// on the shared row rhythm instead of the entity headers' voice.
const getBucketGroupHeaderKind = (): ResourceListGroupHeaderKind => 'bucket'

interface Props {
  activeTopic?: Topic
  /**
   * Whose conversations this list shows. `null` reads the conversations that lost their assistant,
   * and `undefined` shows nothing — the list is only ever one assistant's history.
   */
  activeAssistantId?: string | null
  assistantTopicsSource: AssistantTopicsSource
  dataEnabled?: boolean
  historyRecordsActive?: boolean
  manageAssistantsActive?: boolean
  clearActiveTopic: () => void
  onNewTopic?: (payload?: AddNewTopicPayload) => void | Promise<void>
  onOpenHistoryRecords?: () => void
  revealRequest?: ResourceListRevealRequest
  setActiveTopic: (topic: Topic) => void
}

/**
 * Unlinked means "no live assistant", not "no assistant id": archiving an assistant keeps its
 * conversations, and they carry the FK of the archived row until it is restored. Those
 * conversations stay reachable here instead of belonging to no list at all.
 */
function matchesAssistantScope(topic: Topic, assistantId: string | null | undefined, liveAssistantIds: Set<string>) {
  if (assistantId === undefined) return false
  if (assistantId === null) return !topic.assistantId || !liveAssistantIds.has(topic.assistantId)
  return topic.assistantId === assistantId
}

export function Topics({
  activeTopic,
  activeAssistantId,
  assistantTopicsSource,
  dataEnabled = true,
  historyRecordsActive,
  manageAssistantsActive = false,
  clearActiveTopic,
  onNewTopic,
  onOpenHistoryRecords,
  revealRequest,
  setActiveTopic
}: Props) {
  const { t } = useTranslation()
  const clearTopicMessages = useClearTopicMessages()
  const tabs = useOptionalTabsContext()
  const conversationNav = useConversationNavigation('assistants')
  const isWindowFrame = useWindowFrame().mode === 'window'
  const [groupNow, setGroupNow] = useState(() => dayjs())

  useEffect(() => {
    const updateGroupNow = () => setGroupNow(dayjs())
    const intervalId = window.setInterval(updateGroupNow, 60_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') updateGroupNow()
    }
    window.addEventListener('focus', updateGroupNow)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', updateGroupNow)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const { notesPath } = useNotesSettings()
  const { updateTopic: patchTopic, deleteTopic: deleteTopicById, refreshTopics, restoreTopic } = useTopicMutations()
  const [assistantIconType] = usePreference('assistant.icon_type')
  const [defaultModelId] = usePreference('chat.default_model_id')
  const [topicExpansionTime, setTopicExpansionTime] = usePersistCache('ui.topic.expansion.time')
  const [renamingTopics] = useCache('topic.renaming')
  const [newlyRenamedTopics] = useCache('topic.newly_renamed')
  const { queueTarget: queueImageCaptureTarget, targets: imageCaptureTargets } = useImageCaptureTargets<Topic>({
    cancelMessage: 'Topic image export was cancelled',
    delayMs: IMAGE_CAPTURE_START_DELAY_MS,
    rejectPendingActions: rejectPendingTopicImageActions
  })
  const [exportMenuOptions] = useMultiplePreferences(TOPIC_EXPORT_MENU_PREFERENCE_KEYS)

  const {
    isLoading: isTopicPinsLoading,
    isMutating: isPinsMutating,
    isRefreshing: isPinsRefreshing,
    pinnedIds: topicPinnedIds,
    togglePin: toggleTopicPin
  } = usePins('topic', { enabled: dataEnabled })
  const topicPinState = useResourceListPinnedState({
    disabled: isPinsRefreshing || isPinsMutating,
    pinnedIds: topicPinnedIds,
    onTogglePin: toggleTopicPin
  })
  const { isPinned: isTopicPinned, togglePinned: toggleTopicPinned } = topicPinState
  // Move destinations intentionally include only persisted assistants. They also carry the rail's
  // pin order, so the menu mirrors the sidebar the user just picked from.
  const { pinnedIds: assistantPinnedIds } = usePins('assistant', { enabled: dataEnabled })
  const assistantPinnedIdSet = useMemo(() => new Set(assistantPinnedIds), [assistantPinnedIds])
  const { assistants } = useAssistantsApi()
  const liveAssistantIdSet = useMemo(() => new Set(assistants.map((assistant) => assistant.id)), [assistants])
  const { shortcuts: sidebarShortcuts, setPinned: setSidebarShortcutPinned } = useSidebarShortcuts()
  const sidebarTopicFavoriteIdSet = useMemo(
    () =>
      new Set(
        sidebarShortcuts.flatMap((shortcut) =>
          shortcut.target.locator.providerId === SIDEBAR_SHORTCUT_PROVIDER_IDS.TOPIC
            ? [shortcut.target.locator.resourceId]
            : []
        )
      ),
    [sidebarShortcuts]
  )
  const handleToggleTopicSidebar = useCallback(
    (topic: Topic) => {
      const target = createSidebarShortcutTarget(SIDEBAR_SHORTCUT_PROVIDER_IDS.TOPIC, topic.id)
      setSidebarShortcutPinned(
        target,
        !sidebarTopicFavoriteIdSet.has(topic.id),
        topic.name.trim() || t('chat.conversation.new')
      )
    },
    [setSidebarShortcutPinned, sidebarTopicFavoriteIdSet, t]
  )

  const {
    topics: apiTopics,
    isLoadingAll,
    isFullyLoaded,
    isRefreshing,
    error,
    refreshError,
    refetch: refetchTopics
  } = assistantTopicsSource
  const listRef = useRef<HTMLDivElement>(null)

  const showTopicImageExportToast = useCallback(
    (request: TopicImageActionRequest) => {
      const key = `topic-image-export:${request.id}`
      const loadingPromise = request.promise.finally(() => toast.closeToast(key)).catch(() => undefined)

      toast.loading({
        key,
        title: t('chat.topics.export.image_exporting_keep_page'),
        promise: loadingPromise,
        onError: () => {}
      })

      void request.promise.then(
        () => toast.success(t('chat.topics.export.image_saved')),
        () => toast.error(t('chat.topics.export.failed'))
      )
    },
    [t]
  )

  const handleTopicImageAction = useCallback(
    (type: TopicImageActionType, topic: Topic) => {
      const request = requestTopicImageAction(type, topic, { emit: false })
      if (type === 'export') {
        showTopicImageExportToast(request)
      } else {
        void request.promise.catch(() => toast.error(t('common.copy_failed')))
      }

      queueImageCaptureTarget(request, topic)
    },
    [queueImageCaptureTarget, showTopicImageExportToast, t]
  )

  const topicItemsReconciliationRef = useRef(EMPTY_TOPIC_LIST_ITEM_RECONCILIATION)
  const apiBackedTopics = useMemo(() => {
    const reconciliation = reconcileTopicListItems(apiTopics, isTopicPinned, topicItemsReconciliationRef.current)
    topicItemsReconciliationRef.current = reconciliation
    return reconciliation.items
  }, [apiTopics, isTopicPinned])
  const { items: topics, rename: renameTopicOptimistically } = useOptimisticResourceName(apiBackedTopics)
  const topicsRef = useRef(topics)
  const activeTopicRef = useRef(activeTopic)
  const activeTopicIdRef = useRef(activeTopic?.id ?? '')

  useEffect(() => {
    topicsRef.current = topics
  }, [topics])

  useEffect(() => {
    activeTopicIdRef.current = activeTopic?.id ?? ''
  }, [activeTopic?.id])

  useEffect(() => {
    activeTopicRef.current = activeTopic
  }, [activeTopic])

  // The list is one assistant's history, so the scope is a filter on the shared topic source
  // rather than a second fetch: switching assistants must never re-download the history.
  const scopedTopics = useMemo(
    () => topics.filter((topic) => matchesAssistantScope(topic, activeAssistantId, liveAssistantIdSet)),
    [activeAssistantId, liveAssistantIdSet, topics]
  )

  const assistantMoveTargets = useMemo<TopicMoveAssistantTarget[]>(() => {
    const targets = assistants.map((assistant) => ({
      id: assistant.id,
      name: assistant.name,
      icon: renderAssistantEntityIcon(
        assistantIconType,
        {
          emoji: assistant.emoji,
          modelId: assistant.modelId,
          modelName: assistant.modelName
        },
        defaultModelId
      )
    }))

    return [
      ...targets.filter((assistant) => assistantPinnedIdSet.has(assistant.id)),
      ...targets.filter((assistant) => !assistantPinnedIdSet.has(assistant.id))
    ]
  }, [assistantIconType, assistantPinnedIdSet, assistants, defaultModelId])

  const { isFulfilled: isActiveTopicStreamFulfilled, markSeen: markActiveTopicStreamSeen } = useTopicStreamStatus(
    activeTopic?.id ?? ''
  )

  useEffect(() => {
    if (isActiveTopicStreamFulfilled) {
      markActiveTopicStreamSeen()
    }
  }, [isActiveTopicStreamFulfilled, markActiveTopicStreamSeen])

  const updateTopic = useCallback(
    (topic: Topic) =>
      patchTopic(topic.id, {
        name: topic.name,
        isNameManuallyEdited: topic.isNameManuallyEdited
      }),
    [patchTopic]
  )

  const handleRenameTopic = useCallback(
    (topicId: string, name: string) => {
      const topic = topics.find((candidate) => candidate.id === topicId)
      const trimmedName = name.trim()
      if (!topic || !trimmedName || trimmedName === topic.name) {
        return
      }

      void renameTopicOptimistically(topic, trimmedName, async () => {
        await updateTopic({ ...topic, name: trimmedName, isNameManuallyEdited: true })
        return true
      }).then(
        () => toast.success(t('common.saved')),
        (err) => {
          logger.error('Failed to rename topic', { err, topicId })
          toast.error(formatErrorMessageWithPrefix(err, t('common.error')))
        }
      )
    },
    [renameTopicOptimistically, topics, t, updateTopic]
  )

  const isRenaming = useCallback((topicId: string) => renamingTopics.includes(topicId), [renamingTopics])
  const isNewlyRenamed = useCallback((topicId: string) => newlyRenamedTopics.includes(topicId), [newlyRenamedTopics])

  const handlePinTopic = useCallback(
    async (topic: Topic) => {
      const nextPinned = !topic.pinned
      if (nextPinned) {
        setTimeout(() => listRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' }), 50)
      }

      try {
        await toggleTopicPinned(topic.id)
      } catch (err) {
        logger.error('Failed to toggle topic pin', { topicId: topic.id, err })
      }
    },
    [toggleTopicPinned]
  )

  const handleMoveTopicToAssistant = useCallback(
    async (topic: Topic, assistantId: string) => {
      if (topic.assistantId === assistantId) return

      try {
        await patchTopic(topic.id, { assistantId })
        const currentActiveTopic = activeTopicRef.current
        if (currentActiveTopic?.id === topic.id) {
          setActiveTopic({ ...currentActiveTopic, assistantId })
        }
        toast.success(t('chat.topics.manage.move.success', { count: 1 }))
      } catch (err) {
        logger.error('Failed to move topic to assistant', { assistantId, err, topicId: topic.id })
        toast.error(formatErrorMessageWithPrefix(err, t('common.error')))
      }
    },
    [patchTopic, setActiveTopic, t]
  )

  const handleDeleteTopicFromMenu = useCallback(
    async (topic: Topic) => {
      const wasActiveAtStart = topic.id === activeTopicIdRef.current
      const assistantTopicsBeforeDelete = topicsRef.current.filter(
        (candidate) => candidate.assistantId === topic.assistantId
      )
      const replacement =
        pickNeighbourAfterRemoval(assistantTopicsBeforeDelete, topic.id) ??
        findLatestActive(topicsRef.current.filter((candidate) => candidate.id !== topic.id))

      try {
        await deleteTopicById(topic.id)
      } catch (err) {
        logger.error('Failed to delete topic', { topicId: topic.id, err })
        if (isTrashTargetNotFoundError(err)) toast.info(t('recycle_bin.already_moved'))
        else if (isTrashTopicBusyError(err)) toast.info(t('recycle_bin.move.blocked_generation'))
        else toast.error(err instanceof Error ? err.message : t('chat.topics.manage.delete.error'))
        return
      }

      // A mid-delete switch to another topic must win. An empty ('') mirror only reselects
      // when the deleted topic was active at delete start (#19583 race collapse); deleting
      // with no selection at all stays a no-op.
      const currentActiveTopicId = activeTopicIdRef.current
      const shouldReplaceSelection = (!currentActiveTopicId && wasActiveAtStart) || currentActiveTopicId === topic.id
      if (shouldReplaceSelection) {
        if (replacement) setActiveTopic(replacement)
        else clearActiveTopic()
      }

      showRecycleBinUndo({
        itemName: topic.name.trim() || t('chat.conversation.new'),
        title: t('common.archived', { name: topic.name.trim() || t('chat.conversation.new') }),
        onUndo: () =>
          restoreRecycleBinItem({
            id: topic.id,
            restore: restoreTopic,
            getActive: (id) => dataApiService.get(`/topics/${id}`),
            refresh: refreshTopics
          })
      })
    },
    [clearActiveTopic, deleteTopicById, refreshTopics, restoreTopic, setActiveTopic, t]
  )

  const handleClearMessages = useCallback((topic: Topic) => clearTopicMessages(topic.id), [clearTopicMessages])

  const handleAutoRename = useCallback(
    async (topic: Topic) => {
      const messages = await getTopicMessages(topic.id)
      if (messages.length < 2) return

      startTopicRenaming(topic.id)
      let didPersistRename = false
      try {
        const { text: summaryText, error: summaryError } = await fetchMessagesSummary({ messages })
        if (summaryText) {
          try {
            await updateTopic({ ...topic, name: summaryText, isNameManuallyEdited: false })
            didPersistRename = true
          } catch (err) {
            logger.error('Failed to save automatically renamed topic', { topicId: topic.id, err })
            const message = err instanceof Error ? err.message : t('common.save_failed')
            toast.error(message)
          }
        } else if (summaryError) {
          toast.error(`${t('message.error.fetchTopicName')}: ${summaryError}`)
        }
      } finally {
        if (didPersistRename) {
          finishTopicRenaming(topic.id)
        } else {
          cancelTopicRenaming(topic.id)
        }
      }
    },
    [t, updateTopic]
  )

  const topicGroupBy = useMemo(
    () =>
      createTopicTimeGroupResolver<Topic>({
        labels: {
          pinned: t('selector.common.pinned_title'),
          time: {
            today: t('chat.topics.group.today'),
            yesterday: t('chat.topics.group.yesterday'),
            'this-week': t('chat.topics.group.this_week'),
            earlier: t('chat.topics.group.earlier')
          }
        },
        now: groupNow
      }),
    [groupNow, t]
  )

  const groupedTopics = useMemo(
    () => sortTopicsForDisplayGroups(scopedTopics, { mode: 'time', now: groupNow }),
    [groupNow, scopedTopics]
  )
  // "Earlier" above a list with nothing newer restates the list itself.
  const topicGroupByForDisplay = useMemo(
    () => withSoleGroupLabelHidden<Topic>(topicGroupBy, groupedTopics, { ignoreGroupIds: [TOPIC_PINNED_GROUP_ID] }),
    [groupedTopics, topicGroupBy]
  )
  const headerCreateTopicPayload = useMemo(() => ({ assistantId: activeAssistantId ?? null }), [activeAssistantId])
  const handleHeaderCreate = useCallback(() => {
    void onNewTopic?.(headerCreateTopicPayload)
  }, [headerCreateTopicPayload, onNewTopic])

  const collapsedTopicState = useMemo(
    () =>
      resolveDefaultCollapsedGroupIds({
        collapsedIds: topicExpansionTime,
        groupBy: topicGroupBy,
        items: groupedTopics
      }),
    [groupedTopics, topicExpansionTime, topicGroupBy]
  )
  const handleTopicCollapsedStateChange = useCallback(
    (nextCollapsedIds: string[]) => {
      setTopicExpansionTime(nextCollapsedIds)
    },
    [setTopicExpansionTime]
  )

  const listError = error
  const historyLoading = isLoadingAll || !isFullyLoaded
  const metadataLoading = isTopicPinsLoading
  const visibleTopics = useMemo(() => (metadataLoading ? [] : groupedTopics), [groupedTopics, metadataLoading])
  const listStatus = listError
    ? 'error'
    : historyLoading && visibleTopics.length === 0
      ? 'loading'
      : visibleTopics.length === 0
        ? 'empty'
        : 'idle'
  const hasActiveCenterSurface = manageAssistantsActive || historyRecordsActive
  const openTopicInNewTab = useCallback(
    (topic: Topic) => {
      conversationNav.openConversationTab(topic.id, topic.name, { forceNew: true })
    },
    [conversationNav]
  )
  const openTopicInNewWindow = useCallback(
    (topic: Topic) => {
      conversationNav.openConversationWindow(topic.id, topic.name)
    },
    [conversationNav]
  )

  return (
    <>
      <TopicResourceList<Topic>
        key={`topic-resource:${activeAssistantId ?? 'unlinked'}`}
        rowLayout={RESOURCE_LIST_ROW_LAYOUTS.history}
        items={visibleTopics}
        status={listStatus}
        selectedId={hasActiveCenterSurface ? null : activeTopic?.id}
        groupBy={topicGroupByForDisplay}
        collapsedState={collapsedTopicState}
        revealRequest={revealRequest}
        defaultGroupVisibleCount={LEFT_PANEL_TIME_TOPIC_GROUP_VISIBLE_COUNT}
        groupLoadStep={Number.POSITIVE_INFINITY}
        getGroupHeaderKind={getBucketGroupHeaderKind}
        groupShowMoreLabel={t('chat.topics.group.show_more')}
        groupCollapseLabel={t('chat.topics.group.collapse')}
        onRenameItem={handleRenameTopic}
        onCollapsedStateChange={handleTopicCollapsedStateChange}>
        <ResourceList.Header>
          <ResourceList.HeaderItem
            data-ui="chat.topic-list.action.create"
            type="button"
            command="topic.create"
            aria-label={t('chat.conversation.new')}
            icon={<NewConversationIcon />}
            label={t('chat.conversation.new')}
            onClick={handleHeaderCreate}
            actions={
              <TopicListOptionsMenu
                historyRecordsActive={historyRecordsActive}
                onOpenHistoryRecords={onOpenHistoryRecords}
              />
            }
          />
        </ResourceList.Header>

        {refreshError && <ResourceRefreshErrorBanner onRetry={refetchTopics} retrying={isRefreshing} />}

        <TopicListBody
          activeTopic={activeTopic}
          assistantMoveTargets={assistantMoveTargets}
          exportMenuOptions={exportMenuOptions}
          isNewlyRenamed={isNewlyRenamed}
          isRenaming={isRenaming}
          listRef={listRef}
          notesPath={notesPath}
          onAutoRename={handleAutoRename}
          onClearMessages={handleClearMessages}
          onDeleteFromMenu={handleDeleteTopicFromMenu}
          onOpenInNewTab={tabs && !isWindowFrame ? openTopicInNewTab : undefined}
          onOpenInNewWindow={tabs ? openTopicInNewWindow : undefined}
          onMoveToAssistant={handleMoveTopicToAssistant}
          onPinTopic={handlePinTopic}
          onToggleSidebar={handleToggleTopicSidebar}
          onRequestTopicImageAction={handleTopicImageAction}
          onSwitchTopic={setActiveTopic}
          sidebarTopicFavoriteIdSet={sidebarTopicFavoriteIdSet}
          topicsLength={topics.length}
        />
        {historyLoading && visibleTopics.length > 0 && (
          <div className="shrink-0 px-3 py-2 text-center text-[11px] text-foreground-tertiary">
            {t('common.loading')}
          </div>
        )}
      </TopicResourceList>

      {imageCaptureTargets.map(({ requestId, target: topic }) => (
        <TopicImageCaptureHost key={requestId} topic={topic} />
      ))}
    </>
  )
}

type TopicStreamState = {
  isAwaitingApproval: boolean
  isErrored: boolean
  isFulfilled: boolean
  isPending: boolean
}

const EMPTY_TOPIC_STREAM_STATE: TopicStreamState = Object.freeze({
  isAwaitingApproval: false,
  isErrored: false,
  isFulfilled: false,
  isPending: false
})

const getTopicStreamStatusCacheKey = (topicId: string) => `topic.stream.statuses.${topicId}` as const

const getTopicStreamLastSeenCompletionCacheKey = (topicId: string) =>
  `topic.stream.last_seen_completion.${topicId}` as const

const selectTopicStreamState = (
  values: readonly [TopicStatusSnapshotEntry | null | undefined, number | null | undefined]
): TopicStreamState => {
  const [statusEntry, lastSeenCompletion] = values
  const status = statusEntry?.status
  const lastCompletedAt = statusEntry?.lastCompletedAt ?? null
  const flags = classifyTurn(status)
  const streamStatus = {
    isAwaitingApproval: flags.isAwaitingApproval || (statusEntry?.awaitingApprovalAnchors.length ?? 0) > 0,
    isErrored: status === 'error',
    isFulfilled: status === 'done' && lastCompletedAt !== lastSeenCompletion,
    isPending: flags.isStreamLive
  }

  // Normalize the idle case to a module constant; the non-idle object is
  // rebuilt per run and bails out via the default shallowEqual.
  return streamStatus.isAwaitingApproval || streamStatus.isPending || streamStatus.isFulfilled || streamStatus.isErrored
    ? streamStatus
    : EMPTY_TOPIC_STREAM_STATE
}

const useTopicListStreamStatus = (topicId: string): TopicStreamState =>
  useSharedCacheSelector(
    [getTopicStreamStatusCacheKey(topicId), getTopicStreamLastSeenCompletionCacheKey(topicId)],
    selectTopicStreamState
  )

interface TopicListBodyProps {
  activeTopic?: Topic
  assistantMoveTargets: readonly TopicMoveAssistantTarget[]
  exportMenuOptions: TopicExportMenuOptions
  isNewlyRenamed: (topicId: string) => boolean
  isRenaming: (topicId: string) => boolean
  listRef: RefObject<HTMLDivElement | null>
  notesPath: string
  onAutoRename: (topic: Topic) => Promise<void>
  onClearMessages: (topic: Topic) => void
  onDeleteFromMenu: (topic: Topic) => Promise<void>
  onMoveToAssistant: (topic: Topic, assistantId: string) => void | Promise<void>
  onOpenInNewTab?: (topic: Topic) => void
  onOpenInNewWindow?: (topic: Topic) => void
  onPinTopic: (topic: Topic) => Promise<void>
  onToggleSidebar: (topic: Topic) => void
  onRequestTopicImageAction: (type: TopicImageActionType, topic: Topic) => void
  onSwitchTopic: (topic: Topic) => void
  sidebarTopicFavoriteIdSet: ReadonlySet<string>
  topicsLength: number
}

type TopicRowSharedProps = Omit<TopicListBodyProps, 'activeTopic' | 'listRef'>

function TopicListBody(props: TopicListBodyProps) {
  const { t } = useTranslation()
  const {
    activeTopic,
    assistantMoveTargets,
    exportMenuOptions,
    isNewlyRenamed,
    isRenaming,
    listRef,
    notesPath,
    onAutoRename,
    onClearMessages,
    onDeleteFromMenu,
    onMoveToAssistant,
    onOpenInNewTab,
    onOpenInNewWindow,
    onPinTopic,
    onToggleSidebar,
    onRequestTopicImageAction,
    onSwitchTopic,
    sidebarTopicFavoriteIdSet,
    topicsLength
  } = props

  const rowProps = useMemo<TopicRowSharedProps>(
    () => ({
      assistantMoveTargets,
      exportMenuOptions,
      isNewlyRenamed,
      isRenaming,
      notesPath,
      onAutoRename,
      onClearMessages,
      onDeleteFromMenu,
      onMoveToAssistant,
      onOpenInNewTab,
      onOpenInNewWindow,
      onPinTopic,
      onToggleSidebar,
      onRequestTopicImageAction,
      onSwitchTopic,
      sidebarTopicFavoriteIdSet,
      topicsLength
    }),
    [
      assistantMoveTargets,
      exportMenuOptions,
      isNewlyRenamed,
      isRenaming,
      notesPath,
      onAutoRename,
      onClearMessages,
      onDeleteFromMenu,
      onMoveToAssistant,
      onOpenInNewTab,
      onOpenInNewWindow,
      onPinTopic,
      onToggleSidebar,
      onRequestTopicImageAction,
      onSwitchTopic,
      sidebarTopicFavoriteIdSet,
      topicsLength
    ]
  )

  const activeTopicId = activeTopic?.id
  const renderItem = useCallback(
    (topic: Topic) => <TopicRow key={topic.id} topic={topic} isActive={topic.id === activeTopicId} {...rowProps} />,
    [activeTopicId, rowProps]
  )

  return (
    <ResourceList.Body<Topic>
      listRef={listRef}
      errorFallback={<ResourceList.ErrorState message={t('error.boundary.default.message')} />}
      emptyFallback={
        <div className="mx-auto flex h-full w-full max-w-sm items-center justify-center break-words px-5 py-10 text-center text-muted-foreground text-xs">
          {t('chat.topics.empty.title')}
        </div>
      }
      renderItem={renderItem}
    />
  )
}

interface TopicRowWithStatusProps extends TopicRowSharedProps {
  isActive: boolean
  topic: Topic
}

type TopicRowProps = TopicRowWithStatusProps

const TopicRow = memo(function TopicRow({
  assistantMoveTargets,
  exportMenuOptions,
  isActive,
  isNewlyRenamed,
  isRenaming,
  notesPath,
  onAutoRename,
  onClearMessages,
  onDeleteFromMenu,
  onMoveToAssistant,
  onOpenInNewTab,
  onOpenInNewWindow,
  onPinTopic,
  onToggleSidebar,
  onRequestTopicImageAction,
  onSwitchTopic,
  sidebarTopicFavoriteIdSet,
  topic,
  topicsLength
}: TopicRowProps) {
  const { t, i18n } = useTranslation()
  const rightPanelState = useOptionalRightPanelState()
  const rightPanelActions = useOptionalRightPanelActions()
  const actions = useResourceListActions()
  const rowState = useResourceListRowState(topic.id)
  const streamStatus = useTopicListStreamStatus(topic.id)
  const topicDisplayName = topic.name.trim() ? topic.name : t('chat.conversation.new')
  const topicName = topicDisplayName.replace('`', '')
  const timestamp = formatListTimestamp(topic.lastActivityAt, i18n.language)
  const nameAnimationClassName = isRenaming(topic.id)
    ? 'animation-shimmer'
    : isNewlyRenamed(topic.id)
      ? 'animation-reveal'
      : ''
  const {
    isAwaitingApproval: isTopicAwaitingApproval,
    isErrored: isTopicStreamErrored,
    isFulfilled: isTopicStreamFulfilled,
    isPending: isTopicStreamPending
  } = streamStatus
  // Running (spinner) and errored (red) are ongoing states that stay on the
  // selected row too — only the completion dot (green) is a read-receipt that
  // clears once the row is opened (`!isActive`). Awaiting approval is shown as
  // a badge instead of a spinner because the turn needs user action.
  const conversationRowStatus = isTopicAwaitingApproval
    ? 'approval'
    : isTopicStreamPending
      ? 'pending'
      : isTopicStreamErrored
        ? 'error'
        : !isActive && isTopicStreamFulfilled
          ? 'done'
          : null
  const hasTopicStreamIndicator = conversationRowStatus !== null && conversationRowStatus !== 'approval'
  const showPinAction = !rowState.renaming
  const canDeleteTopic = !topic.pinned
  const isArchiveBlocked = isTopicStreamPending || isTopicAwaitingApproval
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const startInlineRename = useCallback(() => actions.startRename(topic.id), [actions, topic.id])
  const startMenuRename = useCallback(() => setRenameDialogOpen(true), [])
  const submitRenameDialog = useCallback((name: string) => actions.commitRename(topic.id, name), [actions, topic.id])
  const { getMenuActions, handleMenuAction } = useTopicMenuActions({
    exportMenuOptions,
    isArchiveBlocked,
    isActiveInCurrentTab: isActive,
    isRenaming: isRenaming(topic.id),
    notesPath,
    assistantMoveTargets,
    onAutoRename,
    onClearMessages,
    onCopyImage: (topic) => onRequestTopicImageAction('copy', topic),
    onDelete: onDeleteFromMenu,
    onExportImage: (topic) => onRequestTopicImageAction('export', topic),
    onMoveToAssistant,
    onOpenInNewTab,
    onOpenInNewWindow,
    onPinTopic,
    onToggleSidebar,
    onStartRename: startMenuRename,
    sidebarPinned: sidebarTopicFavoriteIdSet.has(topic.id),
    t,
    topic,
    topicsLength
  })
  const deleteAction = useMemo(() => getMenuActions().find((action) => action.id === 'topic.delete'), [getMenuActions])

  const row = (
    <ResourceList.Item
      item={topic}
      data-testid="topic-list-row"
      className="relative"
      style={{ cursor: 'pointer' }}
      onClick={() => {
        if (rightPanelState?.maximized) rightPanelActions?.minimize()
        onSwitchTopic(topic)
      }}>
      <ResourceList.RenameField
        item={topic}
        aria-label={t('chat.topics.edit.title')}
        autoFocus
        onClick={(event) => event.stopPropagation()}
      />
      {!rowState.renaming && (
        // Title over time: two lines carry both what the conversation is and when it happened,
        // which is what a history list is scanned for.
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <ResourceList.ItemTitle
            fade
            title={topicDisplayName}
            className={cn(
              'flex-none',
              nameAnimationClassName,
              // The stream indicator is an absolute overlay (keeps no flex space),
              // so the title needs a standing yield for its dot zone; on hover the
              // overlay fades out, the standing yield closes, and the in-flow action rail expands.
              // The draft indicator needs no yield — it stays in flow and reserves its own space.
              hasTopicStreamIndicator && CONVERSATION_ROW_STATUS_TITLE_CLASS
            )}
            onDoubleClick={(event) => {
              event.stopPropagation()
              startInlineRename()
            }}>
            {topicName}
          </ResourceList.ItemTitle>
          {timestamp && <span className="truncate text-foreground-tertiary text-xs leading-4">{timestamp}</span>}
        </span>
      )}
      {!rowState.renaming && (
        <TopicTrailingStatus
          topicId={topic.id}
          draftLabel={t('chat.topics.draft')}
          isActive={isActive}
          status={conversationRowStatus}
        />
      )}
      <ResourceList.ItemActions pinned={topic.pinned && showPinAction}>
        {showPinAction && (
          <Tooltip title={topic.pinned ? t('chat.topics.unpin') : t('chat.topics.pin')} delay={500}>
            <ResourceList.ItemAction
              aria-label={topic.pinned ? t('chat.topics.unpin') : t('chat.topics.pin')}
              aria-pressed={topic.pinned}
              className={cn(topic.pinned && 'text-foreground')}
              onClick={(event) => {
                event.stopPropagation()
                void onPinTopic(topic)
              }}>
              <PinIcon size={14} className={cn('size-3.5!', topic.pinned && 'fill-current')} />
            </ResourceList.ItemAction>
          </Tooltip>
        )}
        {canDeleteTopic && (
          <Tooltip
            title={isArchiveBlocked ? t('recycle_bin.move.blocked_generation') : t('common.archive')}
            delay={500}>
            <ResourceList.ItemAction
              aria-label={t('common.archive')}
              disabled={isArchiveBlocked}
              onClick={(event) => {
                event.stopPropagation()
                if (deleteAction) void handleMenuAction(deleteAction)
              }}>
              <Archive size={14} className="size-3.5!" />
            </ResourceList.ItemAction>
          </Tooltip>
        )}
      </ResourceList.ItemActions>
    </ResourceList.Item>
  )

  return (
    <>
      <ResourceListActionContextMenu item={topic} getActions={getMenuActions} onAction={handleMenuAction}>
        {row}
      </ResourceListActionContextMenu>
      <EditNameDialog
        open={renameDialogOpen}
        title={t('chat.topics.edit.title')}
        initialName={topic.name}
        placeholder={t('chat.topics.edit.placeholder')}
        onSubmit={submitRenameDialog}
        onOpenChange={setRenameDialogOpen}
      />
    </>
  )
})

const TOPIC_DRAFT_INDICATOR_CLASS =
  'pointer-events-none flex size-5 max-w-5 shrink-0 items-center justify-center overflow-hidden opacity-100 transition-[margin,max-width,opacity] duration-150 group-hover:-ml-1.5 group-hover:max-w-0 group-hover:opacity-0 group-has-[[data-resource-list-item-actions]:focus-within]:-ml-1.5 group-has-[[data-resource-list-item-actions][data-active=true]]:-ml-1.5 group-has-[[data-resource-list-item-actions]:focus-within]:max-w-0 group-has-[[data-resource-list-item-actions][data-active=true]]:max-w-0 group-has-[[data-resource-list-item-actions]:focus-within]:opacity-0 group-has-[[data-resource-list-item-actions][data-active=true]]:opacity-0'

const TopicTrailingStatus = ({
  topicId,
  draftLabel,
  isActive,
  status
}: {
  topicId: string
  draftLabel: string
  isActive: boolean
  status: ConversationRowStatusValue | null
}) => {
  if (status) {
    return (
      <ConversationRowStatus
        status={status}
        testId={status === 'approval' ? 'topic-awaiting-approval-badge' : 'topic-stream-indicator'}
      />
    )
  }

  // The active row's draft is the text visible in the composer right below it,
  // so flagging it as unsent tells the user nothing.
  if (isActive) return null

  // The draft subscriber mounts only in the lowest-priority branch. Virtualized
  // rows that are offscreen, or rows showing a higher-priority status, subscribe
  // to no draft key at all.
  return <TopicDraftIndicator topicId={topicId} label={draftLabel} />
}

const TopicDraftIndicator = ({ topicId, label }: { topicId: string; label: string }) => {
  const subscribe = useCallback((listener: () => void) => subscribeChatDraftCache(topicId, listener), [topicId])
  const getSnapshot = useCallback(() => readChatDraftPresence(topicId), [topicId])
  const hasDraft = useSyncExternalStore(subscribe, getSnapshot, () => false)

  if (!hasDraft) return null

  return (
    <span aria-label={label} className={TOPIC_DRAFT_INDICATOR_CLASS} role="img">
      <FilePenLine aria-hidden="true" className="size-3 text-foreground-tertiary" />
    </span>
  )
}
