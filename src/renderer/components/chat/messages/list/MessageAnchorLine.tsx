import {
  type FC,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import { classNames } from '@renderer/utils/style'
import type { CherryMessagePart } from '@shared/data/types/message'

import { useMessageParts } from '../blocks/MessagePartsContext'
import type { AnchorMessage } from '../types'
import { groupAnchorTurns, type AnchorTurn } from '../utils/anchorTurns'
import { getTurnPreview } from '../utils/turnPreview'

interface MessageLineProps {
  /** Topology only — see `AnchorMessage`. MessageList projects onto it so this
   * prop survives a streaming chunk unchanged and `memo` below can bail. */
  messages: readonly AnchorMessage[]
  /** Message under the viewport-top reading line; highlights its turn's tick. */
  activeMessageId?: string | null
  /** 0–1 fade driven by the content's rail gutter — the rail eases in/out with width. */
  railOpacity?: number
  /** Older turns exist beyond the loaded pages — fade the strip's top as a
   * "more above" hint. The mount-time value also fixes the strip's alignment
   * for the whole rail lifetime (bottom-anchored vs centred), so finishing the
   * last page load never shifts the visible ticks. */
  hasOlder?: boolean
  /** Parts for every message outside the mutable streaming tail. Passing this
   * snapshot instead of reading PartsContext here keeps the rail out of the
   * streaming render path — only the live preview leaf subscribes to chunks. */
  historyPartsByMessageId: Record<string, CherryMessagePart[]>
  /** Messages that must read their current parts from PartsContext. */
  liveMessageIds: readonly string[]
  scrollToMessageId?: (messageId: string) => void
}

const TICK_BASE_WIDTH = 6
/** Below this usable height the rail is cramped, so hide it. */
const RAIL_MIN_HEIGHT_PX = 220
/** Fixed minimum gap kept above the first and below the last tick — the ticks
 * never enter this zone, and it stays put while the strip scrolls. */
const RAIL_MIN_EDGE_MARGIN_PX = 24
/** Constant spacing between ticks. It never varies with the turn count (few → a
 * centred cluster); once the ticks outgrow the rail it scrolls instead. */
const RAIL_TICK_PITCH_PX = 10
/** Length of the fade applied to whichever end still has ticks scrolled past it. */
const RAIL_FADE_PX = 44
/** A single turn needs no anchor — everything is on screen. */
const RAIL_MIN_TURNS = 2
/** Width of the hover-revealed turn list. */
const FLYOUT_WIDTH_PX = 320
const EMPTY_MESSAGE_PARTS: CherryMessagePart[] = []

const MessageAnchorLine = memo(function MessageAnchorLine({
  messages,
  activeMessageId,
  railOpacity = 1,
  hasOlder = false,
  historyPartsByMessageId,
  liveMessageIds,
  scrollToMessageId
}: MessageLineProps) {
  const { t } = useTranslation()
  const liveMessageIdSet = useMemo(() => new Set(liveMessageIds), [liveMessageIds])

  const wrapperRef = useRef<HTMLDivElement>(null)
  const railScrollRef = useRef<HTMLDivElement>(null)

  /** Rail height in px; drives every tick position so they never depend on DOM reads. */
  const [railHeight, setRailHeight] = useState(0)
  /** The rail's own scroll offset (only moves when the user wheels the rail itself). */
  const [scrollTop, setScrollTop] = useState(0)
  /** The turn list is revealed on rail hover and hidden on leave. */
  const [isFlyoutOpen, setIsFlyoutOpen] = useState(false)
  /** Once the composer inset leaves too little height, the rail is cramped — hide it. */
  const tooShort = railHeight > 0 && railHeight < RAIL_MIN_HEIGHT_PX
  const visible = railOpacity > 0.02 && !tooShort
  // The hit strip is clickable whenever it is visible, but it only ever
  // occupies space the content has already yielded: the content's right
  // padding is 24px base + gutter, the strip is inset 16px (right-4), and
  // railOpacity × 24 is the integer gutter — so the strip's width grows with
  // the fade and everything left of it still belongs to the messages. At full
  // opacity this is exactly the 32px strip.
  const hitStripWidth = 8 + Math.round(railOpacity * 24)

  const turns = useMemo(() => groupAnchorTurns(messages), [messages])

  const turnIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>()
    turns.forEach((turn, index) => turn.memberIds.forEach((id) => map.set(id, index)))
    return map
  }, [turns])

  const activeTurnIndex =
    activeMessageId != null ? (turnIndexByMessageId.get(activeMessageId) ?? turns.length - 1) : turns.length - 1

  // Tick geometry — CONSTANT pitch, so spacing never varies with the turn count.
  // viewport = railHeight − 2·edgeMargin (the space between the fixed margins).
  // • ticks fit      → centred within the viewport, wider margins.
  // • ticks overflow → the strip scrolls inside the fixed margins.
  // The margins live OUTSIDE the scroll area, so they never move while scrolling.
  // The alignment is latched at mount and never changes for this rail's
  // lifetime (the list remounts per topic): a conversation that entered with
  // unloaded history stays bottom-anchored even after the last page lands —
  // flipping to centred at that moment would shift every visible tick.
  const alignToBottomRef = useRef(hasOlder)

  const geometry = useMemo(() => {
    const count = turns.length
    const viewport = Math.max(0, railHeight - RAIL_MIN_EDGE_MARGIN_PX * 2)
    const content = count * RAIL_TICK_PITCH_PX
    const free = Math.max(0, viewport - content)
    // Conversations that mounted fully loaded centre the cluster. Ones that
    // mounted with history still above anchor it to the bottom (the newest
    // turns, where the user enters), so older turns streaming in later grow
    // upward without moving a single visible tick.
    const padTop = alignToBottomRef.current ? free : free / 2
    const padBottom = free - padTop
    return { padTop, padBottom }
  }, [turns.length, railHeight])

  const handleRailMouseEnter = useCallback(() => setIsFlyoutOpen(true), [])
  const handleRailMouseLeave = useCallback(() => setIsFlyoutOpen(false), [])

  // Fading out mid-hover would strand an open flyout behind the fade.
  useEffect(() => {
    if (!visible) setIsFlyoutOpen(false)
  }, [visible])

  // Few messages don't need anchoring. Only the rail is gated — the content's
  // gutter (MessageList) follows width alone, so when the turn count crosses
  // this threshold the rail fades into space that already exists, with no jump.
  const hasRail = turns.length >= RAIL_MIN_TURNS

  // Keep the strip's reading anchor stable across async page loads:
  // • on entry, start at the bottom — the user enters at the newest turn;
  // • when older turns prepend, offset the scroll so visible ticks stay put
  //   (the browser clamp lands exactly right when the strip just overflowed);
  // • when new turns append while pinned to the bottom, stay pinned.
  const scrollAnchorRef = useRef<{ firstId: string | null; count: number; entered: boolean }>({
    firstId: null,
    count: 0,
    entered: false
  })
  useLayoutEffect(() => {
    const el = railScrollRef.current
    const anchor = scrollAnchorRef.current
    const firstId = turns[0]?.anchorId ?? null
    if (el) {
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
      const added = turns.length - anchor.count
      if (!anchor.entered) {
        el.scrollTop = maxScroll
        anchor.entered = true
      } else if (added > 0 && firstId !== anchor.firstId) {
        el.scrollTop += added * RAIL_TICK_PITCH_PX
      } else if (added > 0 && maxScroll - el.scrollTop <= added * RAIL_TICK_PITCH_PX + 1) {
        el.scrollTop = maxScroll
      }
      setScrollTop(el.scrollTop)
    }
    anchor.firstId = firstId
    anchor.count = turns.length
  }, [turns, railHeight])

  // Track the rail height so tick geometry stays exact across window/composer
  // resizes, and hide the rail once it is too short to be usable. Layout effect
  // keyed on hasRail: messages load asynchronously, so on first run the rail is
  // often not rendered yet (wrapper null) — the effect must re-run once it
  // mounts, and measure before paint or the ticks flash top-aligned.
  useLayoutEffect(() => {
    if (!hasRail) return
    const wrapper = wrapperRef.current
    if (!wrapper || typeof ResizeObserver === 'undefined') return
    const update = () => setRailHeight(wrapper.getBoundingClientRect().height)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [hasRail])

  if (!hasRail) return null

  // Fade whichever end still has ticks scrolled past it, signalling "there's
  // more" like Codex. Derived from the model — no DOM reads.
  const railViewport = Math.max(0, railHeight - RAIL_MIN_EDGE_MARGIN_PX * 2)
  const maxScroll = Math.max(0, turns.length * RAIL_TICK_PITCH_PX - railViewport)
  // hasOlder keeps the top fade on as a "more above" hint even at rest.
  const fadeTop = scrollTop > 1 || hasOlder
  const fadeBottom = scrollTop < maxScroll - 1
  const railMask =
    fadeTop || fadeBottom
      ? `linear-gradient(to bottom, ${fadeTop ? 'transparent' : 'black'} 0%, black ${fadeTop ? RAIL_FADE_PX : 0}px, black calc(100% - ${fadeBottom ? RAIL_FADE_PX : 0}px), ${fadeBottom ? 'transparent' : 'black'} 100%)`
      : undefined

  return (
    <div
      ref={wrapperRef}
      className={classNames(
        // right-4 keeps the ticks clear of the scrollbar gutter (~15px) so the
        // thumb never overlaps them while scrolling. top-2.5 sits just below
        // the header; bottom-8 keeps the last tick clear of the very bottom
        // edge. The composer is inset to the left of this gutter, so the ticks
        // clear it. The fade opacity lives on the tick strip below — NOT here
        // — so the hover flyout stays fully opaque and readable even while the
        // ticks are still fading in. The strip's width (hitStripWidth) grows
        // with the gutter so it never covers message content mid-fade — the
        // visible ticks are clickable at any fade stage, and clicks left of
        // the strip reach the messages.
        'group absolute top-2.5 right-4 bottom-8 z-20 select-none',
        !visible && 'pointer-events-none'
      )}
      // inert keeps the hidden rail out of the Tab order and the accessibility
      // tree — an invisible layer must not take keyboard focus.
      inert={!visible}
      style={{ width: hitStripWidth }}
      onMouseEnter={handleRailMouseEnter}
      onMouseLeave={handleRailMouseLeave}>
      <div
        ref={railScrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className={classNames(
          // The scroll viewport is inset by the fixed edge margins (top/bottom),
          // so those margins sit OUTSIDE the scroll and never move while the strip
          // scrolls. Ticks fill the viewport (centred when few) and scroll only
          // once they overflow it. It never auto-follows the conversation.
          'absolute inset-x-0 flex flex-col items-end overflow-y-auto transition-opacity duration-150 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
        style={{
          top: RAIL_MIN_EDGE_MARGIN_PX,
          bottom: RAIL_MIN_EDGE_MARGIN_PX,
          // The width-driven fade (railOpacity needs no transition — it already
          // ramps continuously) combines with the resting 70% dim that hover
          // lifts (the transition-opacity above eases that lift).
          opacity: (visible ? railOpacity : 0) * (isFlyoutOpen ? 1 : 0.7),
          maskImage: railMask,
          WebkitMaskImage: railMask
        }}>
        <div
          className="flex w-full flex-col items-end"
          style={{ paddingTop: geometry.padTop, paddingBottom: geometry.padBottom }}>
          {turns.map((turn, index) => {
            const isActive = index === activeTurnIndex
            return (
              <button
                key={turn.anchorId}
                type="button"
                data-message-anchor-tick
                data-active={isActive}
                aria-label={t('chat.navigation.anchor.jump_to_turn', { number: index + 1 })}
                aria-current={isActive ? 'true' : undefined}
                // Preflight already zeroes button padding/background/border, so
                // the layout classes alone keep the visuals unchanged.
                className="flex w-full shrink-0 cursor-pointer items-center justify-end rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ height: RAIL_TICK_PITCH_PX }}
                onClick={() => scrollToMessageId?.(turn.anchorId)}>
                <div
                  className={classNames(
                    'h-[1.5px] rounded-full transition-colors duration-150',
                    isActive ? 'bg-foreground' : 'bg-border-strong'
                  )}
                  style={{ width: TICK_BASE_WIDTH }}
                />
              </button>
            )
          })}
        </div>
      </div>
      {isFlyoutOpen && (
        <MessageAnchorFlyout
          turns={turns}
          activeTurnIndex={activeTurnIndex}
          historyPartsByMessageId={historyPartsByMessageId}
          liveMessageIdSet={liveMessageIdSet}
          onJump={(messageId) => {
            setIsFlyoutOpen(false)
            scrollToMessageId?.(messageId)
          }}
        />
      )}
    </div>
  )
})

interface FlyoutSharedProps {
  historyPartsByMessageId: Record<string, CherryMessagePart[]>
  liveMessageIdSet: ReadonlySet<string>
}

interface MessageAnchorFlyoutProps extends FlyoutSharedProps {
  turns: AnchorTurn[]
  activeTurnIndex: number
  onJump: (messageId: string) => void
}

const MessageAnchorFlyout: FC<MessageAnchorFlyoutProps> = ({
  turns,
  activeTurnIndex,
  historyPartsByMessageId,
  liveMessageIdSet,
  onJump
}) => {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)

  // Reveal the active row on mount and whenever the reading line moves while
  // the list is open — but only scroll when the row is actually out of view,
  // so browsing the list never fights the auto-reveal. Viewport-relative rect
  // math keeps the row position independent of offsetParent subtleties.
  useLayoutEffect(() => {
    const list = listRef.current
    const activeRow = list?.querySelector<HTMLElement>('[data-message-anchor-row][data-active="true"]')
    if (!list || !activeRow) return
    const rowTop = activeRow.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    const rowBottom = rowTop + activeRow.getBoundingClientRect().height
    if (rowTop < list.scrollTop || rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, rowTop - (list.clientHeight - activeRow.getBoundingClientRect().height) / 2)
    }
  }, [activeTurnIndex, turns])

  return (
    // The list is a child of the rail strip's wrapper positioned flush against
    // its left edge (right-full), so the pointer travels from ticks to rows
    // without leaving the wrapper's hover scope. It hugs its content and is
    // vertically centred on the rail, capped at the rail's full height.
    <nav
      aria-label={t('chat.navigation.flyout.label')}
      className="absolute top-1/2 right-full z-30 flex max-h-full -translate-y-1/2 flex-col rounded-xl border-[0.5px] border-border bg-popover text-popover-foreground shadow-lg"
      style={{ width: FLYOUT_WIDTH_PX }}>
      <div ref={listRef} className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5">
        {turns.map((turn, index) => {
          const isActive = index === activeTurnIndex
          return (
            <button
              key={turn.anchorId}
              type="button"
              data-message-anchor-row
              data-active={isActive}
              aria-label={t('chat.navigation.anchor.jump_to_turn', { number: index + 1 })}
              aria-current={isActive ? 'true' : undefined}
              className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring-inset data-[active=true]:bg-accent"
              onClick={() => onJump(turn.anchorId)}>
              <FlyoutPreviewText
                messageId={turn.userMessageId}
                historyPartsByMessageId={historyPartsByMessageId}
                liveMessageIdSet={liveMessageIdSet}
                className="line-clamp-2 text-sm font-medium break-all text-foreground"
                fallback={
                  turn.userMessageId ? t('chat.navigation.flyout.empty_user') : t('chat.navigation.flyout.agent_turn')
                }
                showAttachmentBadge
              />
              <FlyoutPreviewText
                messageId={turn.assistantMessageId}
                historyPartsByMessageId={historyPartsByMessageId}
                liveMessageIdSet={liveMessageIdSet}
                className="line-clamp-2 text-sm leading-5 break-all text-muted-foreground"
              />
            </button>
          )
        })}
      </div>
    </nav>
  )
}

interface FlyoutPreviewTextProps extends FlyoutSharedProps {
  messageId?: string
  className: string
  /** Rendered when the message has no previewable content at all. */
  fallback?: string
  /** Show attachment counts when the message has no text. */
  showAttachmentBadge?: boolean
}

const FlyoutPreviewText: FC<FlyoutPreviewTextProps> = ({
  messageId,
  className,
  fallback,
  showAttachmentBadge = false,
  historyPartsByMessageId,
  liveMessageIdSet
}) => {
  if (!messageId) {
    return fallback ? <div className={className}>{fallback}</div> : null
  }
  if (liveMessageIdSet.has(messageId)) {
    return (
      <LiveFlyoutPreviewText
        messageId={messageId}
        className={className}
        fallback={fallback}
        showAttachmentBadge={showAttachmentBadge}
      />
    )
  }
  return (
    <HistoryFlyoutPreviewText
      parts={historyPartsByMessageId[messageId] ?? EMPTY_MESSAGE_PARTS}
      className={className}
      fallback={fallback}
      showAttachmentBadge={showAttachmentBadge}
    />
  )
}

interface LiveFlyoutPreviewTextProps {
  messageId: string
  className: string
  fallback?: string
  showAttachmentBadge?: boolean
}

/** Live tail rows subscribe to the parts context at this leaf only, so a
 * streaming chunk never re-renders the rail or the sealed history rows. */
const LiveFlyoutPreviewText: FC<LiveFlyoutPreviewTextProps> = ({
  messageId,
  className,
  fallback,
  showAttachmentBadge
}) => {
  const parts = useMessageParts(messageId)
  return (
    <HistoryFlyoutPreviewText
      parts={parts}
      className={className}
      fallback={fallback}
      showAttachmentBadge={showAttachmentBadge}
    />
  )
}

interface HistoryFlyoutPreviewTextProps {
  parts: CherryMessagePart[]
  className: string
  fallback?: string
  showAttachmentBadge?: boolean
}

const HistoryFlyoutPreviewText: FC<HistoryFlyoutPreviewTextProps> = ({
  parts,
  className,
  fallback,
  showAttachmentBadge
}) => {
  const { t } = useTranslation()
  const preview = getTurnPreview(parts)

  let content: ReactNode = preview.text
  if (!content && showAttachmentBadge) {
    const badge = [
      preview.imageCount > 0 ? t('chat.navigation.flyout.images', { count: preview.imageCount }) : null,
      preview.fileCount > 0 ? t('chat.navigation.flyout.files', { count: preview.fileCount }) : null
    ]
      .filter(Boolean)
      .join(' · ')
    if (badge) content = badge
  }
  if (!content) content = fallback

  if (!content) return null
  return <div className={className}>{content}</div>
}

export default MessageAnchorLine
