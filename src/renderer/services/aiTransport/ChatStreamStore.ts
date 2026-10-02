/**
 * First-party per-topic chat runtime — the Track B replacement for
 * `@ai-sdk/react`'s `Chat`/`useChat` (docs/plans/2026-09-pi-unification.md).
 * Applies UIMessageChunk streams from the IPC transport onto a messages array
 * and exposes status/error reactively. Message application mirrors the retired
 * SDK `Chat`: an optimistic user message on send, trailing-message truncation
 * on regenerate, resume onto the last assistant message, abort keeping partial
 * output. Only status/error notify React — no consumer renders `messages`
 * (live streaming text renders via `executionStreamOverlayService`), so the
 * SDK's per-chunk re-render throttle has no equivalent by design.
 */
import { loggerService } from '@logger'
import { uuid } from '@renderer/utils/uuid'
import { type FileUIPart, readUIMessageStream, type UIMessageChunk } from '@shared/ai/uiDialect'
import type { CherryUIMessage } from '@shared/data/types/message'

import { ipcChatTransport } from './IpcChatTransport'

const logger = loggerService.withContext('ChatStreamStore')

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

/** Structural stand-in for the retired `ai` `ChatRequestOptions`. */
export interface ChatRequestOptions {
  headers?: Record<string, string> | Headers
  body?: object
  metadata?: unknown
}

/** Minimal transport surface the store drives — satisfied by `IpcChatTransport`. */
export interface ChatStreamTransport {
  sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message'
    chatId: string
    messageId: string | undefined
    messages: CherryUIMessage[]
    abortSignal: AbortSignal | undefined
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>>
  reconnectToStream(options: { chatId: string } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk> | null>
}

/** Reactive surface for `useSyncExternalStore`; `messages` stays imperative-only. */
export interface ChatStreamSnapshot {
  status: ChatStatus
  error: Error | undefined
}

export interface ChatStreamStoreOptions {
  id: string
  transport?: ChatStreamTransport
  messages?: CherryUIMessage[]
  onError?: (error: Error) => void
}

/** `readUIMessageStream` mutates the seed message's parts in place — clone so live rows stay intact. */
function snapshotMessage(message: CherryUIMessage): CherryUIMessage {
  return { ...message, parts: message.parts.map((part) => ({ ...part })) }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export class ChatStreamStore {
  readonly id: string
  readonly #transport: ChatStreamTransport
  readonly #onError: ((error: Error) => void) | undefined
  readonly #listeners = new Set<() => void>()
  #messages: CherryUIMessage[]
  #status: ChatStatus = 'ready'
  #error: Error | undefined
  #snapshot: ChatStreamSnapshot = { status: 'ready', error: undefined }
  #activeAbort: AbortController | undefined

  constructor({ id, transport = ipcChatTransport, messages = [], onError }: ChatStreamStoreOptions) {
    this.id = id
    this.#transport = transport
    this.#messages = messages
    this.#onError = onError
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): ChatStreamSnapshot => this.#snapshot

  get messages(): CherryUIMessage[] {
    return this.#messages
  }

  get status(): ChatStatus {
    return this.#status
  }

  get error(): Error | undefined {
    return this.#error
  }

  setMessages = (messages: CherryUIMessage[] | ((current: CherryUIMessage[]) => CherryUIMessage[])): void => {
    const next = typeof messages === 'function' ? messages(this.#messages) : messages
    this.#messages = [...next]
  }

  sendMessage = async (
    message?: { text: string; files?: FileUIPart[] },
    options?: ChatRequestOptions
  ): Promise<void> => {
    if (message == null) {
      await this.#makeRequest({ trigger: 'submit-message', messageId: this.#messages.at(-1)?.id, ...options })
      return
    }
    this.#messages = [
      ...this.#messages,
      {
        id: uuid(),
        role: 'user',
        parts: [...(message.files ?? []), { type: 'text', text: message.text }]
      }
    ]
    await this.#makeRequest({ trigger: 'submit-message', ...options })
  }

  regenerate = async (options?: ChatRequestOptions & { messageId?: string }): Promise<void> => {
    const { messageId, ...requestOptions } = options ?? {}
    const messageIndex =
      messageId == null ? this.#messages.length - 1 : this.#messages.findIndex((message) => message.id === messageId)
    if (messageIndex === -1) {
      throw new Error(`message ${messageId} not found`)
    }
    this.#messages = this.#messages.slice(
      0,
      this.#messages[messageIndex].role === 'assistant' ? messageIndex : messageIndex + 1
    )
    await this.#makeRequest({ trigger: 'regenerate-message', messageId, ...requestOptions })
  }

  resumeStream = async (): Promise<void> => {
    await this.#makeRequest({ trigger: 'resume-stream' })
  }

  /** Abort the active request immediately, keeping any generated partial output. */
  stop = async (): Promise<void> => {
    if (this.#status !== 'streaming' && this.#status !== 'submitted') return
    this.#activeAbort?.abort()
  }

  // ── internals ──────────────────────────────────────────────────────

  async #makeRequest({
    trigger,
    messageId,
    ...requestOptions
  }: {
    trigger: 'submit-message' | 'regenerate-message' | 'resume-stream'
    messageId?: string
  } & ChatRequestOptions): Promise<void> {
    let resumeStream: ReadableStream<UIMessageChunk> | undefined
    if (trigger === 'resume-stream') {
      try {
        const reconnect = await this.#transport.reconnectToStream({ chatId: this.id, ...requestOptions })
        if (reconnect == null) return
        resumeStream = reconnect
      } catch (err) {
        this.#failRequest(err)
        return
      }
    }

    this.#setStatus('submitted', undefined)
    const lastMessage = this.#messages.at(-1)
    let isAbort = false
    try {
      const abortController = new AbortController()
      abortController.signal.addEventListener('abort', () => {
        isAbort = true
      }, { once: true })
      this.#activeAbort = abortController
      const stream =
        trigger === 'resume-stream'
          ? (resumeStream as ReadableStream<UIMessageChunk>) // the resume branch above returned when null
          : await this.#transport.sendMessages({
              trigger,
              chatId: this.id,
              messageId,
              messages: this.#messages,
              abortSignal: abortController.signal,
              ...requestOptions
            })
      // A stream continues the last assistant message when there is one; otherwise it opens a new assistant row.
      const seed = lastMessage?.role === 'assistant' ? snapshotMessage(lastMessage) : undefined
      for await (const message of readUIMessageStream<CherryUIMessage>({
        stream,
        message: seed,
        terminateOnError: true
      })) {
        this.#setStatus('streaming', undefined)
        this.#messages =
          this.#messages.at(-1)?.id === message.id
            ? [...this.#messages.slice(0, -1), message]
            : [...this.#messages, message]
      }
      this.#setStatus('ready', undefined)
    } catch (err) {
      if (isAbort || (err instanceof Error && err.name === 'AbortError')) {
        this.#setStatus('ready', undefined)
        return
      }
      this.#failRequest(err)
    } finally {
      this.#activeAbort = undefined
    }
  }

  #failRequest(err: unknown): void {
    if (err instanceof Error) this.#onError?.(err)
    this.#setStatus('error', asError(err))
  }

  #setStatus(status: ChatStatus, error: Error | undefined): void {
    if (this.#status === status) return
    this.#status = status
    this.#error = error
    this.#snapshot = { status, error }
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (err) {
        logger.warn('chat store listener threw', { topicId: this.id, err })
      }
    }
  }
}
