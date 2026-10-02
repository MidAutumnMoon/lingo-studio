/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/error/*, src/util/retry-error.ts) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md). `AISDKError`/`APICallError` are re-exported from
 * `@ai-sdk/provider` (the same class objects `ai` re-exports); the copies below keep upstream's
 * `Symbol.for('vercel.ai.error.*')` markers, so `isInstance` accepts instances from either copy.
 * The upstream `ai` dep still serves aiCore.
 */
import { AISDKError, APICallError, getErrorMessage, NoSuchModelError } from '@ai-sdk/provider'

import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage, UIMessage } from './types'

export { AISDKError, APICallError, NoSuchModelError }

function aiErrorMarker(name: string): { name: string; marker: string; symbol: symbol } {
  const marker = `vercel.ai.error.${name}`
  return { name, marker, symbol: Symbol.for(marker) }
}

/**
 * Thrown by the UI message stream when a chunk arrives that cannot be applied to the accumulator.
 */
export class UIMessageStreamError extends AISDKError {
  readonly chunkType: string
  readonly chunkId: string | undefined

  constructor({ chunkType, chunkId, message }: { chunkType: string; chunkId: string | undefined; message: string }) {
    const { name, symbol } = aiErrorMarker('AI_UIMessageStreamError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.chunkType = chunkType
    this.chunkId = chunkId
  }

  static isInstance(error: unknown): error is UIMessageStreamError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_UIMessageStreamError').marker)
  }
}

/**
 * Thrown when a message with an unsupported role is passed to `convertToModelMessages`.
 */
export class MessageConversionError extends AISDKError {
  readonly originalMessage: unknown

  constructor({ originalMessage, message }: { originalMessage: UIMessage; message: string }) {
    const { name, symbol } = aiErrorMarker('AI_MessageConversionError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.originalMessage = originalMessage
  }

  static isInstance(error: unknown): error is MessageConversionError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_MessageConversionError').marker)
  }
}

/**
 * Thrown when all retries of a failed operation have been exhausted.
 */
export class RetryError extends AISDKError {
  readonly reason: string
  readonly errors: Array<unknown>
  readonly lastError: unknown

  constructor({ message, reason, errors }: { message: string; reason: string; errors: Array<unknown> }) {
    const { name, symbol } = aiErrorMarker('AI_RetryError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.reason = reason
    this.errors = errors
    this.lastError = errors[errors.length - 1]
  }

  static isInstance(error: unknown): error is RetryError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_RetryError').marker)
  }
}

/**
 * Thrown when tool input is invalid.
 */
export class InvalidToolInputError extends AISDKError {
  readonly toolInput: string
  readonly toolName: string

  constructor({
    toolInput,
    toolName,
    cause,
    message = `Invalid input for tool ${toolName}: ${getErrorMessage(cause)}`
  }: {
    toolInput: string
    toolName: string
    cause: unknown
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_InvalidToolInputError')
    super({ name, message, cause })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.toolInput = toolInput
    this.toolName = toolName
  }

  static isInstance(error: unknown): error is InvalidToolInputError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_InvalidToolInputError').marker)
  }
}

/**
 * Thrown when a tool/function argument is invalid (`ai` defines its own shape,
 * distinct from @ai-sdk/provider's `argument`-keyed class).
 */
export class InvalidArgumentError extends AISDKError {
  readonly parameter: string
  readonly value: unknown

  constructor({ parameter, value, message }: { parameter: string; value: unknown; message: string }) {
    const { name, symbol } = aiErrorMarker('AI_InvalidArgumentError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.parameter = parameter
    this.value = value
  }

  static isInstance(error: unknown): error is InvalidArgumentError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_InvalidArgumentError').marker)
  }
}

/**
 * Thrown when a message role is not supported.
 */
export class InvalidMessageRoleError extends AISDKError {
  readonly role: string

  constructor({
    role,
    message = `Invalid message role: '${role}'. Must be one of: "system", "user", "assistant", "tool".`
  }: {
    role: string
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_InvalidMessageRoleError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.role = role
  }

  static isInstance(error: unknown): error is InvalidMessageRoleError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_InvalidMessageRoleError').marker)
  }
}

/**
 * Thrown when a data part content value has an unsupported type.
 */
export class InvalidDataContentError extends AISDKError {
  readonly content: unknown

  constructor({
    content,
    cause,
    message = `Invalid data content. Expected a base64 string, Uint8Array, ArrayBuffer, or Buffer, but got ${typeof content}.`
  }: {
    content: unknown
    cause?: unknown
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_InvalidDataContentError')
    super({ name, message, cause })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.content = content
  }

  static isInstance(error: unknown): error is InvalidDataContentError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_InvalidDataContentError').marker)
  }
}

/**
 * Thrown when the model tried to call a tool that is not in the tool set.
 */
export class NoSuchToolError extends AISDKError {
  readonly toolName: string
  readonly availableTools: string[] | undefined

  constructor({
    toolName,
    availableTools,
    message = availableTools === undefined || availableTools.length === 0
      ? `Model tried to call unavailable tool '${toolName}'. No tools are available.`
      : `Model tried to call unavailable tool '${toolName}'. Available tools: ${availableTools.join(', ')}.`
  }: {
    toolName: string
    availableTools?: string[] | undefined
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_NoSuchToolError')
    super({ name, message })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.toolName = toolName
    this.availableTools = availableTools
  }

  static isInstance(error: unknown): error is NoSuchToolError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_NoSuchToolError').marker)
  }
}

/**
 * Thrown when no provider can be found for a model id.
 */
export class NoSuchProviderError extends NoSuchModelError {
  readonly providerId: string
  readonly availableProviders: string[]

  constructor({
    modelId,
    modelType,
    providerId,
    availableProviders,
    message = `No such provider: ${providerId} (available providers: ${availableProviders.join(', ')})`
  }: {
    modelId: string
    modelType:
      | 'languageModel'
      | 'embeddingModel'
      | 'imageModel'
      | 'transcriptionModel'
      | 'speechModel'
      | 'rerankingModel'
      | 'videoModel'
    providerId: string
    availableProviders: string[]
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_NoSuchProviderError')
    super({ errorName: name, message, modelId, modelType })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.providerId = providerId
    this.availableProviders = availableProviders
  }

  static isInstance(error: unknown): error is NoSuchProviderError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_NoSuchProviderError').marker)
  }
}

/**
 * Thrown when no object could be generated.
 */
export class NoObjectGeneratedError extends AISDKError {
  readonly text: string | undefined
  readonly response: LanguageModelResponseMetadata | undefined
  readonly usage: LanguageModelUsage | undefined
  readonly finishReason: FinishReason | undefined

  constructor({
    message = 'No object generated.',
    cause,
    text,
    response,
    usage,
    finishReason
  }: {
    message?: string
    cause?: Error
    text?: string | undefined
    response: LanguageModelResponseMetadata
    usage: LanguageModelUsage
    finishReason: FinishReason
  }) {
    const { name, symbol } = aiErrorMarker('AI_NoObjectGeneratedError')
    super({ name, message, cause })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.text = text
    this.response = response
    this.usage = usage
    this.finishReason = finishReason
  }

  static isInstance(error: unknown): error is NoObjectGeneratedError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_NoObjectGeneratedError').marker)
  }
}

/**
 * Thrown when a tool call repair attempt fails.
 */
export class ToolCallRepairError extends AISDKError {
  readonly originalError: NoSuchToolError | InvalidToolInputError

  constructor({
    cause,
    originalError,
    message = `Error repairing tool call: ${getErrorMessage(cause)}`
  }: {
    cause: unknown
    originalError: NoSuchToolError | InvalidToolInputError
    message?: string
  }) {
    const { name, symbol } = aiErrorMarker('AI_ToolCallRepairError')
    super({ name, message, cause })
    ;(this as unknown as Record<symbol, boolean>)[symbol] = true
    this.originalError = originalError
  }

  static isInstance(error: unknown): error is ToolCallRepairError {
    return AISDKError.hasMarker(error, aiErrorMarker('AI_ToolCallRepairError').marker)
  }
}
