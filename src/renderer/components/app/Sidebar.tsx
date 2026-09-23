import { arrayMove } from '@dnd-kit/sortable'
import { CircleOff, LoaderCircle, WifiOff } from 'lucide-react'
import type { Ref } from 'react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { startTransition, useOptimistic } from 'react'
import { useTranslation } from 'react-i18next'

import { usePersistCache } from '@data/hooks/useCache'
import { usePreference } from '@data/hooks/usePreference'
import { useTabs } from '@renderer/hooks/tab'
import { useAssistants, useAssistantsApi } from '@renderer/hooks/useAssistant'
import { toCreateAssistantDtoFromCatalogPreset } from '@renderer/hooks/useAssistantCatalogPresets'
import { useAssistantNavigation } from '@renderer/hooks/useAssistantNavigation'
import { useAssistantSidebarSection } from '@renderer/hooks/useAssistantSidebarSection'
import useAvatar from '@renderer/hooks/useAvatar'
import { useSidebarShortcuts } from '@renderer/hooks/useSidebarShortcuts'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { getSidebarApp, tabBelongsToApp } from '@renderer/utils/sidebar'

import { SidebarShellActions } from '../layout/ShellTabBarActions'
import {
  getSidebarDisplayWidth,
  getSidebarLayout,
  normalizeSidebarWidth,
  type ResolvedSidebarEntry,
  type SidebarIconPresentation,
  type SidebarUser,
  type SidebarVisibleLayout,
  Sidebar as UISidebar,
  UserAvatar
} from '../Sidebar'
import UserPopup from '../UserPopup'
import {
  AssistantConversationPickerDialog,
  type AssistantConversationSelection
} from './AssistantConversationPickerDialog'
import {
  useResolvedSidebarShortcuts,
  useSidebarShortcutActivation,
  useSidebarNavigationSnapshot,
  useSidebarShortcutRegistry
} from './sidebarShortcuts'

const FeedbackDialog = lazy(() => import('../feedback/FeedbackDialog'))

function applyEntryOrder(entries: ResolvedSidebarEntry[], orderedKeys: readonly string[]): ResolvedSidebarEntry[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  const optimisticKeys = new Set(orderedKeys)
  return [
    ...orderedKeys.flatMap((key) => {
      const entry = byKey.get(key)
      return entry ? [entry] : []
    }),
    ...entries.filter((entry) => !optimisticKeys.has(entry.key))
  ]
}

export default function Sidebar({
  ref,
  isFullscreen = false
}: {
  ref?: Ref<HTMLDivElement | null>
  isFullscreen?: boolean
}) {
  const { t } = useTranslation()
  const [userName] = usePreference('app.user.name')
  const { shortcuts, remove, reorder } = useSidebarShortcuts()
  const registry = useSidebarShortcutRegistry()
  const resolutions = useResolvedSidebarShortcuts(shortcuts, registry)
  const activateShortcut = useSidebarShortcutActivation()
  const navigation = useSidebarNavigationSnapshot()

  const [sidebarWidth, setSidebarWidth] = usePersistCache('ui.sidebar.width')
  const [previewSidebarWidth, setPreviewSidebarWidth] = useState<number | null>(null)
  const [feedbackDialogMounted, setFeedbackDialogMounted] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const activeSidebarWidth = previewSidebarWidth ?? sidebarWidth

  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${getSidebarDisplayWidth(activeSidebarWidth)}px`)
  }, [activeSidebarWidth])

  useEffect(() => {
    if (previewSidebarWidth !== null) return
    const normalizedWidth = normalizeSidebarWidth(sidebarWidth)
    if (normalizedWidth !== sidebarWidth) setSidebarWidth(normalizedWidth)
  }, [previewSidebarWidth, setSidebarWidth, sidebarWidth])

  const avatar = useAvatar()
  const sidebarUser = useMemo<SidebarUser>(
    () => ({
      name: userName || t('chat.user', { defaultValue: t('export.user', { defaultValue: 'User' }) }),
      avatar: avatar || undefined,
      onClick: () => UserPopup.show()
    }),
    [avatar, t, userName]
  )
  const sidebarLogo = useMemo(
    () => <UserAvatar user={sidebarUser} className="h-full w-full" ring={false} />,
    [sidebarUser]
  )

  const { assistants } = useAssistantsApi()
  const { addAssistant } = useAssistants()
  const { openAssistant } = useAssistantNavigation()
  const { activeTab, openTab } = useTabs()
  const [assistantPickerOpen, setAssistantPickerOpen] = useState(false)

  const handleAssistantSelect = useCallback(
    async (selection: AssistantConversationSelection) => {
      setAssistantPickerOpen(false)
      try {
        if (selection.type === 'assistant') {
          const assistant = assistants.find((candidate) => candidate.id === selection.assistantId)
          await openAssistant({ id: selection.assistantId, name: assistant?.name ?? '' })
          return
        }

        // Reuse an assistant already created from this preset (matched by name — the only persistent
        // link a preset has) instead of creating a duplicate every time it is picked.
        const presetName = selection.preset.name.trim()
        const existing = assistants.find((assistant) => assistant.name === presetName)
        const assistant = existing ?? (await addAssistant(toCreateAssistantDtoFromCatalogPreset(selection.preset)))
        await openAssistant({ id: assistant.id, name: assistant.name })
      } catch (error) {
        toast.error(formatErrorMessageWithPrefix(error, t('common.error')))
      }
    },
    [addAssistant, assistants, openAssistant, t]
  )

  const openAssistantsLibrary = useCallback(() => {
    const chatApp = getSidebarApp('assistants')!
    if (activeTab && tabBelongsToApp(chatApp, activeTab.url)) {
      void EventEmitter.emit(EVENT_NAMES.OPEN_ASSISTANTS_LIBRARY, { tabId: activeTab.id })
      return
    }
    // The library is a surface of the chat page, so with no chat tab on screen, land there first.
    openTab(chatApp.routePrefix)
  }, [activeTab, openTab])

  const { section: assistantSection, editDialogHost: assistantEditDialogHost } = useAssistantSidebarSection({
    onAddAssistant: () => setAssistantPickerOpen(true),
    onOpenLibrary: openAssistantsLibrary
  })

  const [hoverVisible, setHoverVisible] = useState(false)
  const layout = getSidebarLayout(activeSidebarWidth)
  const resolvedEntries = useMemo(
    () =>
      resolutions.map((resolution) => {
        const { shortcut } = resolution
        const provider = registry.resolve(shortcut.target)
        const isResolved = resolution.status === 'resolved'
        const label = isResolved
          ? resolution.resource.label
          : shortcut.fallbackLabel || shortcut.target.locator.resourceId
        const renderIcon = isResolved
          ? resolution.resource.renderIcon
          : ({ glyphSize }: SidebarIconPresentation) => {
              const Icon =
                resolution.status === 'loading' ? LoaderCircle : resolution.status === 'missing' ? CircleOff : WifiOff
              return (
                <Icon
                  size={glyphSize}
                  strokeWidth={1.6}
                  className={resolution.status === 'loading' ? 'animate-spin' : undefined}
                />
              )
            }
        const activate = (inNewTab = false) => {
          if (!isResolved || !provider) return
          void activateShortcut(provider, shortcut.target, resolution.resource, inNewTab).catch(() =>
            toast.error(t('common.error'))
          )
        }
        const activateInNewTab =
          isResolved && provider && resolution.resource.supportsNewTab ? () => activate(true) : undefined

        return {
          key: shortcut.id,
          label,
          renderIcon,
          disabled: !isResolved || !provider,
          isActive: !!provider?.isActive?.(shortcut.target, navigation),
          statusLabel: isResolved
            ? undefined
            : resolution.status === 'loading'
              ? t('common.loading')
              : resolution.status === 'missing'
                ? t('sidebar.resource_missing')
                : t('sidebar.resource_unavailable'),
          onOpen: () => activate(),
          onOpenNewTab: activateInNewTab,
          contextMenuItems: [
            ...(activateInNewTab
              ? [
                  {
                    type: 'item' as const,
                    id: `sidebar.open-in-new-tab.${shortcut.id}`,
                    label: t('common.open_in_new_tab'),
                    onSelect: activateInNewTab
                  }
                ]
              : []),
            {
              type: 'item' as const,
              id: `sidebar.remove.${shortcut.id}`,
              label: t('launchpad.unpin_from_sidebar'),
              onSelect: () => remove(shortcut.target)
            }
          ]
        }
      }),
    [activateShortcut, navigation, registry, remove, resolutions, shortcuts, t]
  )
  const [entries, setOptimisticEntryOrder] = useOptimistic(resolvedEntries, applyEntryOrder)

  const handleReorder = useCallback(
    ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      if (oldIndex === newIndex) return
      const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]))
      const reorderedEntries = arrayMove(entries, oldIndex, newIndex)
      const reorderedShortcuts = reorderedEntries.flatMap((entry) => {
        const shortcut = byId.get(entry.key)
        return shortcut ? [shortcut] : []
      })
      startTransition(async () => {
        setOptimisticEntryOrder(reorderedEntries.map((entry) => entry.key))
        await reorder(reorderedShortcuts).catch(() => undefined)
      })
    },
    [entries, reorder, setOptimisticEntryOrder, shortcuts]
  )

  const handleOpenSettingsTab = useCallback(() => openSettingsTab(), [])
  const handleOpenFeedback = useCallback(() => {
    setFeedbackDialogMounted(true)
    setFeedbackOpen(true)
  }, [])

  const sidebarProps = {
    isFullscreen,
    entries,
    section: assistantSection,
    title: sidebarUser.name,
    logo: sidebarLogo,
    onHeaderClick: sidebarUser.onClick,
    actions: (footerLayout: SidebarVisibleLayout, onOverlayOpenChange?: (open: boolean) => void) => (
      <SidebarShellActions
        layout={footerLayout}
        onFeedbackClick={handleOpenFeedback}
        onSettingsClick={handleOpenSettingsTab}
        onOverlayOpenChange={onOverlayOpenChange}
      />
    ),
    onEntriesReorder: handleReorder
  }

  return (
    <div ref={ref} id="app-sidebar" data-ui="app.sidebar" className="relative h-full [-webkit-app-region:no-drag]">
      <UISidebar
        width={activeSidebarWidth}
        setWidth={setSidebarWidth}
        onHoverChange={setHoverVisible}
        onResizePreview={setPreviewSidebarWidth}
        {...sidebarProps}
      />
      {hoverVisible && layout === 'hidden' && (
        <UISidebar
          width={activeSidebarWidth}
          setWidth={setSidebarWidth}
          isFloating
          onDismiss={() => setHoverVisible(false)}
          {...sidebarProps}
        />
      )}
      {feedbackDialogMounted ? (
        <Suspense fallback={null}>
          <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </Suspense>
      ) : null}
      {assistantEditDialogHost}
      <AssistantConversationPickerDialog
        open={assistantPickerOpen}
        onOpenChange={setAssistantPickerOpen}
        assistants={assistants}
        onSelect={handleAssistantSelect}
      />
    </div>
  )
}
