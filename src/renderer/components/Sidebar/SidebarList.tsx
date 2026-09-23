import type { ReactNode } from 'react'
import { Fragment } from 'react'

import { MenuItem } from '@cherrystudio/ui'
import { CommandContextMenu } from '@renderer/components/command'
import { cn } from '@renderer/utils/style'

import { ActiveIndicator } from './primitives'
import type { SidebarClickGuard } from './SidebarSortableList'
import { SidebarSortableList } from './SidebarSortableList'
import { SidebarTooltip } from './Tooltip'
import type {
  ResolvedSidebarEntry,
  SidebarIconPresentation,
  SidebarSection,
  SidebarSectionAction,
  SidebarVisibleLayout
} from './types'

const FULL_ICON_PRESENTATION = { slotSize: 18, glyphSize: 16 } as const
const ICON_ICON_PRESENTATION = { slotSize: 24, glyphSize: 18 } as const
const SECTION_ICON_PRESENTATION = { slotSize: 20, glyphSize: 18 } as const

export interface SidebarListProps {
  layout: SidebarVisibleLayout
  entries: ResolvedSidebarEntry[]
  onReorder?: (event: { oldIndex: number; newIndex: number }) => void
  onContextMenuOpenChange?: (open: boolean) => void
}

/**
 * Renders resolved shortcuts as one continuous, drag-reorderable list.
 * A single `SidebarSortableList` (one dnd-kit context) backs the whole list, so a
 * drag can move an item to any position regardless of its resource provider.
 */
export function SidebarList({ layout, ...props }: SidebarListProps) {
  if (layout === 'icon') return <IconList {...props} />
  return <FullList {...props} />
}

type ListProps = Omit<SidebarListProps, 'layout'>

function EntryContextMenu({
  children,
  items,
  onOpenChange
}: {
  children: ReactNode
  items?: ResolvedSidebarEntry['contextMenuItems']
  onOpenChange?: (open: boolean) => void
}) {
  if (!items?.length) return <>{children}</>

  return (
    <CommandContextMenu location="webcontents.context" extraItems={items} onOpenChange={onOpenChange}>
      {children}
    </CommandContextMenu>
  )
}

function createAuxClickHandler(entry: ResolvedSidebarEntry, guardClick: SidebarClickGuard) {
  if (entry.disabled || !entry.onOpenNewTab) return undefined
  return guardClick(entry.key, (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      entry.onOpenNewTab?.()
    }
  })
}

function preventMiddleClickAutoscroll(e: React.MouseEvent) {
  if (e.button === 1) e.preventDefault()
}

function SidebarEntryIcon({
  entry,
  presentation
}: {
  entry: ResolvedSidebarEntry
  presentation: SidebarIconPresentation
}) {
  return (
    <span
      data-slot="sidebar-entry-icon"
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center"
      style={{ width: presentation.slotSize, height: presentation.slotSize }}>
      {entry.renderIcon(presentation)}
    </span>
  )
}

function IconList({
  entries,
  onReorder,
  onContextMenuOpenChange,
  iconPresentation = ICON_ICON_PRESENTATION
}: ListProps & { iconPresentation?: SidebarIconPresentation }) {
  return (
    <SidebarSortableList
      items={entries}
      itemKey="key"
      onReorder={onReorder}
      className="flex flex-col items-center gap-0.5 px-1.5 [-webkit-app-region:no-drag]">
      {(entry, guardClick) => {
        const isActive = !entry.disabled && entry.isActive

        return (
          <SidebarTooltip
            key={entry.key}
            content={entry.statusLabel ? `${entry.label} — ${entry.statusLabel}` : entry.label}>
            <EntryContextMenu items={entry.contextMenuItems} onOpenChange={onContextMenuOpenChange}>
              <button
                type="button"
                aria-label={entry.label}
                aria-description={entry.statusLabel}
                aria-disabled={entry.disabled || undefined}
                onClick={entry.disabled ? undefined : guardClick(entry.key, entry.onOpen)}
                onMouseDown={preventMiddleClickAutoscroll}
                onAuxClick={createAuxClickHandler(entry, guardClick)}
                className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-all duration-150 ${
                  entry.disabled ? 'cursor-not-allowed opacity-55' : ''
                } ${
                  isActive
                    ? 'bg-[var(--sidebar-active-bg)] text-foreground'
                    : entry.disabled
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                }`}>
                {isActive && <ActiveIndicator className="rounded-full" />}
                <SidebarEntryIcon entry={entry} presentation={iconPresentation} />
              </button>
            </EntryContextMenu>
          </SidebarTooltip>
        )
      }}
    </SidebarSortableList>
  )
}

function FullList({
  entries,
  onReorder,
  onContextMenuOpenChange,
  iconPresentation = FULL_ICON_PRESENTATION
}: ListProps & { iconPresentation?: SidebarIconPresentation }) {
  return (
    <SidebarSortableList
      items={entries}
      itemKey="key"
      onReorder={onReorder}
      className="space-y-0.5 px-2 [-webkit-app-region:no-drag]">
      {(entry, guardClick: SidebarClickGuard) => {
        const isActive = !entry.disabled && entry.isActive

        return (
          <div key={entry.key} className="relative">
            <EntryContextMenu items={entry.contextMenuItems} onOpenChange={onContextMenuOpenChange}>
              <MenuItem
                variant="ghost"
                icon={<SidebarEntryIcon entry={entry} presentation={iconPresentation} />}
                label={entry.label}
                aria-label={entry.label}
                aria-description={entry.statusLabel}
                title={entry.statusLabel}
                active={isActive}
                aria-disabled={entry.disabled || undefined}
                onClick={entry.disabled ? undefined : guardClick(entry.key, entry.onOpen)}
                onMouseDown={preventMiddleClickAutoscroll}
                onAuxClick={createAuxClickHandler(entry, guardClick)}
                className="rounded-xl aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:opacity-55 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground data-[active=true]:bg-[var(--sidebar-active-bg)]"
              />
            </EntryContextMenu>
            {isActive && <ActiveIndicator className="rounded-xl" />}
          </div>
        )
      }}
    </SidebarSortableList>
  )
}

function SidebarSectionHeader({ section }: { section: SidebarSection }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-1 px-2.5">
      <span className="truncate text-muted-foreground text-xs">{section.title}</span>
      {section.action && <SidebarSectionHeaderAction action={section.action} />}
    </div>
  )
}

function SidebarSectionHeaderAction({ action }: { action: SidebarSectionAction }) {
  return (
    <SidebarTooltip content={action.label}>
      <button
        type="button"
        aria-label={action.label}
        onClick={action.onClick}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-accent/60 hover:text-foreground">
        {action.icon}
      </button>
    </SidebarTooltip>
  )
}

/**
 * The sidebar's secondary list: a divider and section header that stay put, then the rows, which
 * scroll. A single unlabelled group is the flat case and keeps drag reordering; grouped rows
 * (assistant groups) do not reorder, because a drag would have to cross group boundaries that the
 * rows themselves cannot express.
 */
export function SidebarSectionList({ layout, section }: { layout: SidebarVisibleLayout; section: SidebarSection }) {
  const entries = section.groups.flatMap((group) => group.entries)
  const flatGroup = section.groups.length === 1 && !section.groups[0].label ? section.groups[0].key : undefined
  const rows =
    layout === 'icon' ? (
      <IconList
        entries={entries}
        iconPresentation={SECTION_ICON_PRESENTATION}
        onContextMenuOpenChange={section.onContextMenuOpenChange}
      />
    ) : (
      section.groups.map((group) => (
        <Fragment key={group.key}>
          {group.label && (
            <div className="truncate px-2.5 pt-1.5 pb-0.5 text-muted-foreground text-xs">{group.label}</div>
          )}
          <FullList
            entries={group.entries}
            iconPresentation={SECTION_ICON_PRESENTATION}
            onReorder={group.key === flatGroup ? section.onEntriesReorder : undefined}
            onContextMenuOpenChange={section.onContextMenuOpenChange}
          />
        </Fragment>
      ))
    )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', layout === 'full' && 'pt-1')}>
      <div aria-hidden="true" className="mx-2 h-px shrink-0 bg-border-subtle" />
      {layout === 'full' && <SidebarSectionHeader section={section} />}
      <div className="min-h-0 flex-1 overflow-y-auto pb-1 [&::-webkit-scrollbar]:hidden">{rows}</div>
    </div>
  )
}
