import type { ReactNode } from 'react'

import type { CommandContextMenuExtraItem } from '@renderer/components/command'

export interface SidebarIconPresentation {
  slotSize: number
  glyphSize: number
}

/**
 * A fully-resolved, type-agnostic sidebar row. The app shell produces these through
 * the shortcut registry; the presentation layer has no resource-domain dependencies.
 */
export interface ResolvedSidebarEntry {
  /** Stable identity used as both React key and reorder key. */
  key: string
  label: string
  renderIcon: (presentation: SidebarIconPresentation) => ReactNode
  isActive: boolean
  statusLabel?: string
  onOpen: () => void
  disabled?: boolean
  onOpenNewTab?: () => void
  contextMenuItems?: readonly CommandContextMenuExtraItem[]
}

export type SidebarLayout = 'hidden' | 'icon' | 'full'

export type SidebarVisibleLayout = Exclude<SidebarLayout, 'hidden'>

/**
 * A labelled region of resolved rows below the primary navigation — the sidebar's second list.
 * Rows keep the navigation's vocabulary; only their resource differs. Groups exist so a caller can
 * organize rows under quiet sub-headers (assistant groups); a single unlabelled group is the flat
 * case, and it is the only one that can be drag-reordered.
 */
export interface SidebarSectionGroup {
  key: string
  /** Quiet sub-header above this group's rows. Unlabelled groups render flush. */
  label?: string
  entries: ResolvedSidebarEntry[]
}

export interface SidebarSectionAction {
  label: string
  icon: ReactNode
  onClick: () => void
}

export interface SidebarSectionLink {
  label: string
  icon?: ReactNode
  onClick: () => void
}

export interface SidebarSection {
  key: string
  title: string
  action?: SidebarSectionAction
  groups: SidebarSectionGroup[]
  /** Quiet row after the last group, for leaving the list (e.g. into the full library). */
  footer?: SidebarSectionLink
  onEntriesReorder?: (event: { oldIndex: number; newIndex: number }) => void
  onContextMenuOpenChange?: (open: boolean) => void
}

export interface SidebarUser {
  name: string
  avatar?: string
  onClick?: () => void
}
