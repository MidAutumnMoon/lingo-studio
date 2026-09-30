// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, createContext, use } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CherryMessagePart } from '@shared/data/types/message'

import type { MessageListItem } from '../../types'
import MessageAnchorLine from '../MessageAnchorLine'

const partsMap: Record<string, CherryMessagePart[]> = {}

/** The real `useMessageParts` is a context read, so a chunk reaches the live
 * preview leaf without the memoized rail re-rendering. Mocking it as a plain
 * map read would lose exactly that, letting a parent re-render masquerade as
 * live-leaf isolation — so the stand-in is a real context too. */
const LivePartsContext = createContext<Record<string, CherryMessagePart[]>>({})

vi.mock('../../blocks/MessagePartsContext', () => ({
  useMessageParts: (messageId: string) => use(LivePartsContext)[messageId] ?? []
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const n = options && ('number' in options || 'count' in options) ? ` ${options.number ?? options.count}` : ''
      return `${key}${n}`
    }
  })
}))

function makeMessage(overrides: Partial<MessageListItem> & Pick<MessageListItem, 'id' | 'role'>): MessageListItem {
  return {
    topicId: 'topic-1',
    parentId: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    status: 'success',
    ...overrides
  }
}

const messages: MessageListItem[] = [
  makeMessage({ id: 'user-1', role: 'user' }),
  makeMessage({ id: 'assistant-1', role: 'assistant', parentId: 'user-1' }),
  makeMessage({ id: 'user-2', role: 'user' }),
  makeMessage({ id: 'assistant-2', role: 'assistant', parentId: 'user-2' }),
  makeMessage({ id: 'assistant-2b', role: 'assistant', parentId: 'user-2' }),
  makeMessage({ id: 'user-3', role: 'user' }),
  makeMessage({ id: 'assistant-3', role: 'assistant', parentId: 'user-3' }),
  makeMessage({ id: 'user-4', role: 'user' }),
  makeMessage({ id: 'assistant-4', role: 'assistant', parentId: 'user-4' }),
  makeMessage({ id: 'user-5', role: 'user' }),
  makeMessage({ id: 'assistant-5', role: 'assistant', parentId: 'user-5' })
]

function makeTurnMessages(count: number, startIndex = 0): MessageListItem[] {
  const result: MessageListItem[] = []
  for (let i = 0; i < count; i++) {
    const n = startIndex + i
    result.push(makeMessage({ id: `turn-user-${n}`, role: 'user' }))
    result.push(makeMessage({ id: `turn-assistant-${n}`, role: 'assistant', parentId: `turn-user-${n}` }))
  }
  return result
}

const textPart = (text: string): CherryMessagePart => ({ type: 'text', text })

/** Wrapper height the geometry helpers report; comfortably above the rail's
 * minimum usable height. Rail viewport = 400 − 2 · 24 (edge margins) = 352. */
const RAIL_HEIGHT_PX = 400
const RAIL_VIEWPORT_PX = 352

interface StripMetrics {
  scrollHeight: number
  clientHeight: number
}

/** JSDOM reports zero for every layout metric, so the component's geometry
 * paths never run by default. Give the rail real dimensions: wrapper height
 * via getBoundingClientRect (plus a ResizeObserver stub so the measure effect
 * runs at all) and strip scrollHeight/clientHeight via prototype getters. */
function installRailGeometry(metrics: StripMetrics): () => void {
  const originalResizeObserver = globalThis.ResizeObserver

  class ResizeObserverMock {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
  }

  globalThis.ResizeObserver = ResizeObserverMock

  const isStrip = (element: HTMLElement) => element.classList.contains('overflow-y-auto')
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 32,
      bottom: RAIL_HEIGHT_PX,
      width: 32,
      height: RAIL_HEIGHT_PX,
      toJSON: () => ({})
    }
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isStrip(this) ? metrics.scrollHeight : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isStrip(this) ? metrics.clientHeight : 0
    }
  })

  return () => {
    globalThis.ResizeObserver = originalResizeObserver
    // The overrides shadow Element.prototype's originals — deleting restores them.
    // (Reflect.deleteProperty: `delete` on the readonly-typed properties is a TS2704.)
    Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  }
}

type RailProps = ComponentProps<typeof MessageAnchorLine>

const NO_LIVE_MESSAGE_IDS: readonly string[] = []

/** MessageList always hands the rail an explicit history/live split. Tests that
 * don't exercise streaming treat the shared map as pure history; `liveParts`
 * stands in for the streaming PartsContext the live preview leaf reads. */
const rail = (
  props: Partial<RailProps> & Pick<RailProps, 'messages'>,
  liveParts: Record<string, CherryMessagePart[]> = partsMap
) => (
  <LivePartsContext value={liveParts}>
    <MessageAnchorLine historyPartsByMessageId={partsMap} liveMessageIds={NO_LIVE_MESSAGE_IDS} {...props} />
  </LivePartsContext>
)

const renderRail = (...args: Parameters<typeof rail>) => render(rail(...args))

const openFlyout = (container: HTMLElement) => {
  fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
}

let restoreGeometry: (() => void) | null = null

afterEach(() => {
  restoreGeometry?.()
  restoreGeometry = null
  for (const key of Object.keys(partsMap)) delete partsMap[key]
  vi.unstubAllGlobals()
})

describe('MessageAnchorLine', () => {
  it('keeps the anchor rail scoped inside the message list layer', () => {
    const { container } = renderRail({ messages })

    const anchorRail = container.firstElementChild
    expect(anchorRail).toHaveClass('absolute', 'z-20')
    expect(anchorRail).not.toHaveClass('fixed', 'z-999')
  })

  it('renders one tick per conversation turn', () => {
    const { container } = renderRail({ messages })

    expect(container.querySelectorAll('[data-message-anchor-tick]')).toHaveLength(5)
  })

  it('does not create a tick for a clear-context boundary', () => {
    const boundary = makeMessage({ id: 'clear-context', role: 'user', isContextBoundary: true })
    const messagesWithBoundary = [...messages.slice(0, 5), boundary, ...messages.slice(5)]
    const { container } = renderRail({ messages: messagesWithBoundary })

    expect(container.querySelectorAll('[data-message-anchor-tick]')).toHaveLength(5)
  })

  it('renders the rail from a single turn on', () => {
    const { container } = renderRail({ messages: messages.slice(0, 2) })

    expect(container.querySelectorAll('[data-message-anchor-tick]')).toHaveLength(1)
  })

  it('renders nothing for a conversation of only context boundaries', () => {
    const boundaryOnly = [
      makeMessage({ id: 'clear-1', role: 'user', isContextBoundary: true }),
      makeMessage({ id: 'clear-2', role: 'user', isContextBoundary: true })
    ]
    const { container } = renderRail({ messages: boundaryOnly })

    expect(container.firstElementChild).toBeNull()
  })

  it('marks the turn containing the active message', () => {
    const { container } = renderRail({ messages, activeMessageId: 'assistant-1' })

    const ticks = container.querySelectorAll('[data-message-anchor-tick]')
    expect(ticks[0]).toHaveAttribute('data-active', 'true')
    expect(ticks[1]).toHaveAttribute('data-active', 'false')
  })

  it('defaults the active tick to the last turn', () => {
    const { container } = renderRail({ messages })

    const ticks = container.querySelectorAll('[data-message-anchor-tick]')
    expect(ticks[4]).toHaveAttribute('data-active', 'true')
  })

  it('scrolls to the turn start message on tick click', () => {
    const scrollToMessageId = vi.fn()
    const { container } = renderRail({ messages, scrollToMessageId })

    const ticks = container.querySelectorAll('[data-message-anchor-tick]')
    fireEvent.click(ticks[1])

    expect(scrollToMessageId).toHaveBeenCalledWith('user-2')
  })

  it('gives every tick the same constant pitch inside a scrollable rail', () => {
    const { container } = renderRail({ messages })

    // Constant pitch (never varies with the turn count) and the rail can scroll
    // once the ticks overflow it.
    expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
    const ticks = Array.from(container.querySelectorAll<HTMLElement>('[data-message-anchor-tick]'))
    const heights = new Set(ticks.map((tick) => tick.style.height))
    expect(heights).toEqual(new Set(['10px']))
  })

  it('runs the rail the full message-area height rather than insetting above the composer', () => {
    const { container } = renderRail({ messages })

    // The rail spans top-to-bottom; the composer sits to the left of this gutter.
    expect(container.firstElementChild).toHaveClass('top-2.5', 'bottom-8')
    expect((container.firstElementChild as HTMLElement).style.bottom).toBe('')
  })

  it('fades the top edge as a hint while older pages remain unloaded', () => {
    const { container } = renderRail({ messages, hasOlder: true })

    const scroll = container.querySelector<HTMLElement>('.overflow-y-auto')
    expect(scroll?.style.maskImage).toContain('transparent 0%')
  })

  it('keeps the top edge solid when fully loaded and unscrolled', () => {
    const { container } = renderRail({ messages })

    const scroll = container.querySelector<HTMLElement>('.overflow-y-auto')
    expect(scroll?.style.maskImage ?? 'black 0%').toContain('black 0%')
  })

  it('renders nothing without messages', () => {
    const { container } = renderRail({ messages: [] })

    expect(container.firstElementChild).toBeNull()
  })

  describe('interactivity gating', () => {
    it('stays clickable mid-fade with a hit strip confined to the yielded gutter', () => {
      const { container } = renderRail({ messages, railOpacity: 0.5 })

      const rail = container.firstElementChild as HTMLElement
      // Visible means clickable — the strip is never a dead layer…
      expect(rail).not.toHaveClass('pointer-events-none')
      expect(rail).not.toHaveAttribute('inert')
      // …because its width only spans space the content has yielded
      // (8px inset margin + railOpacity × 24 gutter), so message text left of
      // it keeps its clicks and selection.
      expect(rail.style.width).toBe('20px')
      // The visual fade lives on the tick strip (railOpacity × the resting 70%
      // dim) so the flyout itself stays fully opaque.
      const strip = rail.querySelector<HTMLElement>('.overflow-y-auto')
      expect(strip?.style.opacity).toBe('0.35')
      expect(rail.style.opacity).toBe('')
    })

    it('spans the full 32px strip once the gutter has fully yielded', () => {
      const { container } = renderRail({ messages, railOpacity: 1 })

      const strip = container.firstElementChild as HTMLElement
      expect(strip).not.toHaveClass('pointer-events-none')
      expect(strip.style.width).toBe('32px')
    })

    it('goes fully inert once the rail fades out', () => {
      const { container } = renderRail({ messages, railOpacity: 0.01 })

      const strip = container.firstElementChild as HTMLElement
      expect(strip).toHaveClass('pointer-events-none')
      expect(strip).toHaveAttribute('inert')
      expect(strip.querySelector<HTMLElement>('.overflow-y-auto')?.style.opacity).toBe('0')
    })

    it('closes the flyout when the rail fades out mid-hover', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['user-2'] = [textPart('Question two')]
      const { container, rerender, queryByText } = renderRail({ messages, railOpacity: 1 })

      openFlyout(container)
      expect(queryByText('Question two')).toBeInTheDocument()

      rerender(rail({ messages, railOpacity: 0.01 }))
      expect(queryByText('Question two')).not.toBeInTheDocument()
    })
  })

  describe('flyout turn list', () => {
    it('reveals the turn list on hover and hides it on leave', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const { container } = renderRail({ messages })

      expect(container.querySelector('[data-message-anchor-row]')).toBeNull()

      openFlyout(container)
      expect(container.querySelectorAll('[data-message-anchor-row]')).toHaveLength(5)

      // The list hugs its content — vertically centred on the rail and capped
      // at its height, never stretched to fill it.
      const flyout = container.querySelector<HTMLElement>('nav')
      expect(flyout).toHaveClass('max-h-full', 'top-1/2')
      expect(flyout).not.toHaveClass('bottom-0')

      fireEvent.mouseLeave(container.firstElementChild as HTMLElement)
      expect(container.querySelector('[data-message-anchor-row]')).toBeNull()
    })

    it('lists every turn with its user and assistant preview', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['user-1'] = [textPart('Question one')]
      partsMap['assistant-1'] = [textPart('Answer one')]
      partsMap['user-5'] = [textPart('Question five')]
      const { container, getByText } = renderRail({ messages })

      openFlyout(container)

      expect(getByText('Question one')).toBeInTheDocument()
      expect(getByText('Answer one')).toBeInTheDocument()
      expect(getByText('Question five')).toBeInTheDocument()
    })

    it('jumps to the turn and closes the flyout on row click', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const scrollToMessageId = vi.fn()
      const { container } = renderRail({ messages, scrollToMessageId })

      openFlyout(container)
      const rows = container.querySelectorAll('[data-message-anchor-row]')
      fireEvent.click(rows[2])

      expect(scrollToMessageId).toHaveBeenCalledWith('user-3')
      expect(container.querySelector('[data-message-anchor-row]')).toBeNull()
    })

    it('marks the active turn row as current', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const { container } = renderRail({ messages, activeMessageId: 'assistant-2b' })

      openFlyout(container)

      const rows = container.querySelectorAll('[data-message-anchor-row]')
      expect(rows[1]).toHaveAttribute('data-active', 'true')
      expect(rows[1]).toHaveAttribute('aria-current', 'true')
      expect(rows[0]).toHaveAttribute('data-active', 'false')
      expect(rows[0]).not.toHaveAttribute('aria-current')
    })

    it('falls back to attachment counts for a textless file-only turn', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['user-2'] = [
        { type: 'file', mediaType: 'image/png', url: 'file:///a' },
        { type: 'file', mediaType: 'image/png', url: 'file:///b' },
        { type: 'file', mediaType: 'application/pdf', url: 'file:///c' }
      ] as unknown as CherryMessagePart[]
      const { container, getByText } = renderRail({ messages })

      openFlyout(container)

      expect(getByText('chat.navigation.flyout.images 2 · chat.navigation.flyout.files 1')).toBeInTheDocument()
    })

    it('labels an agent-initiated turn that has no user message', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const agentTurn = makeMessage({ id: 'agent-start', role: 'assistant' })
      const { container, getByText } = renderRail({ messages: [agentTurn, ...messages] })

      openFlyout(container)

      expect(getByText('chat.navigation.flyout.agent_turn')).toBeInTheDocument()
    })
  })

  describe('update isolation', () => {
    it('updates a live preview without reading sealed history again', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      let historySealed = false
      const historyParts = [
        {
          type: 'text',
          get text() {
            if (historySealed) throw new Error('historical preview was read again')
            return 'Stable question'
          }
        }
      ] as unknown as CherryMessagePart[]
      const historyPartsByMessageId = { 'user-2': historyParts }
      const liveMessageIds = ['assistant-2']
      const railProps = { messages, historyPartsByMessageId, liveMessageIds }
      const view = renderRail(railProps, { 'assistant-2': [textPart('Live answer one')] })

      openFlyout(view.container)
      expect(view.getByText('Stable question')).toBeInTheDocument()
      expect(view.getByText('Live answer one')).toBeInTheDocument()

      // Only the streaming context changes — every rail prop stays referentially
      // identical, so the chunk must reach the live leaf without re-rendering
      // the rail (which would throw on the sealed history getter).
      historySealed = true
      view.rerender(rail(railProps, { 'assistant-2': [textPart('Live answer two')] }))

      expect(view.getByText('Live answer two')).toBeInTheDocument()
    })

    it('stops extracting a historical preview at the extraction cap', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const preview = 'x'.repeat(160)
      const historyPartsByMessageId = {
        'user-2': [
          textPart(preview),
          {
            type: 'text',
            get text(): string {
              throw new Error('preview extraction read past its limit')
            }
          }
        ] as CherryMessagePart[]
      }
      const view = renderRail({ messages, historyPartsByMessageId })

      openFlyout(view.container)

      expect(view.getByText(preview)).toBeInTheDocument()
    })
  })

  describe('flyout branch selection', () => {
    it('previews the active-branch assistant rather than an off-path sibling', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['user-2'] = [textPart('Question two')]
      partsMap['assistant-2'] = [textPart('Off-path sibling reply')]
      partsMap['assistant-2b'] = [textPart('Active branch reply')]
      const branched = messages.map((message) =>
        message.id === 'assistant-2'
          ? { ...message, isActiveBranch: false }
          : message.id === 'assistant-2b'
            ? { ...message, isActiveBranch: true }
            : message
      )
      const { container, getByText, queryByText } = renderRail({ messages: branched })

      openFlyout(container)

      expect(getByText('Active branch reply')).toBeInTheDocument()
      expect(queryByText('Off-path sibling reply')).not.toBeInTheDocument()
    })

    it('falls back to the first assistant when no member carries the branch flag', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['assistant-2'] = [textPart('First reply')]
      partsMap['assistant-2b'] = [textPart('Second reply')]
      const { container, getByText } = renderRail({ messages })

      openFlyout(container)

      expect(getByText('First reply')).toBeInTheDocument()
    })

    it('styles the flyout with the semantic popover surface only', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      partsMap['user-2'] = [textPart('Question two')]
      partsMap['assistant-2'] = [textPart('Answer two')]
      const { container, getByText } = renderRail({ messages })

      openFlyout(container)

      const flyout = container.querySelector<HTMLElement>('nav.bg-popover')
      expect(flyout).not.toBeNull()
      expect(flyout?.className).not.toContain('dark:bg-neutral-800')
      // These maintained semantic tokens are the visual contract after the
      // foreground hierarchy migration on main.
      expect(getByText('Answer two')).toHaveClass('text-muted-foreground')
    })
  })

  describe('accessibility', () => {
    it('renders ticks as labelled buttons with the active turn marked as current', () => {
      const { container } = renderRail({ messages, activeMessageId: 'assistant-1' })

      const ticks = Array.from(container.querySelectorAll<HTMLElement>('[data-message-anchor-tick]'))
      ticks.forEach((tick, index) => {
        expect(tick.tagName).toBe('BUTTON')
        expect(tick).toHaveAttribute('type', 'button')
        expect(tick).toHaveAttribute('aria-label', `chat.navigation.anchor.jump_to_turn ${index + 1}`)
      })
      expect(ticks[0]).toHaveAttribute('aria-current', 'true')
      expect(ticks[1]).not.toHaveAttribute('aria-current')
      // Inactive ticks use main's maintained strong-structure token.
      expect(ticks[1].firstElementChild).toHaveClass('bg-border-strong')
    })

    it('reaches a tick with Tab and activates it with Enter', async () => {
      const user = userEvent.setup()
      const scrollToMessageId = vi.fn()
      const { container } = renderRail({ messages, scrollToMessageId })

      await user.tab()
      const ticks = container.querySelectorAll('[data-message-anchor-tick]')
      expect(ticks[0]).toHaveFocus()

      await user.keyboard('{Enter}')
      expect(scrollToMessageId).toHaveBeenCalledWith('user-1')
    })
  })

  describe('strip geometry', () => {
    it('anchors the strip to the bottom on first entry so the newest turns are visible', () => {
      // 40 turns × 10px = 400px of ticks inside a 352px viewport.
      restoreGeometry = installRailGeometry({ scrollHeight: 400, clientHeight: RAIL_VIEWPORT_PX })
      const { container } = renderRail({ messages: makeTurnMessages(40), hasOlder: true })

      const strip = container.querySelector<HTMLElement>('.overflow-y-auto') as HTMLElement
      expect(strip.scrollTop).toBe(400 - RAIL_VIEWPORT_PX)
    })

    it('compensates the scroll when older turns prepend so visible ticks stay put', () => {
      const metrics = { scrollHeight: 400, clientHeight: RAIL_VIEWPORT_PX }
      restoreGeometry = installRailGeometry(metrics)
      const initial = makeTurnMessages(40, 100)
      const { container, rerender } = renderRail({ messages: initial, hasOlder: true })

      const strip = container.querySelector<HTMLElement>('.overflow-y-auto') as HTMLElement
      const entryScrollTop = 400 - RAIL_VIEWPORT_PX
      expect(strip.scrollTop).toBe(entryScrollTop)

      metrics.scrollHeight = 460
      rerender(rail({ messages: [...makeTurnMessages(6), ...initial], hasOlder: true }))

      // 6 prepended turns × 10px pitch.
      expect(strip.scrollTop).toBe(entryScrollTop + 60)
    })

    it('keeps the bottom alignment when the last page loads (hasOlder true → false)', () => {
      // 5 turns × 10px fit the 352px viewport with 302px of free space.
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const { container, rerender } = renderRail({ messages, hasOlder: true })

      const cluster = container.querySelector<HTMLElement>('.overflow-y-auto > div') as HTMLElement
      // Mounted with unloaded history: the cluster hugs the bottom.
      expect(cluster.style.paddingTop).toBe('302px')

      rerender(rail({ messages, hasOlder: false }))

      // The alignment is latched for the rail's lifetime — finishing the last
      // page must not re-centre (151px) and shift every visible tick.
      expect(cluster.style.paddingTop).toBe('302px')
    })

    it('centres the cluster when mounted fully loaded', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: RAIL_VIEWPORT_PX, clientHeight: RAIL_VIEWPORT_PX })
      const { container } = renderRail({ messages, hasOlder: false })

      const cluster = container.querySelector<HTMLElement>('.overflow-y-auto > div') as HTMLElement
      expect(cluster.style.paddingTop).toBe('151px')
    })

    it('fades both ends while the strip is scrolled into the middle', () => {
      restoreGeometry = installRailGeometry({ scrollHeight: 400, clientHeight: RAIL_VIEWPORT_PX })
      const { container } = renderRail({ messages: makeTurnMessages(40) })

      const strip = container.querySelector<HTMLElement>('.overflow-y-auto') as HTMLElement
      strip.scrollTop = 20
      fireEvent.scroll(strip)

      expect(strip.style.maskImage).toContain('transparent 0%')
      expect(strip.style.maskImage).toContain('transparent 100%')
    })
  })
})
