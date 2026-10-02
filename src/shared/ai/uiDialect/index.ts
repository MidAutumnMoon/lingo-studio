/**
 * Vendored UI-message dialect from ai@6.0.185 (with the local structural-sharing perf patch) —
 * Phase-2 D3 (docs/plans/2026-09-pi-unification.md Track B). Consumers import the wire format
 * (`UIMessage`/`UIMessageChunk` + parts, predicates, the stream accumulator, the model-message
 * converter, the error taxonomy) from here instead of the `ai` npm package, which still serves
 * aiCore. Structural shapes are frozen: DB column, `ai.stream.*` IPC, gateway SSE all unchanged.
 */
export { asSchema } from '@ai-sdk/provider-utils'
// Same class objects / type identities `ai` re-exports — kept as re-exports, not copies.
export type { DownloadError } from '@ai-sdk/provider-utils'
export type { ModelMessage } from '@ai-sdk/provider-utils'
export type {
  InvalidPromptError,
  JSONParseError,
  TypeValidationError,
  UnsupportedFunctionalityError
} from '@ai-sdk/provider'

export { convertToModelMessages } from './convertToModelMessages'
export {
  AISDKError,
  APICallError,
  InvalidArgumentError,
  InvalidDataContentError,
  InvalidMessageRoleError,
  InvalidToolInputError,
  MessageConversionError,
  NoObjectGeneratedError,
  NoSuchModelError,
  NoSuchProviderError,
  NoSuchToolError,
  RetryError,
  ToolCallRepairError,
  UIMessageStreamError
} from './errors'
export { readUIMessageStream } from './readUIMessageStream'
export type {
  AsyncIterableStream,
  DataUIMessageChunk,
  DataUIPart,
  DynamicToolUIPart,
  EmbeddingModelUsage,
  FileUIPart,
  FinishReason,
  InferUIMessageChunk,
  InferUIMessageData,
  InferUIMessageMetadata,
  InferUIMessageTools,
  InferUITool,
  InferUITools,
  LanguageModelResponseMetadata,
  LanguageModelUsage,
  ProviderMetadata,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  StepStartUIPart,
  TextUIPart,
  ToolSet,
  ToolUIPart,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UIMessagePart,
  UITool,
  UIToolInvocation,
  UITools
} from './types'
export {
  getStaticToolName,
  getToolName,
  isDataUIPart,
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
  isToolUIPart
} from './uiParts'
