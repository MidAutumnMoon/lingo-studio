import { act, renderHook, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UIMessageChunk } from '@shared/ai/uiDialect'
import type { CherryUIMessage } from '@shared/data/types/message'

import { useChatWithHistory } from '../useChatWithHistory'

// The hook drives the real ChatStreamStore over the real IpcChatTransport;
// only the AI stream IPC surface is mocked, so tests exercise the actual
// contract: dispatch → chunk → done/error applied onto chat state.
const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    // Full signatures — tests below reassign richer implementations onto these.
    request: (route: string, input: unknown) => {
      void input
      return Promise.resolve(route === 'ai.stream.attach' ? { status: 'not-found' } : undefined)
    },
    on: (event: string, cb: (p: unknown) => void) => {
      void event
      void cb
      return () => {}
    }
  }
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input: unknown) => ipcMock.request(route, input),
    on: (event: string, cb: (payload: unknown) => void) => ipcMock.on(event, cb)
  }
}))

// `useTopicStreamStatus` is driven by the shared
// `topic.stream.statuses.${topicId}` cache entry in production. Tests
// stub it here so each `it()` can advance the per-topic view
// synchronously by calling `setMockStatus` + `rerender()`.
const mockTopicStreamStatus = vi.fn()
const LIVE_STATUSES = new Set(['streaming', 'pending'])
vi.mock('../useTopicStreamStatus', () => ({
  useTopicStreamStatus: (topicId: string) => mockTopicStreamStatus(topicId),
  useTopicDbRefreshOnAwaitingApproval: (topicId: string, refresh: () => Promise<unknown>) => {
    const status = mockTopicStreamStatus(topicId)?.status as string | undefined
    const prevRef = useRef<string | undefined>(undefined)
    const refreshRef = useRef(refresh)
    refreshRef.current = refresh
    useEffect(() => {
      const prev = prevRef.current
      prevRef.current = status
      if (prev && LIVE_STATUSES.has(prev) && status === 'awaiting-approval') {
        void refreshRef.current().catch(() => {})
      }
    }, [status])
  }
}))

function createIpcMock() {
  const streamOpen = vi.fn().mockResolvedValue({ mode: 'started' })
  const streamAttach = vi.fn().mockResolvedValue({ status: 'not-found' })
  const streamAbort = vi.fn().mockResolvedValue(undefined)
  const listeners = {
    chunk: [] as Array<(p: unknown) => void>,
    done: [] as Array<(p: unknown) => void>,
    error: [] as Array<(p: unknown) => void>
  }

  ipcMock.request = (route: string, input: unknown) => {
    switch (route) {
      case 'ai.stream.open':
        return streamOpen(input)
      case 'ai.stream.attach':
        return streamAttach(input)
      case 'ai.stream.abort':
        return streamAbort(input)
      default:
        return Promise.resolve(undefined)
    }
  }
  ipcMock.on = (event: string, cb: (p: unknown) => void) => {
    const key =
      event === 'ai.stream.chunk'
        ? 'chunk'
        : event === 'ai.stream.done'
          ? 'done'
          : event === 'ai.stream.error'
            ? 'error'
            : null
    if (!key) return () => {}
    const list = listeners[key]
    list.push(cb)
    return () => {
      const i = list.indexOf(cb)
      if (i >= 0) list.splice(i, 1)
    }
  }

  return {
    streamOpen,
    streamAttach,
    streamAbort,
    attachCallsFor: (topicId: string) => streamAttach.mock.calls.filter(([input]) => input?.topicId === topicId).length,
    emitChunk: (topicId: string, chunk: UIMessageChunk) => {
      for (const cb of [...listeners.chunk]) cb({ topicId, chunk })
    },
    emitDone: (topicId: string) => {
      for (const cb of [...listeners.done]) cb({ topicId, status: 'success' })
    },
    emitError: (topicId: string, message: string) => {
      for (const cb of [...listeners.error]) cb({ topicId, error: { name: 'Error', message, stack: null } })
    }
  }
}

/** The transport batches chunk events per animation frame. */
const flushFrames = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

describe('useChatWithHistory', () => {
  const refreshedMessages = [{ id: 'user-1', role: 'user', parts: [] }] as unknown as CherryUIMessage[]
  const statuses = new Map<string, string | undefined>()
  const setMockStatus = (topicId: string, status: string | undefined) => {
    statuses.set(topicId, status)
  }

  beforeEach(() => {
    statuses.clear()
    mockTopicStreamStatus.mockImplementation((topicId: string) => ({
      status: statuses.get(topicId),
      activeExecutions: [],
      awaitingApprovalAnchors: [],
      isPending: statuses.get(topicId) === 'pending' || statuses.get(topicId) === 'streaming',
      isFulfilled: statuses.get(topicId) === 'done',
      markSeen: vi.fn()
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a fresh chat store when the stable owner switches topics', () => {
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result, rerender } = renderHook(
      ({ topicId }: { topicId: string }) => useChatWithHistory(topicId, [], refresh),
      { initialProps: { topicId: 'topic-1' } }
    )
    const firstChat = result.current.chat

    rerender({ topicId: 'topic-2' })

    expect(result.current.chat.id).toBe('topic-2')
    expect(result.current.chat).not.toBe(firstChat)
  })

  it('applies a sent message and its stream onto chat state', async () => {
    const ipc = createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-send', [], refresh))

    let sent!: Promise<void>
    act(() => {
      sent = result.current.sendMessage({ text: 'Hello' })
    })

    // Optimistic user message + submitted status before any chunk arrives.
    expect(result.current.status).toBe('submitted')
    expect(result.current.chat.messages).toHaveLength(1)
    expect(result.current.chat.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] })
    expect(ipc.streamOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: 'topic-send',
        trigger: 'submit-message',
        userMessageParts: [{ type: 'text', text: 'Hello' }]
      })
    )

    ipc.emitChunk('topic-send', { type: 'start', messageId: 'assistant-1' })
    ipc.emitChunk('topic-send', { type: 'text-start', id: 't1' })
    ipc.emitChunk('topic-send', { type: 'text-delta', id: 't1', delta: 'Hi there' })
    await flushFrames()
    expect(result.current.status).toBe('streaming')

    ipc.emitDone('topic-send')
    await act(async () => {
      await sent
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeUndefined()
    expect(result.current.chat.messages).toHaveLength(2)
    expect(result.current.chat.messages[1]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hi there' }]
    })
  })

  it('surfaces stream errors as the error state', async () => {
    const ipc = createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-err', [], refresh))

    let sent!: Promise<void>
    act(() => {
      sent = result.current.sendMessage({ text: 'Hello' })
    })
    ipc.emitError('topic-err', 'Something went wrong')
    await act(async () => {
      await sent
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toBe('Something went wrong')
  })

  it('regenerate rejects on unknown messageId and otherwise truncates and re-sends', async () => {
    const ipc = createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-regen', [], refresh))
    await waitFor(() => expect(ipc.streamAttach).toHaveBeenCalled())

    await expect(result.current.regenerate({ messageId: 'missing' })).rejects.toThrow('message missing not found')

    const history: CherryUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Old answer' }] }
    ]
    act(() => {
      result.current.setMessages(history)
    })

    let regenerated!: Promise<void>
    act(() => {
      regenerated = result.current.regenerate({ messageId: 'a1', body: { parentAnchorId: 'u1' } })
    })
    ipc.emitChunk('topic-regen', { type: 'start', messageId: 'a2' })
    ipc.emitChunk('topic-regen', { type: 'text-start', id: 't1' })
    ipc.emitChunk('topic-regen', { type: 'text-delta', id: 't1', delta: 'New answer' })
    ipc.emitDone('topic-regen')
    await act(async () => {
      await regenerated
    })

    expect(ipc.streamOpen).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 'topic-regen', trigger: 'regenerate-message', parentAnchorId: 'u1' })
    )
    const messages = result.current.chat.messages
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a2'])
    expect(messages[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'New answer' }] })
  })

  it('stop() aborts the main stream, ends the local stream and keeps partial output', async () => {
    const ipc = createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-abort', [], refresh))

    let sent!: Promise<void>
    act(() => {
      sent = result.current.sendMessage({ text: 'Hello' })
    })
    ipc.emitChunk('topic-abort', { type: 'start', messageId: 'assistant-1' })
    ipc.emitChunk('topic-abort', { type: 'text-start', id: 't1' })
    ipc.emitChunk('topic-abort', { type: 'text-delta', id: 't1', delta: 'Partial' })
    await flushFrames()
    expect(result.current.status).toBe('streaming')

    await act(async () => {
      await result.current.stop()
      await sent
    })

    expect(ipc.streamAbort).toHaveBeenCalledWith({ topicId: 'topic-abort' })
    expect(result.current.status).toBe('ready')
    expect(result.current.chat.messages[1]).toMatchObject({
      id: 'assistant-1',
      parts: [{ type: 'text', text: 'Partial' }]
    })
  })

  it('stop() fires the abort IPC even when no local stream is active', async () => {
    // Reconnected streams carry no abort signal in the transport contract, so
    // the wrapper (not the SDK-era stream listener) must fire the IPC itself.
    const ipc = createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-abort', [], refresh))
    await waitFor(() => expect(ipc.streamAttach).toHaveBeenCalled())

    await act(async () => {
      await result.current.stop()
    })

    expect(ipc.streamAbort).toHaveBeenCalledWith({ topicId: 'topic-abort' })
  })

  it('does not resolve stop() until the main-process stream has drained', async () => {
    const ipc = createIpcMock()
    let finishDrain!: () => void
    ipc.streamAbort.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDrain = resolve
      })
    )
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-abort', [], refresh))
    await waitFor(() => expect(ipc.streamAttach).toHaveBeenCalled())

    const stopping = result.current.stop()
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)

    finishDrain()
    await expect(stopping).resolves.toBeUndefined()
  })

  it('rejects stop() when the main-process stream cannot be aborted', async () => {
    const ipc = createIpcMock()
    const abortError = new Error('main abort failed')
    ipc.streamAbort.mockRejectedValueOnce(abortError)
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { result } = renderHook(() => useChatWithHistory('topic-abort', [], refresh))
    await waitFor(() => expect(ipc.streamAttach).toHaveBeenCalled())

    await expect(result.current.stop()).rejects.toBe(abortError)
  })

  it('refreshes history before resuming the matching topic when another window starts streaming', async () => {
    const ipc = createIpcMock()
    let resolveRefresh!: () => void
    const refresh = vi.fn(
      () =>
        new Promise<CherryUIMessage[]>((resolve) => {
          resolveRefresh = () => resolve(refreshedMessages)
        })
    )

    const { rerender } = renderHook(() => useChatWithHistory('topic-1', [], refresh))
    await waitFor(() => expect(ipc.attachCallsFor('topic-1')).toBe(1))

    // Status change on a different topic must not trigger reattach.
    setMockStatus('other-topic', 'pending')
    rerender()
    expect(ipc.attachCallsFor('topic-1')).toBe(1)
    expect(refresh).not.toHaveBeenCalled()

    // Non-`pending` transitions on our topic must not retrigger reattach.
    setMockStatus('topic-1', 'streaming')
    rerender()
    expect(ipc.attachCallsFor('topic-1')).toBe(1)

    // A fresh `pending` on our topic = new ActiveStream created → refresh,
    // then reattach only once the refresh has settled.
    setMockStatus('topic-1', 'pending')
    rerender()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(ipc.attachCallsFor('topic-1')).toBe(1)

    await act(async () => {
      resolveRefresh()
    })
    await waitFor(() => expect(ipc.attachCallsFor('topic-1')).toBe(2))
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(ipc.streamAttach.mock.invocationCallOrder[1])
  })

  it('refreshes when the topic transitions from a live status to awaiting approval', async () => {
    createIpcMock()
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    setMockStatus('topic-1', 'streaming')
    const { rerender } = renderHook(() => useChatWithHistory('topic-1', [], refresh))

    setMockStatus('topic-1', 'awaiting-approval')
    rerender()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    // Idempotent on re-render at the same paused status.
    rerender()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('does not re-attach when the store status flaps after the mount attach', async () => {
    // Regression: the mount-resume effect must not depend on the store's
    // status — every ready/error edge of a terminated resumed stream would
    // otherwise immediately re-attach, spinning a hot reconnect loop.
    const ipc = createIpcMock()
    ipc.streamAttach.mockResolvedValue({
      status: 'attached',
      bufferedChunks: [{ topicId: 'topic-flap', chunk: { type: 'start', messageId: 'm1' } }]
    })
    const refresh = vi.fn().mockResolvedValue(refreshedMessages)
    const { rerender } = renderHook(() => useChatWithHistory('topic-flap', [], refresh))
    await waitFor(() => expect(ipc.attachCallsFor('topic-flap')).toBe(1))

    // The buffered chunk flipped the store to streaming; topic status flaps
    // and the store's own ready edge (stream done) must not re-attach.
    for (const status of ['streaming', 'done', 'error', 'ready', 'streaming']) {
      setMockStatus('topic-flap', status)
      rerender()
    }
    ipc.emitDone('topic-flap')
    await flushFrames()
    expect(ipc.attachCallsFor('topic-flap')).toBe(1)
  })

  it('does not let a stale topic refresh resume the newly selected topic', async () => {
    const ipc = createIpcMock()
    let resolveTopicOneRefresh!: () => void
    const topicOneRefresh = vi.fn(
      () =>
        new Promise<CherryUIMessage[]>((resolve) => {
          resolveTopicOneRefresh = () => resolve(refreshedMessages)
        })
    )
    const topicTwoRefresh = vi.fn().mockResolvedValue(refreshedMessages)

    const { rerender } = renderHook(
      ({ topicId, refresh }: { topicId: string; refresh: () => Promise<CherryUIMessage[]> }) =>
        useChatWithHistory(topicId, [], refresh),
      { initialProps: { topicId: 'topic-1', refresh: topicOneRefresh } }
    )
    await waitFor(() => expect(ipc.attachCallsFor('topic-1')).toBe(1))

    setMockStatus('topic-1', 'pending')
    rerender({ topicId: 'topic-1', refresh: topicOneRefresh })
    await waitFor(() => expect(topicOneRefresh).toHaveBeenCalledTimes(1))

    rerender({ topicId: 'topic-2', refresh: topicTwoRefresh })
    await waitFor(() => expect(ipc.attachCallsFor('topic-2')).toBe(1))

    await act(async () => {
      resolveTopicOneRefresh()
    })
    await flushFrames()

    expect(ipc.attachCallsFor('topic-2')).toBe(1)
    expect(ipc.attachCallsFor('topic-1')).toBe(1)
  })

  it('does not reuse a stale in-flight refresh after selecting the same topic again', async () => {
    const ipc = createIpcMock()
    let resolveFirstTopicRefresh!: () => void
    const topicOneRefresh = vi.fn(
      () =>
        new Promise<CherryUIMessage[]>((resolve) => {
          resolveFirstTopicRefresh = () => resolve(refreshedMessages)
        })
    )
    const topicTwoRefresh = vi.fn().mockResolvedValue(refreshedMessages)

    const { rerender } = renderHook(
      ({ topicId, refresh }: { topicId: string; refresh: () => Promise<CherryUIMessage[]> }) =>
        useChatWithHistory(topicId, [], refresh),
      { initialProps: { topicId: 'topic-1', refresh: topicOneRefresh } }
    )
    await waitFor(() => expect(ipc.attachCallsFor('topic-1')).toBe(1))

    setMockStatus('topic-1', 'pending')
    rerender({ topicId: 'topic-1', refresh: topicOneRefresh })
    await waitFor(() => expect(topicOneRefresh).toHaveBeenCalledTimes(1))

    rerender({ topicId: 'topic-2', refresh: topicTwoRefresh })
    await waitFor(() => expect(ipc.attachCallsFor('topic-2')).toBe(1))

    rerender({ topicId: 'topic-1', refresh: topicOneRefresh })
    await waitFor(() => expect(ipc.attachCallsFor('topic-1')).toBe(2))

    await act(async () => {
      resolveFirstTopicRefresh()
    })
    await flushFrames()
    expect(ipc.attachCallsFor('topic-1')).toBe(2)
  })

  it('does not refresh on streaming → aborted/error because page handoff owns final refresh', async () => {
    for (const terminal of ['aborted', 'error'] as const) {
      const ipc = createIpcMock()
      const refresh = vi.fn().mockResolvedValue(refreshedMessages)
      setMockStatus('topic-x', 'streaming')
      const { rerender, unmount } = renderHook(() => useChatWithHistory('topic-x', [], refresh))
      await waitFor(() => expect(ipc.streamAttach).toHaveBeenCalled())
      refresh.mockClear()

      setMockStatus('topic-x', terminal)
      rerender()
      expect(refresh).not.toHaveBeenCalled()
      unmount()
    }
  })
})
