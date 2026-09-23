import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type * as UseCacheModule from '@renderer/data/hooks/useCache'
import { type AssistantTopicsSource, deriveAssistantTopicsView } from '@renderer/hooks/resourceViewSources'
import type * as ImageCaptureTargetsHook from '@renderer/hooks/useImageCaptureTargets'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type * as RecycleBinFeedback from '@renderer/services/recycleBinFeedback'
import { toast } from '@renderer/services/toast'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { trashErrorCodes } from '@shared/ipc/errors/trash'

const virtualMocks = vi.hoisted(() => ({
  useVirtualizer: vi.fn((options: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: `row-${index}`,
        start: index * options.estimateSize(index),
        size: options.estimateSize(index)
      })),
    getTotalSize: () => options.count * 56,
    measureElement: vi.fn(),
    scrollElement: null,
    scrollToIndex: virtualMocks.scrollToIndex
  })),
  scrollToIndex: vi.fn()
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: virtualMocks.useVirtualizer,
  defaultRangeExtractor: vi.fn((range) =>
    Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, i) => range.startIndex + i)
  )
}))

const notesSettingsMocks = vi.hoisted(() => ({
  useNotesSettings: vi.fn(() => ({ notesPath: '/notes' }))
}))

vi.mock('@renderer/hooks/useNotesSettings', () => notesSettingsMocks)

const imageCaptureTargetsMock = vi.hoisted(() => ({
  targets: undefined as Array<{ requestId: number; target: unknown }> | undefined
}))

vi.mock('@renderer/hooks/useImageCaptureTargets', async () => {
  const actual = await vi.importActual<typeof ImageCaptureTargetsHook>('@renderer/hooks/useImageCaptureTargets')

  return {
    ...actual,
    useImageCaptureTargets: (options: Parameters<typeof actual.useImageCaptureTargets>[0]) => {
      const actualResult = actual.useImageCaptureTargets(options)

      return imageCaptureTargetsMock.targets
        ? { ...actualResult, targets: imageCaptureTargetsMock.targets as typeof actualResult.targets }
        : actualResult
    }
  }
})

const tabsContextMocks = vi.hoisted(() => ({
  closeConversationTabs: vi.fn(),
  openTab: vi.fn(),
  setActiveTab: vi.fn(),
  tabs: [] as Array<{ id: string; type: string; url: string }>
}))
const windowFrameMocks = vi.hoisted(() => ({ mode: 'embedded' as 'embedded' | 'window' }))

vi.mock('@renderer/hooks/tab', () => ({
  useCloseConversationTabs: () => tabsContextMocks.closeConversationTabs,
  useOptionalTabsContext: () => tabsContextMocks
}))

vi.mock('@renderer/hooks/useWindowFrame', () => ({
  useWindowFrame: () => ({ mode: windowFrameMocks.mode })
}))

vi.mock('@renderer/pages/home/messages/TopicImageCaptureHost', () => ({
  __esModule: true,
  default: ({ topic }: { topic: { id: string } }) => (
    <div data-testid="topic-image-capture-host" data-topic-id={topic.id} />
  )
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, size }: { model: { id: string; providerId: string }; size: number }) => (
    <span data-model-id={model.id} data-provider-id={model.providerId} data-size={size} data-testid="model-avatar" />
  )
}))

const topicDataMocks = vi.hoisted(() => ({
  clearTopicMessagesTrigger: vi.fn().mockResolvedValue({ deletedIds: ['message-c'] }),
  deleteTopic: vi.fn().mockResolvedValue(undefined),
  refreshTopics: vi.fn().mockResolvedValue(undefined),
  restoreTopic: vi.fn().mockResolvedValue(undefined),
  updateTopic: vi.fn().mockResolvedValue(undefined)
}))

const topicRenameMocks = vi.hoisted(() => ({
  cancelTopicRenaming: vi.fn(),
  finishTopicRenaming: vi.fn(),
  getTopicMessages: vi.fn().mockResolvedValue([]),
  startTopicRenaming: vi.fn()
}))

const pinMutationMocks = vi.hoisted(() => ({
  createPin: vi.fn(),
  deletePin: vi.fn()
}))

const ipcMocks = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@renderer/ipc', () => ({
  ipcApi: ipcMocks,
  useIpcOn: vi.fn()
}))

const recycleBinFeedbackMocks = vi.hoisted(() => ({
  showRecycleBinBatchUndo: vi.fn(),
  showRecycleBinUndo: vi.fn()
}))

vi.mock('@renderer/services/recycleBinFeedback', async (importOriginal) => ({
  ...(await importOriginal<typeof RecycleBinFeedback>()),
  ...recycleBinFeedbackMocks
}))

const topicStreamStatusMocks = vi.hoisted(() => ({
  markSeen: vi.fn(),
  statuses: new Map<string, { isFulfilled?: boolean; isPending?: boolean }>()
}))

const cacheHookMocks = vi.hoisted(() => ({
  setCache: vi.fn(),
  setters: new Map<string, (value: unknown) => void>(),
  values: new Map<string, unknown>()
}))

vi.mock('@data/hooks/useCache', async (importOriginal) => ({
  // Real hook over the globally mocked cacheService: the stream-status tests
  // seed that store via setShared and spy on its subscribe.
  useSharedCacheSelector: (await importOriginal<typeof UseCacheModule>()).useSharedCacheSelector,
  useCache: (key: string) => {
    if (!cacheHookMocks.setters.has(key)) {
      cacheHookMocks.setters.set(key, (value: unknown) => {
        cacheHookMocks.values.set(key, value)
        cacheHookMocks.setCache(key, value)
      })
    }
    return [cacheHookMocks.values.get(key) ?? [], cacheHookMocks.setters.get(key)]
  },
  usePersistCache: (key: string) => {
    if (!cacheHookMocks.setters.has(key)) {
      cacheHookMocks.setters.set(key, (value: unknown) => {
        cacheHookMocks.values.set(key, value)
        cacheHookMocks.setCache(key, value)
      })
    }
    return [cacheHookMocks.values.get(key), cacheHookMocks.setters.get(key)]
  }
}))

vi.mock('@renderer/hooks/useTopic', async () => {
  const actual = await vi.importActual<typeof TopicDataApiModule>('@renderer/hooks/useTopic')
  return {
    ...actual,
    cancelTopicRenaming: topicRenameMocks.cancelTopicRenaming,
    finishTopicRenaming: topicRenameMocks.finishTopicRenaming,
    getTopicMessages: topicRenameMocks.getTopicMessages,
    startTopicRenaming: topicRenameMocks.startTopicRenaming,
    useTopicMutations: () => ({
      updateTopic: topicDataMocks.updateTopic,
      deleteTopic: topicDataMocks.deleteTopic,
      refreshTopics: topicDataMocks.refreshTopics,
      restoreTopic: topicDataMocks.restoreTopic
    })
  }
})

vi.mock('@renderer/hooks/useTopicStreamStatus', () => ({
  useTopicStreamStatus: (topicId: string) => {
    const status = topicStreamStatusMocks.statuses.get(topicId)
    return {
      activeExecutions: [],
      isFulfilled: status?.isFulfilled ?? false,
      isPending: status?.isPending ?? false,
      markSeen: () => topicStreamStatusMocks.markSeen(topicId),
      status: undefined
    }
  }
}))

vi.mock('@renderer/utils/aiGeneration', () => ({
  fetchMessagesSummary: vi.fn().mockResolvedValue({ text: 'Auto title' })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    COPY_TOPIC_IMAGE: 'COPY_TOPIC_IMAGE',
    EXPORT_TOPIC_IMAGE: 'EXPORT_TOPIC_IMAGE'
  },
  EventEmitter: {
    emit: vi.fn()
  }
}))

// The confirm-and-run dialog itself is covered by its own unit test; here we just let it run
// the gated action (as if the user confirmed).
const { confirmActionShow } = vi.hoisted(() => ({
  confirmActionShow: vi.fn(async (options?: { action?: () => unknown }) => {
    await options?.action?.()
    return true
  })
}))
vi.mock('@renderer/components/popups/ConfirmActionPopup', () => ({ default: { show: confirmActionShow } }))

vi.mock('@renderer/components/ObsidianExportPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/popups/PromptPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/SaveToKnowledgePopup', () => ({
  default: { showForTopic: vi.fn() }
}))

vi.mock('@renderer/services/ExportService', () => ({
  exportMarkdownToJoplin: vi.fn(),
  exportMarkdownToSiyuan: vi.fn(),
  exportMarkdownToYuque: vi.fn(),
  exportTopicAsMarkdown: vi.fn(),
  exportTopicToNotes: vi.fn(),
  exportTopicToNotion: vi.fn(),
  topicToMarkdown: vi.fn().mockResolvedValue('# topic')
}))

vi.mock('@renderer/services/copy', () => ({
  copyTopicAsMarkdown: vi.fn(),
  copyTopicAsPlainText: vi.fn()
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    init: vi.fn(),
    type: '3rdParty'
  },
  useTranslation: (() => {
    const value = {
      i18n: { language: 'en-US' },
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === 'selector.common.pinned_title') return 'Pinned'
        if (key === 'chat.topics.title') return 'Conversations'
        if (key === 'chat.topics.list') return 'Conversation List'
        if (key === 'chat.topics.draft') return 'Draft'
        if (key === 'chat.topics.group.today') return 'Today'
        if (key === 'chat.topics.group.yesterday') return 'Yesterday'
        if (key === 'chat.topics.group.this_week') return 'This week'
        if (key === 'chat.topics.group.earlier') return 'Earlier'
        if (key === 'chat.topics.group.show_more') return 'Show more conversations'
        if (key === 'chat.topics.group.collapse') return 'Collapse conversations'
        if (key === 'chat.topics.move_to') return 'Move to'
        if (key === 'history.records.shortTitle') return 'History'
        if (key === 'chat.topics.pin') return 'Pin Conversation'
        if (key === 'chat.topics.unpin') return 'Unpin Conversation'
        if (key === 'chat.topics.auto_rename') return 'Generate conversation name'
        if (key === 'chat.topics.edit.title') return 'Edit conversation name'
        if (key === 'chat.topics.empty.title') return 'No conversations'
        if (key === 'launchpad.pin_to_sidebar') return 'Add to sidebar'
        if (key === 'launchpad.unpin_from_sidebar') return 'Remove from sidebar'
        if (key === 'agent.toolPermission.pendingBadge') return 'Pending'
        if (key === 'chat.topics.clear.title') return 'Clear messages'
        if (key === 'chat.input.clear.title') return 'Clear all messages?'
        if (key === 'chat.save.topic.knowledge.menu_title') return 'Save to knowledge base'
        if (key === 'chat.topics.copy.title') return 'Copy'
        if (key === 'chat.topics.copy.image') return 'Copy as Image'
        if (key === 'chat.topics.copy.md') return 'Copy as Markdown'
        if (key === 'chat.topics.copy.plain_text') return 'Copy as Plain Text'
        if (key === 'chat.topics.export.title') return 'Export'
        if (key === 'chat.topics.export.image') return 'Export as Image'
        if (key === 'chat.topics.export.image_exporting_keep_page') return 'Exporting image. Please stay on this page.'
        if (key === 'chat.topics.export.image_saved') return 'Image saved successfully'
        if (key === 'chat.topics.export.failed') return 'Export failed'
        if (key === 'chat.topics.export.md.label') return 'Export as Markdown'
        if (key === 'chat.topics.export.md.reason') return 'Export as Markdown with Reasoning'
        if (key === 'chat.topics.export.word') return 'Export as Word'
        if (key === 'chat.topics.export.notion') return 'Export to Notion'
        if (key === 'chat.topics.export.yuque') return 'Export to Yuque'
        if (key === 'chat.topics.export.obsidian') return 'Export to Obsidian'
        if (key === 'chat.topics.export.joplin') return 'Export to Joplin'
        if (key === 'chat.topics.export.siyuan') return 'Export to Siyuan'
        if (key === 'common.delete') return 'Delete'
        if (key === 'common.archive') return 'Archive'
        if (key === 'common.delete_permanently') return 'Delete Permanently'
        if (key === 'common.error') return 'Error'
        if (key === 'common.more') return 'More'
        if (key === 'common.open_in_new_tab') return 'Open in new tab'
        if (key === 'tab.open_in_new_window') return 'Open in New Window'
        if (key === 'common.cancel') return 'Cancel'
        if (key === 'recycle_bin.already_moved') return 'Already in Recycle Bin'
        if (key === 'recycle_bin.move.blocked_generation')
          return 'Stop generation before moving this conversation to the Recycle Bin.'
        if (key === 'common.copy_failed') return 'Copy failed'
        if (key === 'common.confirm') return 'Confirm'
        if (key === 'common.loading') return 'Loading...'
        if (key === 'common.name') return 'Name'
        if (key === 'common.save') return 'Save'
        if (key === 'common.saved') return 'Saved'
        if (key === 'message.tools.status.done') return 'Done'
        if (key === 'message.tools.status.error') return 'Error'
        if (key === 'message.tools.status.running') return 'Running'
        if (key === 'chat.add.topic.title') return 'New Conversation'
        if (key === 'chat.topics.manage.move.success') return `Moved ${options?.count ?? 0} conversation(s)`
        return key
      }
    }
    return () => value
  })()
}))

import { mockUseInfiniteQuery, mockUseMutation, mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'

import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import type { ResourceListRevealRequest } from '@renderer/components/chat/resourceList/base'
import { getChatDraftCacheKey, writeChatDraftCache } from '@renderer/components/composer/variants/chat/chatDraftCache'
import type * as TopicDataApiModule from '@renderer/hooks/useTopic'
import type { Topic } from '@renderer/types/topic'
import { TOPIC_PINNED_GROUP_ID } from '@renderer/utils/chat/topicsHelpers'
import type { Pin } from '@shared/data/types/pin'
import type { Topic as ApiTopic } from '@shared/data/types/topic'

import {
  clearPendingTopicImageActionsForTest,
  consumePendingTopicImageActions,
  requestTopicImageAction,
  settleTopicImageActionRequest
} from '../../../messages/topicImageActionBus'
import { Topics } from '../Topics'

const TOPIC_EXPANSION_TIME_KEY = 'ui.topic.expansion.time'

type TopicGroupCollapseFixture = {
  time: string[]
}

// The full set of collapsible time groups; the stored cache is a flat list of
// the ones the user explicitly collapsed (denylist). Empty = everything expanded.
const ALL_TOPIC_TIME_GROUP_IDS = [
  TOPIC_PINNED_GROUP_ID,
  'topic:time:today',
  'topic:time:yesterday',
  'topic:time:this-week',
  'topic:time:earlier'
]

function setTopicGroupExpansionCache(value: TopicGroupCollapseFixture) {
  cacheHookMocks.values.set(TOPIC_EXPANSION_TIME_KEY, value.time)
}

function getTopicGroupExpansionCache() {
  return { time: cacheHookMocks.values.get(TOPIC_EXPANSION_TIME_KEY) } as TopicGroupCollapseFixture
}

function createApiTopic(overrides: Partial<ApiTopic> = {}) {
  return {
    id: 'topic-a',
    name: 'Alpha topic',
    isNameManuallyEdited: false,
    assistantId: 'assistant-1',
    orderKey: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
    lastActivityAt: overrides.lastActivityAt ?? overrides.updatedAt ?? '2026-01-01T00:00:00.000Z'
  }
}

function createRendererTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-a',
    assistantId: 'assistant-1',
    name: 'Alpha topic',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    pinned: false,
    isNameManuallyEdited: false,
    ...overrides,
    lastActivityAt: overrides.lastActivityAt ?? overrides.updatedAt ?? '2026-01-01T00:00:00.000Z'
  }
}

/**
 * Time groups only label themselves when the list spans more than one bucket, so fixtures that
 * assert on a bucket header need an older topic to contrast with.
 */
function withEarlierTopic(items: ApiTopic[]): ApiTopic[] {
  return [
    ...items,
    createApiTopic({
      id: 'topic-earlier',
      name: 'Earlier topic',
      assistantId: 'assistant-1',
      orderKey: 'zzz',
      createdAt: '2025-11-01T01:00:00.000Z',
      updatedAt: '2025-11-01T01:00:00.000Z'
    })
  ]
}

function createTopicPageItems(count: number): ApiTopic[] {
  return Array.from({ length: count }, (_, index) =>
    createApiTopic({
      id: `topic-${index + 1}`,
      name: `Topic ${index + 1}`,
      assistantId: 'assistant-1',
      orderKey: String(index + 1).padStart(3, '0'),
      createdAt: '2026-01-03T01:00:00.000Z',
      updatedAt: '2026-01-03T01:00:00.000Z'
    })
  )
}

/** One topic per time bucket plus the pinned `topic-b`, all in Alpha Assistant's scope. */
function createBucketedTopics(): ApiTopic[] {
  return [
    createApiTopic({
      id: 'topic-a',
      name: 'Alpha topic',
      assistantId: 'assistant-1',
      orderKey: 'a',
      createdAt: '2026-01-03T01:00:00.000Z',
      updatedAt: '2026-01-03T01:00:00.000Z'
    }),
    createApiTopic({
      id: 'topic-b',
      name: 'Beta pinned',
      assistantId: 'assistant-1',
      orderKey: 'b',
      createdAt: '2026-01-02T01:00:00.000Z',
      updatedAt: '2026-01-02T01:00:00.000Z'
    }),
    createApiTopic({
      id: 'topic-yesterday',
      name: 'Yesterday topic',
      assistantId: 'assistant-1',
      orderKey: 'c',
      createdAt: '2026-01-02T05:00:00.000Z',
      updatedAt: '2026-01-02T05:00:00.000Z'
    }),
    createApiTopic({
      id: 'topic-week',
      name: 'Week topic',
      assistantId: 'assistant-1',
      orderKey: 'd',
      createdAt: '2026-01-01T01:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z'
    }),
    createApiTopic({
      id: 'topic-earlier',
      name: 'Earlier topic',
      assistantId: 'assistant-1',
      orderKey: 'e',
      createdAt: '2025-12-20T01:00:00.000Z',
      updatedAt: '2025-12-20T01:00:00.000Z'
    })
  ]
}

function createTopicPin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: 'pin-topic-a',
    entityId: 'topic-a',
    entityType: 'topic',
    orderKey: 'a',
    createdAt: '2026-01-03T12:00:00.000Z',
    updatedAt: '2026-01-03T12:00:00.000Z',
    ...overrides
  }
}

function createAssistant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assistant-1',
    name: 'Alpha Assistant',
    emoji: '🧪',
    orderKey: 'a',
    groupId: 'group-work',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

type OnNewTopicMock = Mock<(payload?: { assistantId?: string | null }) => void>

function createAssistantTopicsSource(topics?: readonly ApiTopic[]): AssistantTopicsSource {
  const source =
    topics !== undefined
      ? {
          pages: [{ items: topics }],
          isLoading: false,
          isRefreshing: false,
          error: undefined,
          hasNext: false,
          loadNext: vi.fn(),
          refresh: vi.fn(),
          reset: vi.fn(),
          mutate: vi.fn()
        }
      : mockUseInfiniteQuery('/topics', { limit: 200 })
  const items = source.pages.flatMap((page) => page.items)

  if (source.hasNext && !source.isLoading && !source.isRefreshing) {
    source.loadNext()
  }

  return {
    error: source.error,
    hasNext: source.hasNext,
    isFullyLoaded: !source.isLoading && !source.hasNext,
    isLoading: source.isLoading,
    isLoadingAll: source.isLoading || source.hasNext,
    isRefreshing: source.isRefreshing,
    loadNext: source.loadNext,
    mutate: source.mutate,
    pages: source.pages,
    refetch: source.refresh,
    topics: items,
    ...deriveAssistantTopicsView(items)
  } as unknown as AssistantTopicsSource
}

function setTopicItems(items: readonly ApiTopic[], options: { hasNext?: boolean; loadNext?: Mock } = {}) {
  mockUseInfiniteQuery.mockReturnValue({
    pages: [{ items: [...items] }],
    isLoading: false,
    isRefreshing: false,
    error: undefined,
    hasNext: options.hasNext ?? false,
    loadNext: options.loadNext ?? vi.fn(),
    refresh: vi.fn(),
    reset: vi.fn(),
    mutate: vi.fn()
  })
}

type TopicListTestProps = {
  activeTopic?: Topic
  /** `null` reads conversations without an assistant; `undefined` (the default) shows nothing. */
  activeAssistantId?: string | null
  assistantTopicsSource?: AssistantTopicsSource
  clearActiveTopic?: Mock<() => void>
  collapseActiveTopic?: boolean
  historyRecordsActive?: ComponentProps<typeof Topics>['historyRecordsActive']
  manageAssistantsActive?: ComponentProps<typeof Topics>['manageAssistantsActive']
  onNewTopic?: OnNewTopicMock
  onOpenHistoryRecords?: Mock<() => void>
  revealRequest?: ResourceListRevealRequest
}

function renderTopicList(initialProps: TopicListTestProps = {}) {
  const setActiveTopic = vi.fn()
  // Spread, not destructuring defaults: an explicit `undefined` scope must stay undefined.
  const props: TopicListTestProps = {
    activeTopic: createRendererTopic(),
    activeAssistantId: 'assistant-1',
    ...initialProps
  }
  props.clearActiveTopic ??= vi.fn()
  props.onNewTopic ??= vi.fn()
  props.onOpenHistoryRecords ??= vi.fn()
  const { clearActiveTopic, onNewTopic, onOpenHistoryRecords } = props
  const renderNode = () => (
    <Topics
      activeTopic={props.collapseActiveTopic ? undefined : props.activeTopic}
      activeAssistantId={props.activeAssistantId}
      assistantTopicsSource={props.assistantTopicsSource ?? createAssistantTopicsSource()}
      clearActiveTopic={clearActiveTopic}
      historyRecordsActive={props.historyRecordsActive}
      manageAssistantsActive={props.manageAssistantsActive}
      onNewTopic={onNewTopic}
      onOpenHistoryRecords={onOpenHistoryRecords}
      revealRequest={props.revealRequest}
      setActiveTopic={setActiveTopic}
    />
  )
  const view = render(renderNode())
  return {
    ...view,
    clearActiveTopic,
    onNewTopic,
    onOpenHistoryRecords,
    rerenderTopicList: (patch: TopicListTestProps = {}) => {
      Object.assign(props, patch)
      return view.rerender(renderNode())
    },
    setActiveTopic
  }
}

function getTopicRow(topicName: string) {
  const row = screen.getByText(topicName).closest('[data-testid="topic-list-row"]')
  expect(row).toBeInTheDocument()
  return row as HTMLElement
}

function deleteTopicRow(row: HTMLElement) {
  fireEvent.click(within(row).getByRole('button', { name: 'Archive' }))
}

const topicStreamStatusCacheKey = (topicId: string) => `topic.stream.statuses.${topicId}` as never
const topicStreamLastSeenCompletionCacheKey = (topicId: string) =>
  `topic.stream.last_seen_completion.${topicId}` as never

function setTopicDraft(topicId: string, text: string) {
  writeChatDraftCache(topicId, {
    text,
    tokens: [],
    files: [],
    knowledgeBaseIds: [],
    mentionedModelIds: [],
    modelMultiSelectMode: false
  })
}

function clearTopicDraftCache(...topicIds: string[]) {
  for (const topicId of topicIds) {
    cacheService.delete(getChatDraftCacheKey(topicId))
  }
}

function setTopicStreamCacheStatus(
  topicId: string,
  status: 'aborted' | 'awaiting-approval' | 'done' | 'error' | 'pending' | 'streaming',
  hasAwaitingApprovalAnchor = false
) {
  cacheService.setShared(topicStreamStatusCacheKey(topicId), {
    status,
    awaitingApprovalAnchors: hasAwaitingApprovalAnchor ? [{ executionId: 'exec-1' }] : []
  } as never)
  cacheService.deleteShared(topicStreamLastSeenCompletionCacheKey(topicId))
}

function clearTopicStreamCache(...topicIds: string[]) {
  for (const topicId of topicIds) {
    cacheService.deleteShared(topicStreamStatusCacheKey(topicId))
    cacheService.deleteShared(topicStreamLastSeenCompletionCacheKey(topicId))
  }
}

describe('Topics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    topicDataMocks.updateTopic.mockReset().mockResolvedValue(undefined)
    topicRenameMocks.getTopicMessages.mockReset().mockResolvedValue([])
    clearPendingTopicImageActionsForTest()
    topicStreamStatusMocks.statuses.clear()
    clearTopicStreamCache('topic-a', 'topic-b', 'topic-c', 'topic-d', 'topic-e')
    clearTopicDraftCache('topic-a', 'topic-b', 'topic-c', 'topic-d', 'topic-e')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 0, 3, 12))
    MockUsePreferenceUtils.resetMocks()
    cacheHookMocks.values.clear()
    imageCaptureTargetsMock.targets = undefined
    setTopicGroupExpansionCache({ time: [] })
    MockUsePreferenceUtils.setMultiplePreferenceValues({
      'assistant.icon_type': 'emoji',
      'data.export.menus.docx': true,
      'data.export.menus.image': true,
      'data.export.menus.joplin': true,
      'data.export.menus.markdown': true,
      'data.export.menus.markdown_reason': true,
      'data.export.menus.notion': true,
      'data.export.menus.obsidian': true,
      'data.export.menus.plain_text': true,
      'data.export.menus.siyuan': true,
      'data.export.menus.yuque': true
    })
    pinMutationMocks.createPin.mockResolvedValue(createTopicPin())
    pinMutationMocks.deletePin.mockResolvedValue(undefined)
    topicDataMocks.clearTopicMessagesTrigger.mockResolvedValue({ deletedIds: ['message-c'] })
    tabsContextMocks.openTab.mockClear()
    tabsContextMocks.setActiveTab.mockClear()
    tabsContextMocks.tabs = []
    windowFrameMocks.mode = 'embedded'
    mockUseMutation.mockImplementation((method, path) => {
      if (method === 'POST' && path === '/pins') {
        return { trigger: pinMutationMocks.createPin, isLoading: false, error: undefined }
      }
      if (method === 'DELETE' && path === '/pins/:id') {
        return { trigger: pinMutationMocks.deletePin, isLoading: false, error: undefined }
      }
      if (method === 'DELETE' && path === '/topics/:topicId/messages') {
        return { trigger: topicDataMocks.clearTopicMessagesTrigger, isLoading: false, error: undefined }
      }
      return { trigger: vi.fn(), isLoading: false, error: undefined }
    })
    mockUseQuery.mockImplementation((path, options) => {
      if (path === '/pins') {
        const entityType = options?.query?.entityType
        const enabled = options?.enabled
        return {
          data:
            enabled === false
              ? undefined
              : entityType === 'assistant'
                ? []
                : [{ id: 'pin-topic-b', entityId: 'topic-b', entityType: 'topic' }],
          isLoading: false,
          isRefreshing: false,
          error: undefined,
          refetch: vi.fn().mockResolvedValue(undefined),
          mutate: vi.fn().mockResolvedValue(undefined)
        }
      }
      if (path === '/assistants') {
        return {
          data: {
            items: [
              createAssistant(),
              createAssistant({
                id: 'assistant-2',
                name: 'Beta Assistant',
                emoji: '✍️',
                orderKey: 'b',
                groupId: 'group-home'
              })
            ],
            total: 2
          },
          isLoading: false,
          isRefreshing: false,
          error: undefined,
          refetch: vi.fn().mockResolvedValue(undefined),
          mutate: vi.fn().mockResolvedValue(undefined)
        }
      }
      return {
        data: undefined,
        isLoading: false,
        isRefreshing: false,
        error: undefined,
        refetch: vi.fn().mockResolvedValue(undefined),
        mutate: vi.fn().mockResolvedValue(undefined)
      }
    })
    setTopicItems([
      createApiTopic({
        id: 'topic-a',
        name: 'Alpha topic',
        assistantId: 'assistant-1',
        orderKey: 'a',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-b',
        name: 'Beta pinned',
        assistantId: 'assistant-1',
        orderKey: 'b',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-c',
        name: 'Gamma topic',
        assistantId: 'assistant-2',
        orderKey: 'c',
        createdAt: '2026-01-01T01:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-e',
        name: 'Epsilon yesterday',
        assistantId: 'assistant-2',
        orderKey: 'e',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-d',
        name: 'Delta archive',
        assistantId: 'assistant-2',
        orderKey: 'd',
        createdAt: '2025-12-20T01:00:00.000Z',
        updatedAt: '2025-12-20T01:00:00.000Z'
      })
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows only the scoped assistant conversations, each with its title and timestamp', () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-a',
        name: 'Alpha topic',
        assistantId: 'assistant-1',
        orderKey: 'a',
        // lastActivityAt deliberately differs from updatedAt: both the "Today" bucket and the
        // row's time line come from when the conversation last happened, not from its edit time.
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2025-12-01T01:00:00.000Z',
        lastActivityAt: '2026-01-03T09:30:00.000Z'
      }),
      createApiTopic({
        id: 'topic-b',
        name: 'Beta pinned',
        assistantId: 'assistant-1',
        orderKey: 'b',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-c',
        name: 'Gamma topic',
        assistantId: 'assistant-2',
        orderKey: 'c',
        createdAt: '2026-01-01T01:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-e',
        name: 'Epsilon yesterday',
        assistantId: 'assistant-2',
        orderKey: 'e',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-d',
        name: 'Delta archive',
        assistantId: 'assistant-2',
        orderKey: 'd',
        createdAt: '2025-12-20T01:00:00.000Z',
        updatedAt: '2025-12-20T01:00:00.000Z'
      })
    ])

    renderTopicList()

    expect(screen.getAllByTestId('topic-list-row')).toHaveLength(2)
    expect(screen.getByText('Alpha topic')).toBeInTheDocument()
    expect(screen.getByText('Beta pinned')).toBeInTheDocument()
    // The other assistant's conversations belong to its own history, not this one.
    expect(screen.queryByText('Gamma topic')).not.toBeInTheDocument()
    expect(screen.queryByText('Epsilon yesterday')).not.toBeInTheDocument()
    expect(screen.queryByText('Delta archive')).not.toBeInTheDocument()

    // Two lines per row: what the conversation is, and when it last happened.
    // 'en-US' + the repo-pinned UTC test timezone render those stamps like this.
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(getTopicRow('Alpha topic')).getByText('01/03, 09:30 AM')).toBeInTheDocument()
    expect(within(getTopicRow('Beta pinned')).getByText('01/02, 01:00 AM')).toBeInTheDocument()
  })

  it('shows conversations without a live assistant when the scope is null, and none when it is undefined', () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-unlinked',
        name: 'Default topic',
        assistantId: undefined,
        orderKey: 'a',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      }),
      // Archived assistants keep their conversations: the FK still points at a row that is no
      // longer in the list, and those conversations must stay reachable somewhere.
      createApiTopic({
        id: 'topic-archived',
        name: 'Archived assistant topic',
        assistantId: 'assistant-archived',
        orderKey: 'b',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-a',
        name: 'Alpha topic',
        assistantId: 'assistant-1',
        orderKey: 'c',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      })
    ])

    const { rerenderTopicList } = renderTopicList({ activeAssistantId: null })

    expect(screen.getByText('Default topic')).toBeInTheDocument()
    expect(screen.getByText('Archived assistant topic')).toBeInTheDocument()
    expect(screen.queryByText('Alpha topic')).not.toBeInTheDocument()

    // No scope is not "every scope": the list renders nothing instead of the whole history.
    rerenderTopicList({ activeAssistantId: undefined })

    expect(screen.queryByText('Default topic')).not.toBeInTheDocument()
    expect(screen.queryByText('Archived assistant topic')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha topic')).not.toBeInTheDocument()
    expect(screen.getByText('No conversations')).toBeInTheDocument()
  })

  it('creates a new conversation in the active scope from the header action', () => {
    const { onNewTopic, rerenderTopicList } = renderTopicList()

    const createButton = screen.getByRole('button', { name: 'chat.conversation.new' })
    expect(createButton).toHaveAttribute('data-ui', 'chat.topic-list.action.create')
    fireEvent.click(createButton)

    expect(onNewTopic).toHaveBeenCalledWith({ assistantId: 'assistant-1' })

    rerenderTopicList({ activeAssistantId: null })
    fireEvent.click(screen.getByRole('button', { name: 'chat.conversation.new' }))

    expect(onNewTopic).toHaveBeenLastCalledWith({ assistantId: null })
  })

  it('keeps the pinned group first and lets each group collapse independently', () => {
    setTopicItems(createBucketedTopics())

    const { rerenderTopicList } = renderTopicList()

    expect(screen.getAllByRole('button', { expanded: true }).map((button) => button.textContent)).toEqual([
      'Pinned',
      'Today',
      'Yesterday',
      'This week',
      'Earlier'
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    rerenderTopicList()

    expect(screen.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Beta pinned')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha topic')).toBeInTheDocument()
    expect(screen.getByText('Earlier topic')).toBeInTheDocument()
  })

  it('restores and persists collapsed topic groups from cache', () => {
    setTopicGroupExpansionCache({ time: [TOPIC_PINNED_GROUP_ID] })

    const { rerenderTopicList } = renderTopicList()

    expect(screen.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Beta pinned')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha topic')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(getTopicGroupExpansionCache().time).toEqual(
      expect.arrayContaining([TOPIC_PINNED_GROUP_ID, 'topic:time:today'])
    )
    rerenderTopicList()
    expect(screen.queryByText('Alpha topic')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    expect(getTopicGroupExpansionCache().time).not.toContain(TOPIC_PINNED_GROUP_ID)
    rerenderTopicList()
    expect(screen.getByText('Beta pinned')).toBeInTheDocument()
  })

  it('hides the inline archive action on pinned rows', () => {
    renderTopicList()

    const pinnedRow = getTopicRow('Beta pinned')
    // Pinned conversations are only reachable through unpinning first.
    expect(within(pinnedRow).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    expect(within(pinnedRow).getByRole('button', { name: 'Unpin Conversation' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    const alphaRow = getTopicRow('Alpha topic')
    expect(within(alphaRow).getByRole('button', { name: 'Archive' })).toBeEnabled()
    expect(within(alphaRow).getByRole('button', { name: 'Pin Conversation' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('pins and unpins from the trailing row button without selecting the topic', async () => {
    const { setActiveTopic } = renderTopicList()

    fireEvent.click(within(getTopicRow('Alpha topic')).getByRole('button', { name: 'Pin Conversation' }))

    await vi.waitFor(() =>
      expect(pinMutationMocks.createPin).toHaveBeenCalledWith({
        body: { entityType: 'topic', entityId: 'topic-a' }
      })
    )
    await act(async () => {})

    fireEvent.click(within(getTopicRow('Beta pinned')).getByRole('button', { name: 'Unpin Conversation' }))

    await vi.waitFor(() => expect(pinMutationMocks.deletePin).toHaveBeenCalledWith({ params: { id: 'pin-topic-b' } }))
    await act(async () => {})
    expect(setActiveTopic).not.toHaveBeenCalled()
  })

  it('moves a topic into the pinned group immediately after pinning without refreshing topics', async () => {
    pinMutationMocks.createPin.mockResolvedValue(createTopicPin())

    const { rerenderTopicList } = renderTopicList()
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    expect(screen.getByText('Alpha topic')).toBeInTheDocument()

    fireEvent.click(within(getTopicRow('Alpha topic')).getByRole('button', { name: 'Pin Conversation' }))
    await vi.waitFor(() => expect(pinMutationMocks.createPin).toHaveBeenCalled())
    await act(async () => {})

    // The row leaves the expanded time bucket as soon as the pin is optimistic — no refetch.
    expect(topicDataMocks.refreshTopics).not.toHaveBeenCalled()
    expect(screen.queryByText('Alpha topic')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    rerenderTopicList()
    expect(screen.getByText('Alpha topic')).toBeInTheDocument()
  })

  it('renames inline with autofocus and reports saved only after persistence succeeds', async () => {
    const pendingUpdate = createDeferred<void>()
    topicDataMocks.updateTopic.mockReturnValueOnce(pendingUpdate.promise)
    renderTopicList()

    fireEvent.doubleClick(screen.getByText('Alpha topic'))
    const input = screen.getByLabelText('Edit conversation name')
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: 'Renamed topic' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Renamed topic')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(topicDataMocks.updateTopic).toHaveBeenCalledWith('topic-a', {
        name: 'Renamed topic',
        isNameManuallyEdited: true
      })
    )
    expect(toast.success).not.toHaveBeenCalled()

    await act(async () => {
      pendingUpdate.resolve(undefined)
    })

    expect(toast.success).toHaveBeenCalledWith('Saved')
  })

  it('shows a context-menu rename optimistically and restores the persisted name when it fails', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    const pendingUpdate = createDeferred<void>()
    topicDataMocks.updateTopic.mockReturnValueOnce(pendingUpdate.promise)
    renderTopicList()

    fireEvent.contextMenu(screen.getByText('Alpha topic'))
    const alphaMenu = screen.getByText('Alpha topic').closest('[data-testid="context-menu"]')
    const menuContent = alphaMenu?.querySelector('[data-testid="context-menu-content"]')
    await act(async () => {
      await user.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Edit conversation name' }))
    })

    const input = within(await screen.findByRole('dialog')).getByLabelText('Name')
    await vi.waitFor(() => expect(input).toHaveValue('Alpha topic'))
    await user.clear(input)
    expect(input).toHaveValue('')
    await user.type(input, 'Renamed topic')
    expect(input).toHaveValue('Renamed topic')
    await act(async () => {
      await user.keyboard('{Enter}')
    })

    expect(topicDataMocks.updateTopic).toHaveBeenCalledWith('topic-a', {
      name: 'Renamed topic',
      isNameManuallyEdited: true
    })

    expect(await screen.findByText('Renamed topic')).toBeInTheDocument()
    expect(screen.queryByText('Alpha topic')).not.toBeInTheDocument()

    await act(async () => {
      pendingUpdate.reject(new Error('rename failed'))
    })

    expect(await screen.findByText('Alpha topic')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith('Error: rename failed')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('clears automatic topic renaming without a success reveal after a failed update', async () => {
    const pendingUpdate = createDeferred<void>()
    topicRenameMocks.getTopicMessages.mockResolvedValueOnce([{}, {}])
    topicDataMocks.updateTopic.mockReturnValueOnce(pendingUpdate.promise)
    renderTopicList()

    fireEvent.contextMenu(screen.getByText('Alpha topic'))
    const alphaMenu = screen.getByText('Alpha topic').closest('[data-testid="context-menu"]')
    const menuContent = alphaMenu?.querySelector('[data-testid="context-menu-content"]')
    await act(async () => {
      fireEvent.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Generate conversation name' }))
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    await vi.waitFor(() =>
      expect(topicDataMocks.updateTopic).toHaveBeenCalledWith('topic-a', {
        name: 'Auto title',
        isNameManuallyEdited: false
      })
    )
    expect(topicRenameMocks.startTopicRenaming).toHaveBeenCalledWith('topic-a')
    expect(topicRenameMocks.cancelTopicRenaming).not.toHaveBeenCalled()
    expect(topicRenameMocks.finishTopicRenaming).not.toHaveBeenCalled()

    await act(async () => {
      pendingUpdate.reject(new Error('Automatic rename failed'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Automatic rename failed'))
    await vi.waitFor(() => expect(topicRenameMocks.cancelTopicRenaming).toHaveBeenCalledWith('topic-a'))
    expect(topicRenameMocks.finishTopicRenaming).not.toHaveBeenCalled()
  })

  it('archives from the shared context menu without opening a confirmation', async () => {
    topicDataMocks.restoreTopic.mockRejectedValueOnce(DataApiErrorFactory.notFound('Topic', 'topic-a'))
    const getActiveTopic = vi.spyOn(dataApiService, 'get').mockResolvedValue({ id: 'topic-a' })
    renderTopicList()

    fireEvent.contextMenu(screen.getByText('Alpha topic'))
    const alphaMenu = screen.getByText('Alpha topic').closest('[data-testid="context-menu"]')
    const menuContent = alphaMenu?.querySelector('[data-testid="context-menu-content"]')
    fireEvent.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Archive' }))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a'))
    expect(confirmActionShow).not.toHaveBeenCalled()
    expect(recycleBinFeedbackMocks.showRecycleBinUndo).toHaveBeenCalledWith({
      itemName: 'Alpha topic',
      title: 'common.archived',
      onUndo: expect.any(Function)
    })

    await expect(recycleBinFeedbackMocks.showRecycleBinUndo.mock.calls.at(-1)?.[0].onUndo()).resolves.toBeUndefined()

    expect(topicDataMocks.restoreTopic).toHaveBeenCalledWith('topic-a')
    expect(getActiveTopic).toHaveBeenCalledWith('/topics/topic-a')
    expect(topicDataMocks.refreshTopics).toHaveBeenCalledOnce()
    getActiveTopic.mockRestore()
  })

  it('reports a stale topic without changing selection or offering Undo', async () => {
    topicDataMocks.deleteTopic.mockRejectedValueOnce(
      new IpcError(trashErrorCodes.TRASH_TARGET_NOT_FOUND, 'Topic already archived')
    )
    const { clearActiveTopic, setActiveTopic } = renderTopicList()

    fireEvent.contextMenu(screen.getByText('Alpha topic'))
    const alphaMenu = screen.getByText('Alpha topic').closest('[data-testid="context-menu"]')
    const menuContent = alphaMenu?.querySelector('[data-testid="context-menu-content"]')
    fireEvent.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Archive' }))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a'))

    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(clearActiveTopic).not.toHaveBeenCalled()
    expect(recycleBinFeedbackMocks.showRecycleBinUndo).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('Already in Recycle Bin')
  })

  it('clears the active topic after deleting the final remaining topic', async () => {
    setTopicItems([createApiTopic({ id: 'topic-a', name: 'Alpha topic', assistantId: 'assistant-1', orderKey: 'a' })])

    const { clearActiveTopic, onNewTopic } = renderTopicList({
      activeTopic: createRendererTopic({ id: 'topic-a', assistantId: 'assistant-1', name: 'Alpha topic' })
    })

    deleteTopicRow(getTopicRow('Alpha topic'))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a'))
    await vi.waitFor(() => expect(clearActiveTopic).toHaveBeenCalledOnce())
    expect(onNewTopic).not.toHaveBeenCalled()
  })

  it('deleting the last unlinked topic selects the latest remaining topic instead of seeding a new unlinked one', async () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-a',
        name: 'Alpha topic',
        assistantId: 'assistant-1',
        orderKey: 'a',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-unlinked',
        name: 'Default topic',
        assistantId: undefined,
        orderKey: 'b',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      })
    ])

    const { onNewTopic, setActiveTopic } = renderTopicList({
      activeAssistantId: null,
      activeTopic: createRendererTopic({ id: 'topic-unlinked', name: 'Default topic', assistantId: undefined })
    })

    deleteTopicRow(getTopicRow('Default topic'))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-unlinked'))
    // "No assistant" is a display fallback, not a real assistant: deleting its last
    // topic must not seed a fresh unlinked topic. Fall back to the latest topic instead.
    await vi.waitFor(() => expect(setActiveTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-a' })))
    expect(onNewTopic).not.toHaveBeenCalled()
  })

  it('deleting the sole unlinked topic clears the active selection', async () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-unlinked',
        name: 'Default topic',
        assistantId: undefined,
        orderKey: 'a'
      })
    ])

    const { clearActiveTopic, onNewTopic } = renderTopicList({
      activeAssistantId: null,
      activeTopic: createRendererTopic({ id: 'topic-unlinked', name: 'Default topic', assistantId: undefined })
    })

    deleteTopicRow(getTopicRow('Default topic'))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-unlinked'))
    await vi.waitFor(() => expect(clearActiveTopic).toHaveBeenCalledOnce())
    expect(onNewTopic).not.toHaveBeenCalled()
  })

  it('selects the same-assistant neighbour after deleting the active topic', async () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-a1-first',
        name: 'A1 First',
        assistantId: 'assistant-1',
        orderKey: 'a',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-a1-second',
        name: 'A1 Second',
        assistantId: 'assistant-1',
        orderKey: 'b',
        createdAt: '2026-01-02T01:00:00.000Z',
        updatedAt: '2026-01-02T01:00:00.000Z'
      }),
      createApiTopic({
        id: 'topic-a2-first',
        name: 'A2 First',
        assistantId: 'assistant-2',
        orderKey: 'c',
        createdAt: '2026-01-01T01:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z'
      })
    ])

    const { setActiveTopic } = renderTopicList({
      activeTopic: createRendererTopic({ id: 'topic-a1-second', assistantId: 'assistant-1', name: 'A1 Second' })
    })

    deleteTopicRow(getTopicRow('A1 Second'))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a1-second'))
    await vi.waitFor(() =>
      expect(setActiveTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-a1-first' }))
    )
    expect(setActiveTopic).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-a2-first' }))
  })

  it('reselects the pre-delete neighbour when the active topic collapses while deletion is in flight', async () => {
    // #19583: the deleted topic's broadcast-triggered by-id refetch 404s while DELETE is
    // still resolving, activeTopic collapses to undefined and the ref mirror becomes ''.
    // The post-delete guard must judge with the selection captured at delete start, not
    // with the mid-race mirror value, otherwise the selection strands on the deleted id
    // and the 404 recovery chain redirects to another assistant.
    setTopicItems([
      createApiTopic({
        id: 'topic-a1-first',
        name: 'A1 First',
        assistantId: 'assistant-1',
        orderKey: 'a'
      }),
      createApiTopic({
        id: 'topic-a1-second',
        name: 'A1 Second',
        assistantId: 'assistant-1',
        orderKey: 'b'
      })
    ])
    let resolveDelete: (() => void) | undefined
    topicDataMocks.deleteTopic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        })
    )
    const { rerenderTopicList, setActiveTopic } = renderTopicList({
      activeTopic: createRendererTopic({ id: 'topic-a1-second', assistantId: 'assistant-1', name: 'A1 Second' })
    })

    deleteTopicRow(getTopicRow('A1 Second'))
    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a1-second'))

    // Simulate the broadcast-race: by-id refetch 404s → activeTopic collapses mid-delete.
    rerenderTopicList({ collapseActiveTopic: true })
    await act(async () => {
      resolveDelete?.()
    })

    await vi.waitFor(() =>
      expect(setActiveTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-a1-first' }))
    )
  })

  it('keeps the empty selection a no-op when deleting an inactive topic', async () => {
    // No selection at all (e.g. a cross-window deletion collapsed the active topic):
    // deleting a background topic must not navigate anywhere.
    setTopicItems([
      createApiTopic({
        id: 'topic-a1-first',
        name: 'A1 First',
        assistantId: 'assistant-1',
        orderKey: 'a'
      }),
      createApiTopic({
        id: 'topic-a1-second',
        name: 'A1 Second',
        assistantId: 'assistant-1',
        orderKey: 'b'
      })
    ])

    const { clearActiveTopic, setActiveTopic } = renderTopicList({ collapseActiveTopic: true })

    deleteTopicRow(getTopicRow('A1 First'))

    await vi.waitFor(() => expect(topicDataMocks.deleteTopic).toHaveBeenCalledWith('topic-a1-first'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(clearActiveTopic).not.toHaveBeenCalled()
  })

  it('clears a non-active topic from its context menu without switching the conversation', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { setActiveTopic } = renderTopicList({ activeAssistantId: 'assistant-2' })

    fireEvent.contextMenu(screen.getByText('Gamma topic'))
    const gammaMenu = screen.getByText('Gamma topic').closest('[data-testid="context-menu"]')
    const menuContent = gammaMenu?.querySelector('[data-testid="context-menu-content"]')
    await user.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Clear messages' }))

    await vi.waitFor(() =>
      expect(topicDataMocks.clearTopicMessagesTrigger).toHaveBeenCalledExactlyOnceWith({
        params: { topicId: 'topic-c' }
      })
    )
    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(confirmActionShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Clear all messages?', okText: 'Confirm', action: expect.any(Function) })
    )
  })

  it('moves a topic to another assistant from the context menu, listing pinned assistants first', async () => {
    const activeTopic = createRendererTopic({ messages: [{ id: 'message-a' } as Topic['messages'][number]] })
    mockUseQuery.mockImplementation((path, options) => {
      if (path === '/pins') {
        return {
          data:
            options?.query?.entityType === 'assistant'
              ? [{ id: 'pin-assistant-3', entityId: 'assistant-3', entityType: 'assistant', orderKey: 'a' }]
              : [{ id: 'pin-topic-b', entityId: 'topic-b', entityType: 'topic' }],
          isLoading: false,
          isRefreshing: false,
          error: undefined,
          refetch: vi.fn().mockResolvedValue(undefined),
          mutate: vi.fn().mockResolvedValue(undefined)
        }
      }
      if (path === '/assistants') {
        return {
          data: {
            items: [
              createAssistant(),
              createAssistant({ id: 'assistant-2', name: 'Beta Assistant', emoji: '✍️', orderKey: 'b' }),
              createAssistant({ id: 'assistant-3', name: 'Gamma Assistant', emoji: '🚀', orderKey: 'c' })
            ],
            total: 3
          },
          isLoading: false,
          isRefreshing: false,
          error: undefined,
          refetch: vi.fn().mockResolvedValue(undefined),
          mutate: vi.fn().mockResolvedValue(undefined)
        }
      }
      return {
        data: undefined,
        isLoading: false,
        isRefreshing: false,
        error: undefined,
        refetch: vi.fn().mockResolvedValue(undefined),
        mutate: vi.fn().mockResolvedValue(undefined)
      }
    })
    const { setActiveTopic } = renderTopicList({ activeTopic })

    fireEvent.contextMenu(screen.getByText('Alpha topic'))
    const alphaMenu = screen.getByText('Alpha topic').closest('[data-testid="context-menu"]')
    const menuContent = alphaMenu?.querySelector('[data-testid="context-menu-content"]') as HTMLElement

    // The destination list mirrors the sidebar: pinned assistants first, and never the current one.
    const targetButtons = within(menuContent)
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text): text is string => text?.includes('Assistant') ?? false)
    expect(targetButtons[0]).toContain('Gamma Assistant')
    expect(targetButtons[1]).toContain('Beta Assistant')
    expect(within(menuContent).queryByRole('button', { name: 'Alpha Assistant' })).not.toBeInTheDocument()

    expect(within(menuContent).getByRole('button', { name: 'Move to' })).toBeInTheDocument()
    fireEvent.click(within(menuContent).getByRole('button', { name: /Beta Assistant/ }))

    await vi.waitFor(() =>
      expect(topicDataMocks.updateTopic).toHaveBeenCalledWith('topic-a', { assistantId: 'assistant-2' })
    )
    expect(setActiveTopic).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'topic-a', assistantId: 'assistant-2', messages: activeTopic.messages })
    )
    expect(toast.success).toHaveBeenCalledWith('Moved 1 conversation(s)')
  })

  it('opens a topic message page in a new app tab, and only a window when detached', async () => {
    const { unmount } = renderTopicList({
      activeAssistantId: 'assistant-2',
      activeTopic: createRendererTopic({ id: 'topic-e', assistantId: 'assistant-2', name: 'Epsilon yesterday' })
    })

    fireEvent.contextMenu(screen.getByText('Gamma topic'))
    const gammaMenu = screen.getByText('Gamma topic').closest('[data-testid="context-menu"]')
    const menuContent = gammaMenu?.querySelector('[data-testid="context-menu-content"]')
    const animationFrameCallbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrameCallbacks.push(callback)
      return animationFrameCallbacks.length
    })

    fireEvent.click(within(menuContent as HTMLElement).getByRole('button', { name: 'Open in new tab' }))

    expect(tabsContextMocks.openTab).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(animationFrameCallbacks.length).toBeGreaterThan(0))
    act(() => {
      for (const callback of animationFrameCallbacks.splice(0)) {
        callback(0)
      }
    })
    expect(tabsContextMocks.openTab).toHaveBeenCalledWith('/app/chat?topicId=topic-c', {
      forceNew: true,
      title: 'Gamma topic'
    })
    requestAnimationFrameSpy.mockRestore()

    // A detached window has no tab bar, so the entry disappears and the window route stays.
    unmount()
    windowFrameMocks.mode = 'window'
    renderTopicList({
      activeAssistantId: 'assistant-2',
      activeTopic: createRendererTopic({ id: 'topic-e', assistantId: 'assistant-2', name: 'Epsilon yesterday' })
    })

    fireEvent.contextMenu(screen.getByText('Gamma topic'))
    const detachedMenu = screen
      .getByText('Gamma topic')
      .closest('[data-testid="context-menu"]')
      ?.querySelector('[data-testid="context-menu-content"]')

    expect(detachedMenu).not.toHaveTextContent('Open in new tab')
    expect(detachedMenu).toHaveTextContent('Open in New Window')
  })

  it('offers the history records action in the list options menu and suppresses row selection while it is active', () => {
    const { onOpenHistoryRecords } = renderTopicList({
      activeTopic: createRendererTopic({ id: 'topic-a', assistantId: 'assistant-1', name: 'Alpha topic' }),
      historyRecordsActive: true
    })

    // A center surface owns the selection, so the list must not double-highlight a row.
    expect(getTopicRow('Alpha topic')).not.toHaveAttribute('data-selected')

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const menu = screen.getByTestId('menu-list')
    const historyAction = within(menu).getByRole('button', { name: 'History' })
    expect(historyAction).toHaveAttribute('data-active', 'true')

    fireEvent.click(historyAction)

    expect(onOpenHistoryRecords).toHaveBeenCalledTimes(1)
  })

  it('shows loading while exporting a right-clicked topic as an image without switching topics', async () => {
    const { setActiveTopic } = renderTopicList({ activeAssistantId: 'assistant-2' })
    fireEvent.contextMenu(screen.getByText('Gamma topic'))
    const gammaMenu = screen.getByText('Gamma topic').closest('[data-testid="context-menu"]')
    const menuContent = gammaMenu?.querySelector('[data-testid="context-menu-content"]')
    const animationFrameCallbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrameCallbacks.push(callback)
      return animationFrameCallbacks.length
    })

    const exportImageItem = within(menuContent as HTMLElement).getByRole('button', { name: 'Export as Image' })
    expect(exportImageItem).not.toBeDisabled()

    fireEvent.click(exportImageItem)

    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(toast.loading).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(animationFrameCallbacks.length).toBeGreaterThan(0))
    act(() => {
      for (const callback of animationFrameCallbacks.splice(0)) {
        callback(0)
      }
    })

    expect(toast.loading).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(/^topic-image-export:/),
        promise: expect.any(Promise),
        title: 'Exporting image. Please stay on this page.'
      })
    )
    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(EventEmitter.emit).not.toHaveBeenCalledWith(
      EVENT_NAMES.EXPORT_TOPIC_IMAGE,
      expect.objectContaining({ id: 'topic-c' })
    )

    const [request] = consumePendingTopicImageActions('topic-c', 'export')
    settleTopicImageActionRequest(request, Promise.resolve())
    await vi.waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Image saved successfully')
    })
    await act(async () => {})
    requestAnimationFrameSpy.mockRestore()
  })

  it('cancels pending topic image requests when the topic list unmounts before runtime consumption', async () => {
    const { unmount } = renderTopicList()
    const request = requestTopicImageAction(
      'export',
      createRendererTopic({ assistantId: 'assistant-2', id: 'topic-c', name: 'Gamma topic' })
    )
    expect(request).toEqual(expect.objectContaining({ topic: expect.objectContaining({ id: 'topic-c' }) }))
    request.promise.catch(() => undefined)

    unmount()

    expect(consumePendingTopicImageActions('topic-c')).toEqual([])
    await expect(request.promise).rejects.toThrow('Topic image export was cancelled')
  })

  it('keeps separate capture hosts for repeated image requests on the same topic', () => {
    imageCaptureTargetsMock.targets = [
      {
        requestId: 1,
        target: createRendererTopic({ assistantId: 'assistant-2', id: 'topic-c', name: 'Gamma topic' })
      },
      {
        requestId: 2,
        target: createRendererTopic({ assistantId: 'assistant-2', id: 'topic-c', name: 'Gamma topic' })
      }
    ]

    renderTopicList()

    const hosts = screen.getAllByTestId('topic-image-capture-host')
    expect(hosts).toHaveLength(2)
    expect(hosts.map((host) => host.getAttribute('data-topic-id'))).toEqual(['topic-c', 'topic-c'])
  })

  it('keeps inactive topic stream indicator visible and opens fulfilled topics', () => {
    setTopicStreamCacheStatus('topic-c', 'pending')
    let view = renderTopicList({ activeAssistantId: 'assistant-2' })
    let setActiveTopic = view.setActiveTopic

    let topicRow = getTopicRow('Gamma topic')
    let indicatorRoot = topicRow.querySelector('[data-testid="topic-stream-indicator"]')
    expect(indicatorRoot).toHaveAccessibleName('Running')
    const runningDeleteButton = within(topicRow).getByRole('button', { name: 'Archive' })
    expect(runningDeleteButton).toBeDisabled()
    fireEvent.click(runningDeleteButton)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(topicDataMocks.deleteTopic).not.toHaveBeenCalled()
    expect(topicStreamStatusMocks.markSeen).not.toHaveBeenCalled()

    act(() => setTopicStreamCacheStatus('topic-c', 'done'))
    view.unmount()
    view = renderTopicList({ activeAssistantId: 'assistant-2' })
    setActiveTopic = view.setActiveTopic
    topicRow = getTopicRow('Gamma topic')
    indicatorRoot = topicRow.querySelector('[data-testid="topic-stream-indicator"]')
    expect(indicatorRoot).toHaveAccessibleName('Done')
    expect(within(topicRow).getByRole('button', { name: 'Archive' })).toBeEnabled()

    fireEvent.click(topicRow)
    expect(setActiveTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-c' }))
    expect(topicStreamStatusMocks.markSeen).not.toHaveBeenCalled()

    act(() => clearTopicStreamCache('topic-c'))
    view.unmount()
    renderTopicList({ activeAssistantId: 'assistant-2' })

    topicRow = getTopicRow('Gamma topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).not.toBeInTheDocument()
    expect(topicRow.querySelector('[aria-label="Pin Conversation"]')).toBeInTheDocument()
  })

  it('shows and clears the draft indicator as draft content changes', () => {
    renderTopicList({ activeAssistantId: 'assistant-2' })

    let topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).queryByRole('img', { name: 'Draft' })).not.toBeInTheDocument()

    act(() => setTopicDraft('topic-c', 'First draft'))

    topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).getByRole('img', { name: 'Draft' })).toBeInTheDocument()

    act(() => setTopicDraft('topic-c', 'Updated draft'))

    expect(within(topicRow).getByRole('img', { name: 'Draft' })).toBeInTheDocument()

    act(() => setTopicDraft('topic-c', ''))

    expect(within(topicRow).queryByRole('img', { name: 'Draft' })).not.toBeInTheDocument()
  })

  it('hides the draft indicator on the active topic', () => {
    renderTopicList({
      activeTopic: createRendererTopic({ id: 'topic-a', assistantId: 'assistant-1', name: 'Alpha topic' })
    })

    // The active row's draft is the text sitting in the composer right below the list.
    act(() => setTopicDraft('topic-a', 'Currently typing'))
    expect(within(getTopicRow('Alpha topic')).queryByRole('img', { name: 'Draft' })).not.toBeInTheDocument()

    act(() => setTopicDraft('topic-b', 'Unsent elsewhere'))
    expect(within(getTopicRow('Beta pinned')).getByRole('img', { name: 'Draft' })).toBeInTheDocument()
  })

  it('shows the draft only after a higher-priority topic status clears', () => {
    setTopicDraft('topic-c', 'Draft while running')
    setTopicStreamCacheStatus('topic-c', 'pending')
    renderTopicList({ activeAssistantId: 'assistant-2' })

    let topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(within(topicRow).queryByRole('img', { name: 'Draft' })).not.toBeInTheDocument()

    act(() => clearTopicStreamCache('topic-c'))

    topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).queryByRole('img', { name: 'Running' })).not.toBeInTheDocument()
    expect(within(topicRow).getByRole('img', { name: 'Draft' })).toBeInTheDocument()
  })

  it('shows an awaiting-approval badge instead of a spinner and keeps the draft suppressed', () => {
    setTopicDraft('topic-c', 'Draft while awaiting approval')
    setTopicStreamCacheStatus('topic-c', 'awaiting-approval')
    let view = renderTopicList({ activeAssistantId: 'assistant-2' })

    let topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).getByTestId('topic-awaiting-approval-badge')).toHaveTextContent('Pending')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).not.toBeInTheDocument()
    expect(within(topicRow).queryByRole('img', { name: 'Draft' })).not.toBeInTheDocument()

    // A live turn waiting for approval reads as the same badge, never as a running spinner.
    view.unmount()
    act(() => setTopicStreamCacheStatus('topic-c', 'streaming', true))
    view = renderTopicList({ activeAssistantId: 'assistant-2' })

    topicRow = getTopicRow('Gamma topic')
    expect(within(topicRow).getByTestId('topic-awaiting-approval-badge')).toHaveTextContent('Pending')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).not.toBeInTheDocument()
  })

  it('announces an errored topic stream and hides aborted streams', () => {
    setTopicStreamCacheStatus('topic-c', 'error')
    let view = renderTopicList({ activeAssistantId: 'assistant-2' })

    let topicRow = getTopicRow('Gamma topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).toHaveAccessibleName('Error')

    act(() => setTopicStreamCacheStatus('topic-c', 'aborted'))
    view.unmount()
    view = renderTopicList({ activeAssistantId: 'assistant-2' })

    topicRow = getTopicRow('Gamma topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).not.toBeInTheDocument()
  })

  it('keeps running and error indicators on the active topic but suppresses its completion dot', () => {
    const activeTopic = createRendererTopic({ id: 'topic-a', assistantId: 'assistant-1', name: 'Alpha topic' })

    setTopicStreamCacheStatus('topic-a', 'pending')
    let view = renderTopicList({ activeTopic })

    let topicRow = getTopicRow('Alpha topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).toHaveAccessibleName('Running')

    act(() => setTopicStreamCacheStatus('topic-a', 'error'))
    view.unmount()
    view = renderTopicList({ activeTopic })

    topicRow = getTopicRow('Alpha topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).toHaveAccessibleName('Error')

    act(() => setTopicStreamCacheStatus('topic-a', 'done'))
    view.unmount()
    renderTopicList({ activeTopic })

    topicRow = getTopicRow('Alpha topic')
    expect(topicRow.querySelector('[data-testid="topic-stream-indicator"]')).not.toBeInTheDocument()
  })

  it('marks only completed active topic streams as seen', () => {
    topicStreamStatusMocks.statuses.set('topic-a', { isPending: true })
    const { rerenderTopicList } = renderTopicList()

    expect(topicStreamStatusMocks.markSeen).not.toHaveBeenCalled()

    topicStreamStatusMocks.statuses.set('topic-a', { isFulfilled: true })
    rerenderTopicList()

    expect(topicStreamStatusMocks.markSeen).toHaveBeenCalledTimes(1)
    expect(topicStreamStatusMocks.markSeen).toHaveBeenCalledWith('topic-a')
  })

  it('subscribes topic stream status only for rows visible in the ResourceList view', () => {
    setTopicItems(createTopicPageItems(51))
    const subscribeSpy = vi.spyOn(cacheService, 'subscribe')

    try {
      renderTopicList()

      const subscribedKeys = subscribeSpy.mock.calls.map(([key]) => key)
      expect(subscribedKeys).toContain(topicStreamStatusCacheKey('topic-50'))
      expect(subscribedKeys).toContain(topicStreamLastSeenCompletionCacheKey('topic-50'))
      expect(subscribedKeys).not.toContain(topicStreamStatusCacheKey('topic-51'))
      expect(subscribedKeys).not.toContain(topicStreamLastSeenCompletionCacheKey('topic-51'))
    } finally {
      subscribeSpy.mockRestore()
    }
  })

  it('shows the first topic page while the remaining pages load', () => {
    setTopicItems(
      [createApiTopic({ id: 'topic-first-page', name: 'First page topic', assistantId: 'assistant-1', orderKey: 'a' })],
      {
        hasNext: true
      }
    )

    renderTopicList()

    expect(screen.getByTestId('resource-list-topic')).toBeInTheDocument()
    expect(screen.getByText('First page topic')).toBeInTheDocument()
    expect(screen.queryAllByTestId('topic-list-row')).toHaveLength(1)
    expect(document.querySelectorAll('[data-resource-list-loading-group]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-resource-list-loading-item]')).toHaveLength(0)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('reveals a history-selected topic hidden by show-more', async () => {
    setTopicGroupExpansionCache({
      // Collapse everything except "today".
      time: ALL_TOPIC_TIME_GROUP_IDS.filter((id) => id !== 'topic:time:today')
    })
    setTopicItems(withEarlierTopic(createTopicPageItems(51)))

    const { rerenderTopicList } = renderTopicList()

    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText('Topic 51')).not.toBeInTheDocument()

    rerenderTopicList({ revealRequest: { itemId: 'topic-51', requestId: 1, clearFilters: true, clearQuery: true } })

    expect(await screen.findByText('Topic 51')).toBeInTheDocument()
    const revealedRow = screen.getByText('Topic 51').closest('[role="option"]')
    expect(revealedRow).not.toBeNull()
    expect(revealedRow!).toHaveAttribute('data-reveal-focus', 'true')
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-expanded', 'true')
    expect(virtualMocks.scrollToIndex).toHaveBeenCalledWith(expect.any(Number), { align: 'center' })
  })

  it('expands a long time bucket with one click and collapses back', async () => {
    const user = userEvent.setup()
    setTopicItems(withEarlierTopic(createTopicPageItems(56)))

    renderTopicList()

    expect(screen.getByText('Topic 50')).toBeInTheDocument()
    expect(screen.queryByText('Topic 51')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show more conversations' }))

    expect(screen.getByText('Topic 56')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more conversations' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse conversations' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse conversations' }))

    expect(screen.getByText('Topic 50')).toBeInTheDocument()
    expect(screen.queryByText('Topic 51')).not.toBeInTheDocument()
  })

  it('offers a retry entry point when a background refresh fails behind a served list', () => {
    const assistantTopicsSource = createAssistantTopicsSource(createTopicPageItems(3))
    Object.assign(assistantTopicsSource, { refreshError: new Error('refresh failed') })

    renderTopicList({ assistantTopicsSource })

    // The stale list stays on screen; the failure gets its own non-destructive strip.
    expect(getTopicRow('Topic 1')).not.toBeNull()
    const retryButton = screen.getByRole('button', { name: 'common.retry' })

    fireEvent.click(retryButton)

    expect(assistantTopicsSource.refetch).toHaveBeenCalled()
  })

  it('shows a new conversation placeholder for empty topic names', () => {
    setTopicItems([
      createApiTopic({
        id: 'topic-empty',
        name: '',
        assistantId: 'assistant-1',
        orderKey: 'a',
        createdAt: '2026-01-03T01:00:00.000Z',
        updatedAt: '2026-01-03T01:00:00.000Z'
      })
    ])
    const { setActiveTopic } = renderTopicList()

    const row = screen.getByTestId('topic-list-row')
    expect(within(row).getByText('chat.conversation.new')).toBeInTheDocument()

    fireEvent.click(row)

    expect(setActiveTopic).toHaveBeenCalledWith(expect.objectContaining({ id: 'topic-empty', name: '' }))
  })
})
