import {
  APICallError as AiAPICallError,
  AISDKError as AiAISDKError,
  InvalidToolInputError as AiInvalidToolInputError,
  MessageConversionError as AiMessageConversionError,
  RetryError as AiRetryError,
  UIMessageStreamError as AiUIMessageStreamError
} from 'ai'
import { describe, expect, it } from 'vitest'

import {
  AISDKError,
  APICallError,
  InvalidToolInputError,
  MessageConversionError,
  RetryError,
  UIMessageStreamError
} from '../index'

/**
 * Contract: the vendored error taxonomy stays marker-compatible with the `ai` package's classes —
 * instances cross-detect through the `Symbol.for('vercel.ai.error.*')` markers (vercel's own
 * cross-copy identity mechanism), and the provider-resident classes are literally the same objects.
 */
describe('uiDialect error taxonomy — marker interop with ai@6.0.185', () => {
  it('AISDKError and APICallError are the same class objects ai re-exports (they live in @ai-sdk/provider)', () => {
    expect(AISDKError).toBe(AiAISDKError)
    expect(APICallError).toBe(AiAPICallError)
  })

  it('vendored RetryError cross-detects ai package instances and vice versa', () => {
    const ours = new RetryError({
      message: 'failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [new Error('a'), new Error('b')]
    })
    const theirs = new AiRetryError({ message: 'm', reason: 'maxRetriesExceeded', errors: [new Error('x')] })

    expect(RetryError.isInstance(ours)).toBe(true)
    expect(RetryError.isInstance(theirs)).toBe(true)
    expect(AiRetryError.isInstance(ours)).toBe(true)
    expect(ours.errors).toHaveLength(2)
    expect(ours.lastError).toBe(ours.errors[1])
  })

  it('vendored InvalidToolInputError cross-detects ai package instances', () => {
    const ours = new InvalidToolInputError({ toolInput: '{"a":1}', toolName: 't', cause: new Error('bad') })
    const theirs = new AiInvalidToolInputError({ toolInput: '{}', toolName: 't', cause: new Error('bad') })

    expect(InvalidToolInputError.isInstance(ours)).toBe(true)
    expect(InvalidToolInputError.isInstance(theirs)).toBe(true)
    expect(AiInvalidToolInputError.isInstance(ours)).toBe(true)
    expect(ours.message).toBe('Invalid input for tool t: bad')
  })

  it('vendored UIMessageStreamError and MessageConversionError cross-detect ai package instances', () => {
    const streamErr = new UIMessageStreamError({ chunkType: 'text-delta', chunkId: 'x', message: 'm' })
    const theirStreamErr = new AiUIMessageStreamError({ chunkType: 'text-delta', chunkId: 'x', message: 'm' })
    expect(UIMessageStreamError.isInstance(streamErr)).toBe(true)
    expect(UIMessageStreamError.isInstance(theirStreamErr)).toBe(true)
    expect(AiUIMessageStreamError.isInstance(streamErr)).toBe(true)
    expect(streamErr.name).toBe('AI_UIMessageStreamError')

    const convErr = new MessageConversionError({
      originalMessage: { id: 'm', role: 'tool', parts: [] } as any,
      message: 'Unsupported role: tool'
    })
    const theirConvErr = new AiMessageConversionError({
      originalMessage: { id: 'm', role: 'tool', parts: [] } as any,
      message: 'Unsupported role: tool'
    })
    expect(MessageConversionError.isInstance(convErr)).toBe(true)
    expect(MessageConversionError.isInstance(theirConvErr)).toBe(true)
    expect(AiMessageConversionError.isInstance(convErr)).toBe(true)
  })

  it('marker checks reject plain errors and non-error values', () => {
    expect(RetryError.isInstance(new Error('plain'))).toBe(false)
    expect(RetryError.isInstance(undefined)).toBe(false)
    expect(RetryError.isInstance(null)).toBe(false)
    expect(InvalidToolInputError.isInstance(new RetryError({ message: 'm', reason: 'r', errors: [] }))).toBe(false)
  })

  it('all vendored errors are AISDKErrors (base-class detection works across both module graphs)', () => {
    expect(AISDKError.isInstance(new RetryError({ message: 'm', reason: 'r', errors: [] }))).toBe(true)
    expect(
      AiAISDKError.isInstance(new InvalidToolInputError({ toolInput: '1', toolName: 't', cause: undefined }))
    ).toBe(true)
  })
})
