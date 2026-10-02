import { createStreamingUIMessageState, processUIMessageStream } from './processUIMessageStream'
/**
 * Vendored from the PATCHED ai@6.0.185 install (`patches/ai@6.0.185.patch`,
 * node_modules/ai/dist/index.mjs src/ui-message-stream/read-ui-message-stream.ts + src/util/*) —
 * Phase-2 D3 (docs/plans/2026-09-pi-unification.md): `src/` drops runtime-value imports from the
 * `ai` package without touching the wire format; the upstream dep still serves aiCore.
 */
import type { AsyncIterableStream, UIMessage, UIMessageChunk, UIMessageStreamJobExecutor } from './types'

/**
 * PATCHED(cherry): structural-sharing snapshot (mirrors vercel/ai#18692) — structuredClone here
 * was O(message bytes) per chunk, melting the renderer on long fast streams (vercel/ai#18624).
 */
function cherrySnapshotUIMessage(message: UIMessage): UIMessage {
  const snapshot = { ...message, parts: message.parts.map((part) => ({ ...part })) }
  if ('metadata' in message) {
    const metadata = (message as { metadata?: unknown }).metadata
    snapshot.metadata = Array.isArray(metadata)
      ? [...metadata]
      : metadata !== null && typeof metadata === 'object'
        ? { ...metadata }
        : metadata
  }
  return snapshot
}

export function readUIMessageStream<UI_MESSAGE extends UIMessage>({
  message,
  stream,
  onError,
  terminateOnError = false
}: {
  /**
   * The last assistant message to use as a starting point when the conversation is resumed.
   * Otherwise undefined.
   */
  message?: UI_MESSAGE | undefined
  /**
   * The stream of UIMessageChunks to read.
   */
  stream: ReadableStream<UIMessageChunk>
  /**
   * Whether to terminate the stream if an error occurs.
   */
  terminateOnError?: boolean | undefined
  /**
   * A function that is called when an error occurs.
   */
  onError?: ((error: unknown) => void) | undefined
}): AsyncIterableStream<UI_MESSAGE> {
  let controller: ReadableStreamDefaultController<UI_MESSAGE> | undefined
  let hasErrored = false

  const outputStream = new ReadableStream<UI_MESSAGE>({
    start(controllerParam) {
      controller = controllerParam
    }
  })

  const state = createStreamingUIMessageState<UI_MESSAGE>({
    messageId: message?.id ?? '',
    lastMessage: message
  })

  const handleError = (error: unknown) => {
    onError?.(error)
    if (!hasErrored && terminateOnError) {
      hasErrored = true
      controller?.error(error)
    }
  }

  const runUpdateMessageJob: UIMessageStreamJobExecutor = (job) =>
    job({
      state,
      write: () => {
        controller?.enqueue(cherrySnapshotUIMessage(state.message) as unknown as UI_MESSAGE)
      }
    })

  void consumeStream({
    stream: processUIMessageStream({
      stream,
      runUpdateMessageJob,
      onError: handleError
    }),
    onError: handleError
  }).finally(() => {
    if (!hasErrored) {
      controller?.close()
    }
  })

  return createAsyncIterableStream(outputStream)
}

async function consumeStream({
  stream,
  onError
}: {
  stream: ReadableStream<unknown>
  onError?: (error: unknown) => void
}) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch (error) {
    onError?.(error)
  } finally {
    reader.releaseLock()
  }
}

function createAsyncIterableStream<T>(source: ReadableStream<T>): AsyncIterableStream<T> {
  const stream = source.pipeThrough(new TransformStream<T, T>()) as AsyncIterableStream<T>

  ;(stream as any)[Symbol.asyncIterator] = function (this: ReadableStream<T>) {
    const reader = this.getReader()
    let finished = false

    async function cleanup(cancelStream: boolean) {
      if (finished) return
      finished = true
      try {
        if (cancelStream) {
          await reader.cancel?.()
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // already released
        }
      }
    }

    return {
      async next() {
        if (finished) {
          return { done: true, value: undefined }
        }
        const { done, value } = await reader.read()
        if (done) {
          await cleanup(true)
          return { done: true, value: undefined }
        }
        return { done: false, value }
      },
      async return() {
        await cleanup(true)
        return { done: true, value: undefined }
      },
      async throw(err: unknown) {
        await cleanup(true)
        throw err
      }
    }
  }

  return stream
}
