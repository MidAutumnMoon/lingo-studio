/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/error/*, src/util/retry-error.ts) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md). `AISDKError`/`APICallError` are re-exported from
 * `@ai-sdk/provider` (the same class objects `ai` re-exports); the copies below keep upstream's
 * `Symbol.for('vercel.ai.error.*')` markers, so `isInstance` accepts instances from either copy.
 * The upstream `ai` dep still serves aiCore.
 */
import { AISDKError, APICallError, getErrorMessage } from '@ai-sdk/provider'

import type { UIMessage } from './types'

export { AISDKError, APICallError }

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
  readonly errors: Error[]
  readonly lastError: Error

  constructor({ message, reason, errors }: { message: string; reason: string; errors: Error[] }) {
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
