import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { POPUP_EXIT_MS, popupService } from '@renderer/services/popup'

// happy-dom's CSSOM drops min()/calc() from style serialization, so capture the
// style prop handed to DialogContent and assert the raw clamped values on it.
const lastDialogContentStyle = vi.hoisted(() => ({ style: undefined as undefined | Record<string, unknown> }))

// This suite exercises the real popup store + host, so opt out of the global mock.
vi.mock('@renderer/services/popup', async (importOriginal) => await importOriginal())

vi.mock('@cherrystudio/ui', () => {
  const React = require('react')

  return {
    Dialog: ({ children, open }) => (open ? React.createElement(React.Fragment, null, children) : null),
    DialogContent: ({ children, ...props }) => {
      delete props.showCloseButton
      delete props.closeOnOverlayClick
      delete props.onPointerDownOutside
      lastDialogContentStyle.style = props.style

      return React.createElement('div', { role: 'dialog', ...props }, children)
    },
    DialogHeader: ({ children, ...props }) => React.createElement('div', props, children),
    DialogTitle: ({ children, ...props }) => React.createElement('h2', props, children)
  }
})

vi.mock('@cherrystudio/ui/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))

import { PopupHost } from '@renderer/components/PopupHost'

import ContentPopup from '../ContentPopup'

afterEach(() => {
  cleanup()
  vi.useFakeTimers()
  for (const entry of [...popupService.getSnapshot()]) {
    popupService.settle(entry.instanceId, false)
  }
  vi.advanceTimersByTime(POPUP_EXIT_MS)
  vi.useRealTimers()
})

describe('ContentPopup', () => {
  it('clamps every caller-provided width to the viewport so fixed sizes cannot overflow narrow windows', async () => {
    render(<PopupHost />)

    await act(async () => {
      void ContentPopup.show({
        title: 'Wide details',
        content: <div>details</div>,
        width: '60vw',
        styles: { content: { maxWidth: '1200px', minWidth: '600px' } }
      })
    })

    await screen.findByRole('dialog')
    const style = lastDialogContentStyle.style ?? {}
    for (const [prop, size] of [
      ['width', '60vw'],
      ['minWidth', '600px'],
      ['maxWidth', '1200px']
    ] as const) {
      expect(style[prop]).toBe(`min(${size}, calc(100vw - 2rem))`)
    }
  })

  it('clamps numeric widths and leaves unspecified dimensions alone', async () => {
    render(<PopupHost />)

    await act(async () => {
      void ContentPopup.show({
        title: 'Settings',
        content: <div>settings</div>,
        width: 600
      })
    })

    await screen.findByRole('dialog')
    const style = lastDialogContentStyle.style ?? {}
    expect(style.width).toBe('min(600px, calc(100vw - 2rem))')
    expect(style.minWidth).toBeUndefined()
  })
})
