// Public API of the renderer-side AI-streaming runtime. Consumers import from
// this barrel; the directory's other files are internal. See
// docs/references/architecture/renderer.md §5.
export {
  type ChatRequestOptions,
  ChatStreamStore,
  type ChatStatus,
  type ChatStreamSnapshot,
  type ChatStreamTransport
} from './ChatStreamStore'
export { type ExecutionFinishEvent, executionStreamOverlayService } from './ExecutionStreamOverlayService'
export { getStreamBlockedMessage } from './getStreamBlockedMessage'
export { ipcChatTransport } from './IpcChatTransport'
