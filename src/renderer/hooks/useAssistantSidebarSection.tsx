import { Archive, BrushCleaning, Edit3, PinIcon, PinOffIcon, Plus, Smile, Tags } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import { useSidebarNavigationSnapshot } from '@renderer/components/app/sidebarShortcuts'
import { actionsToCommandMenuExtraItems } from '@renderer/components/chat/actions/actionMenuItems'
import type { ResolvedAction } from '@renderer/components/chat/actions/actionTypes'
import { deleteConversationOwnerPopup } from '@renderer/components/chat/DeleteConversationOwnerConfirmDialog'
import {
  buildResolvedIconTypeMenuAction,
  buildResolvedResourceEntityMenuAction,
  compareResourceOrderKey,
  renderAssistantEntityIcon,
  type ResourceListOrderAnchor
} from '@renderer/components/chat/resourceList/base'
import {
  ResourceEditDialogHost,
  type ResourceEditDialogTarget
} from '@renderer/components/resourceCatalog/dialogs/edit'
import type { SidebarSection } from '@renderer/components/Sidebar'
import { dataApiService } from '@renderer/data/DataApiService'
import { useMutation } from '@renderer/data/hooks/useDataApi'
import { useCloseConversationTabs } from '@renderer/hooks/tab'
import { useAssistantMutations, useAssistantsApi } from '@renderer/hooks/useAssistant'
import { useAssistantNavigation } from '@renderer/hooks/useAssistantNavigation'
import { useGroups } from '@renderer/hooks/useGroups'
import { usePins } from '@renderer/hooks/usePins'
import { useTopicMutations } from '@renderer/hooks/useTopic'
import {
  restoreRecycleBinItems,
  restoreRecycleBinUndoGroup,
  showRecycleBinBatchUndo,
  showRecycleBinUndo
} from '@renderer/services/recycleBinFeedback'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { AssistantIconType } from '@shared/data/preference/preferenceTypes'
import { isTrashTargetNotFoundError, isTrashTopicBusyError } from '@shared/ipc/errors/trash'

const logger = loggerService.withContext('useAssistantSidebarSection')

const UNGROUPED_ASSISTANT_GROUP_KEY = 'assistant-group:ungrouped'
const FLAT_GROUP_KEY = 'assistant-group:flat'

type AssistantEntity = ReturnType<typeof useAssistantsApi>['assistants'][number]

/**
 * The sidebar's assistant list: every assistant, pinned first, in the user's drag order (or grouped
 * when the assistant list is grouped). Selecting one opens its conversation — the assistant owns its
 * topics, so this is the entity half of that hierarchy and the chat list is the other half.
 *
 * Group *membership* is edited where groups live (the assistant library); this list only decides how
 * grouping reads, which is why a grouped list is not drag-reorderable.
 */
export function useAssistantSidebarSection({ onAddAssistant }: { onAddAssistant: () => void }) {
  const { t } = useTranslation()
  const [assistantSortType, setAssistantSortType] = usePreference('assistant.tab.sort_type')
  const [assistantIconType, setAssistantIconType] = usePreference('assistant.icon_type')
  const [defaultModelId] = usePreference('chat.default_model_id')
  const isGrouped = assistantSortType === 'tags'
  const { openAssistant, cancelOpenAssistant } = useAssistantNavigation()
  const navigation = useSidebarNavigationSnapshot()
  const closeConversationTabs = useCloseConversationTabs()

  const { assistants, refetch: refreshAssistants } = useAssistantsApi()
  const { groups: assistantGroups } = useGroups('assistant', { enabled: isGrouped })
  const {
    isLoading: isPinsLoading,
    isRefreshing: isPinsRefreshing,
    isMutating: isPinsMutating,
    pinnedIds,
    togglePin
  } = usePins('assistant')
  const { deleteAssistant, restoreAssistant } = useAssistantMutations()
  const { deleteTopicsByAssistantId, refreshTopics, restoreTopic } = useTopicMutations()

  const [editDialogTarget, setEditDialogTarget] = useState<ResourceEditDialogTarget | null>(null)
  const [deletingAssistantId, setDeletingAssistantId] = useState<string | null>(null)
  const [clearingTopicsAssistantId, setClearingTopicsAssistantId] = useState<string | null>(null)
  const [optimisticOrderIds, setOptimisticOrderIds] = useState<readonly string[] | null>(null)

  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const isPinActionDisabled = isPinsLoading || isPinsRefreshing || isPinsMutating
  const { trigger: reorderAssistantOrder } = useMutation('PATCH', '/assistants/:id/order', { refresh: ['/assistants'] })

  // Drag order is a local overlay: it clears as soon as the persisted order arrives.
  const orderSignature = useMemo(
    () => assistants.map((assistant) => `${assistant.id}:${assistant.orderKey ?? ''}`).join('|'),
    [assistants]
  )
  const [signature, setSignature] = useState(orderSignature)
  if (signature !== orderSignature) {
    setSignature(orderSignature)
    setOptimisticOrderIds(null)
  }

  const orderedAssistants = useMemo(() => {
    const byOrderKey = [...assistants].sort((a, b) => compareResourceOrderKey(a.orderKey, b.orderKey))
    const byOptimisticOrder = optimisticOrderIds
      ? (() => {
          const byId = new Map(byOrderKey.map((assistant) => [assistant.id, assistant]))
          const optimistic = optimisticOrderIds.flatMap((id) => {
            const assistant = byId.get(id)
            return assistant ? [assistant] : []
          })
          const optimisticIdSet = new Set(optimisticOrderIds)
          return [...optimistic, ...byOrderKey.filter((assistant) => !optimisticIdSet.has(assistant.id))]
        })()
      : byOrderKey
    const pinned = byOptimisticOrder.filter((assistant) => pinnedIdSet.has(assistant.id))
    if (pinned.length === 0) return byOptimisticOrder
    return [...pinned, ...byOptimisticOrder.filter((assistant) => !pinnedIdSet.has(assistant.id))]
  }, [assistants, optimisticOrderIds, pinnedIdSet])

  const renderAssistantIcon = useCallback(
    (assistant: AssistantEntity, presentation: { slotSize: number; glyphSize: number }) =>
      renderAssistantEntityIcon(
        assistantIconType,
        { emoji: assistant.emoji, modelId: assistant.modelId, modelName: assistant.modelName },
        defaultModelId,
        presentation.slotSize,
        presentation.glyphSize
      ),
    [assistantIconType, defaultModelId]
  )

  const handleReorder = useCallback(
    ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      const ids = orderedAssistants.map((assistant) => assistant.id)
      const activeId = ids[oldIndex]
      if (!activeId || oldIndex === newIndex) return

      const rest = ids.filter((id) => id !== activeId)
      const nextId = rest[newIndex]
      const anchor: ResourceListOrderAnchor = nextId ? { before: nextId } : { position: 'last' }
      setOptimisticOrderIds([...rest.slice(0, newIndex), activeId, ...rest.slice(newIndex)])

      void reorderAssistantOrder({ params: { id: activeId }, body: anchor })
        .then(() => refreshAssistants())
        .catch((error: unknown) => {
          logger.error('Failed to reorder the sidebar assistant list', { error })
          setOptimisticOrderIds(null)
          toast.error(formatErrorMessageWithPrefix(error, t('assistants.reorder.error.failed')))
          return refreshAssistants().catch(() => undefined)
        })
    },
    [orderedAssistants, refreshAssistants, reorderAssistantOrder, t]
  )

  const openAssistantEditor = useCallback((assistantId: string) => {
    setEditDialogTarget({ kind: 'assistant', id: assistantId })
  }, [])

  const handleTogglePin = useCallback(
    async (assistantId: string) => {
      if (isPinActionDisabled) return
      try {
        await togglePin(assistantId)
        await refreshAssistants()
      } catch (error) {
        logger.error('Failed to toggle an assistant pin from the sidebar', { assistantId, error })
        toast.error(t('common.error'))
      }
    },
    [isPinActionDisabled, refreshAssistants, t, togglePin]
  )

  const handleClearTopics = useCallback(
    async (assistantId: string) => {
      if (clearingTopicsAssistantId || deletingAssistantId) return
      setClearingTopicsAssistantId(assistantId)
      try {
        const result = await deleteTopicsByAssistantId(assistantId)
        if (result.deletedIds.length === 0) {
          await refreshTopics().catch(() => undefined)
          toast.info(t('recycle_bin.already_moved'))
          return
        }

        const deletedIds = [...result.deletedIds]
        showRecycleBinBatchUndo({
          itemCount: deletedIds.length,
          onUndo: () =>
            restoreRecycleBinItems({
              ids: deletedIds,
              restore: restoreTopic,
              getActive: (id) => dataApiService.get(`/topics/${id}`),
              refresh: refreshTopics
            })
        })
        await refreshTopics().catch(() => undefined)
      } catch (error) {
        logger.error('Failed to clear an assistant’s topics from the sidebar', { assistantId, error })
        if (isTrashTopicBusyError(error)) toast.info(t('recycle_bin.move.blocked_generation'))
        else if (isTrashTargetNotFoundError(error)) toast.info(t('recycle_bin.already_moved'))
        else toast.error(t('chat.topics.manage.delete.error'))
      } finally {
        setClearingTopicsAssistantId(null)
      }
    },
    [clearingTopicsAssistantId, deleteTopicsByAssistantId, deletingAssistantId, refreshTopics, restoreTopic, t]
  )

  const refreshAfterOwnerRestore = useCallback(async () => {
    const outcomes = await Promise.allSettled([refreshAssistants(), refreshTopics()])
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.warn('Failed to refresh assistants and topics after a sidebar restore', { error: outcome.reason })
      }
    }
  }, [refreshAssistants, refreshTopics])

  const handleDeleteAssistant = useCallback(
    async (assistant: AssistantEntity) => {
      if (deletingAssistantId) return
      const performDelete = async (deleteTopics: boolean) => {
        setDeletingAssistantId(assistant.id)
        try {
          let result: Awaited<ReturnType<typeof deleteAssistant>>
          try {
            result = await deleteAssistant(assistant.id, { deleteTopics })
          } catch (error) {
            if (!isTrashTargetNotFoundError(error)) throw error
            await Promise.allSettled([refreshAssistants(), refreshTopics()])
            toast.info(t('recycle_bin.already_moved'))
            return
          }
          if (!result.deleted) {
            await Promise.allSettled([refreshAssistants(), refreshTopics()])
            toast.info(t('recycle_bin.already_moved'))
            return
          }

          const deletedTopicIds = result.deletedTopicIds ?? []
          if (deletedTopicIds.length > 0) closeConversationTabs('assistants', deletedTopicIds)
          // The assistant's conversation may be the one on screen; the chat page settles itself when
          // the bound topic 404s, so this only drops any in-flight open for the deleted assistant.
          cancelOpenAssistant()
          showRecycleBinUndo({
            itemName: assistant.name,
            onUndo: () =>
              restoreRecycleBinUndoGroup({
                primary: {
                  id: assistant.id,
                  restore: restoreAssistant,
                  getActive: (id) => dataApiService.get(`/assistants/${id}`)
                },
                related: {
                  ids: deletedTopicIds,
                  restore: restoreTopic,
                  getActive: (id) => dataApiService.get(`/topics/${id}`)
                },
                refresh: refreshAfterOwnerRestore
              })
          })
          await refreshAfterOwnerRestore()
        } catch (error) {
          logger.error('Failed to delete an assistant from the sidebar', { assistantId: assistant.id, error })
          if (isTrashTopicBusyError(error)) {
            toast.info(t('recycle_bin.move.blocked_generation'))
            return
          }
          throw error
        } finally {
          setDeletingAssistantId(null)
        }
      }

      await deleteConversationOwnerPopup.show({ type: 'assistant', action: performDelete })
    },
    [
      cancelOpenAssistant,
      closeConversationTabs,
      deleteAssistant,
      deletingAssistantId,
      refreshAfterOwnerRestore,
      refreshAssistants,
      refreshTopics,
      restoreAssistant,
      restoreTopic,
      t
    ]
  )

  const getContextMenuActions = useCallback(
    (assistant: AssistantEntity): ResolvedAction[] => {
      const pinned = pinnedIdSet.has(assistant.id)
      return [
        buildResolvedResourceEntityMenuAction({
          id: 'assistant-sidebar.edit',
          label: t('assistants.edit.title'),
          icon: <Edit3 size={14} />,
          order: 10
        }),
        buildResolvedResourceEntityMenuAction({
          id: 'assistant-sidebar.toggle-pin',
          label: pinned ? t('assistants.unpin.title') : t('assistants.pin.title'),
          icon: pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
          order: 20,
          availability: { visible: true, enabled: !isPinActionDisabled }
        }),
        buildResolvedResourceEntityMenuAction({
          id: 'assistant-sidebar.clear-topics',
          label: t('assistants.clear.menu_title'),
          icon: <BrushCleaning size={14} />,
          order: 25,
          availability: { visible: true, enabled: !clearingTopicsAssistantId && !deletingAssistantId }
        }),
        buildResolvedIconTypeMenuAction(
          'assistant-sidebar.icon-type',
          t('assistants.icon.type'),
          <Smile size={14} />,
          30,
          assistantIconType,
          t
        ),
        buildResolvedResourceEntityMenuAction({
          id: 'assistant-sidebar.toggle-grouping',
          label: isGrouped ? t('assistants.groups.ungroup') : t('assistants.groups.group_by'),
          icon: <Tags size={14} />,
          order: 35
        }),
        buildResolvedResourceEntityMenuAction({
          id: 'assistant-sidebar.archive',
          label: t('common.archive'),
          icon: <Archive size={14} />,
          group: 'danger',
          order: 40,
          availability: { visible: true, enabled: deletingAssistantId === null }
        })
      ]
    },
    [assistantIconType, clearingTopicsAssistantId, deletingAssistantId, isGrouped, isPinActionDisabled, pinnedIdSet, t]
  )

  const handleContextMenuAction = useCallback(
    (assistant: AssistantEntity, action: ResolvedAction) => {
      if (action.id === 'assistant-sidebar.edit') {
        openAssistantEditor(assistant.id)
        return
      }
      if (action.id === 'assistant-sidebar.toggle-pin') {
        void handleTogglePin(assistant.id)
        return
      }
      if (action.id === 'assistant-sidebar.clear-topics') {
        void handleClearTopics(assistant.id)
        return
      }
      if (action.id === 'assistant-sidebar.toggle-grouping') {
        void setAssistantSortType(isGrouped ? 'list' : 'tags')
        return
      }
      if (action.id === 'assistant-sidebar.archive') {
        void handleDeleteAssistant(assistant)
        return
      }
      if (action.id.startsWith('assistant-sidebar.icon-type.')) {
        void setAssistantIconType(action.id.slice('assistant-sidebar.icon-type.'.length) as AssistantIconType)
      }
    },
    [
      handleClearTopics,
      handleDeleteAssistant,
      handleTogglePin,
      isGrouped,
      openAssistantEditor,
      setAssistantIconType,
      setAssistantSortType
    ]
  )

  const groups = useMemo(() => {
    const toEntry = (assistant: AssistantEntity) => {
      const open = (newTab?: boolean) => () => void openAssistant({ id: assistant.id, name: assistant.name, newTab })
      return {
        key: `assistant:${assistant.id}`,
        label: assistant.name,
        renderIcon: (presentation: { slotSize: number; glyphSize: number }) =>
          renderAssistantIcon(assistant, presentation),
        isActive: navigation.assistantId === assistant.id,
        onOpen: open(),
        onOpenNewTab: open(true),
        contextMenuItems: actionsToCommandMenuExtraItems(getContextMenuActions(assistant), (action) =>
          handleContextMenuAction(assistant, action)
        )
      }
    }

    if (!isGrouped) {
      return [{ key: FLAT_GROUP_KEY, entries: orderedAssistants.map(toEntry) }]
    }

    const buckets = new Map<string, { label?: string; orderKey?: string; entries: ReturnType<typeof toEntry>[] }>()
    for (const assistant of orderedAssistants) {
      const group = assistant.groupId
        ? assistantGroups.find((candidate) => candidate.id === assistant.groupId)
        : undefined
      const bucketKey = group?.id ?? UNGROUPED_ASSISTANT_GROUP_KEY
      const bucket = buckets.get(bucketKey) ?? { label: group?.name, orderKey: group?.orderKey, entries: [] }
      bucket.entries.push(toEntry(assistant))
      buckets.set(bucketKey, bucket)
    }

    return [...buckets.entries()]
      .sort(([, a], [, b]) => {
        // Assistants without a group read last, after every named group.
        if (!a.orderKey) return b.orderKey ? 1 : 0
        if (!b.orderKey) return -1
        return compareResourceOrderKey(a.orderKey, b.orderKey)
      })
      .map(([key, bucket]) => ({ key, label: bucket.label, entries: bucket.entries }))
  }, [
    assistantGroups,
    getContextMenuActions,
    handleContextMenuAction,
    isGrouped,
    navigation.assistantId,
    openAssistant,
    orderedAssistants,
    renderAssistantIcon
  ])

  const section = useMemo<SidebarSection>(
    () => ({
      key: 'assistants',
      title: t('assistants.title'),
      action: { label: t('chat.add.assistant.title'), icon: <Plus size={14} />, onClick: onAddAssistant },
      groups,
      onEntriesReorder: isGrouped ? undefined : handleReorder
    }),
    [groups, handleReorder, isGrouped, onAddAssistant, t]
  )

  const editDialogHost = (
    <ResourceEditDialogHost
      target={editDialogTarget}
      onOpenChange={(open) => {
        if (!open) setEditDialogTarget(null)
      }}
    />
  )

  return { section, editDialogHost }
}
