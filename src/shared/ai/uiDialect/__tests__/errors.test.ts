import {
  APICallError as AiAPICallError,
  AISDKError as AiAISDKError,
  InvalidArgumentError as AiInvalidArgumentError,
  InvalidDataContentError as AiInvalidDataContentError,
  InvalidMessageRoleError as AiInvalidMessageRoleError,
  InvalidToolInputError as AiInvalidToolInputError,
  MessageConversionError as AiMessageConversionError,
  NoObjectGeneratedError as AiNoObjectGeneratedError,
  NoSuchProviderError as AiNoSuchProviderError,
  NoSuchToolError as AiNoSuchToolError,
  RetryError as AiRetryError,
  ToolCallRepairError as AiToolCallRepairError,
  UIMessageStreamError as AiUIMessageStreamError
} from 'ai'
import { describe, expect, it } from 'vitest'

import {
  AISDKError,
  APICallError,
  InvalidArgumentError,
  InvalidDataContentError,
  InvalidMessageRoleError,
  InvalidToolInputError,
  MessageConversionError,
  NoObjectGeneratedError,
  NoSuchProviderError,
  NoSuchToolError,
  RetryError,
  ToolCallRepairError,
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

  it('vendored InvalidArgumentError matches ai own class (provider re-declares a different shape)', () => {
    const ours = new InvalidArgumentError({
      parameter: 'temperature',
      value: 'x',
      message: 'Invalid argument for parameter temperature: x'
    })
    const theirs = new AiInvalidArgumentError({
      parameter: 'temperature',
      value: 'x',
      message: 'Invalid argument for parameter temperature: x'
    })

    expect(InvalidArgumentError.isInstance(theirs)).toBe(true)
    expect(AiInvalidArgumentError.isInstance(ours)).toBe(true)
    expect(ours.parameter).toBe('temperature')
    expect(ours.value).toBe('x')
  })

  it('vendored InvalidMessageRoleError and InvalidDataContentError cross-detect ai instances', () => {
    const roleOurs = new InvalidMessageRoleError({ role: 'tool' })
    const roleTheirs = new AiInvalidMessageRoleError({ role: 'tool' })
    expect(InvalidMessageRoleError.isInstance(roleTheirs)).toBe(true)
    expect(AiInvalidMessageRoleError.isInstance(roleOurs)).toBe(true)
    expect(roleOurs.message).toBe(roleTheirs.message)

    const dataOurs = new InvalidDataContentError({ content: 42 })
    const dataTheirs = new AiInvalidDataContentError({ content: 42 })
    expect(InvalidDataContentError.isInstance(dataTheirs)).toBe(true)
    expect(AiInvalidDataContentError.isInstance(dataOurs)).toBe(true)
    expect(dataOurs.content).toBe(42)
  })

  it('vendored NoSuchToolError and NoSuchProviderError cross-detect ai instances and carry discriminants', () => {
    const toolOurs = new NoSuchToolError({ toolName: 'web_search', availableTools: ['kb_search'] })
    const toolTheirs = new AiNoSuchToolError({ toolName: 'web_search', availableTools: ['kb_search'] })
    expect(NoSuchToolError.isInstance(toolTheirs)).toBe(true)
    expect(AiNoSuchToolError.isInstance(toolOurs)).toBe(true)
    expect(toolOurs.message).toBe(toolTheirs.message)
    expect(toolOurs.availableTools).toEqual(['kb_search'])

    const provOurs = new NoSuchProviderError({
      modelId: 'openai::gpt-4o',
      modelType: 'languageModel',
      providerId: 'nope',
      availableProviders: ['openai', 'anthropic']
    })
    const provTheirs = new AiNoSuchProviderError({
      modelId: 'openai::gpt-4o',
      modelType: 'languageModel',
      providerId: 'nope',
      availableProviders: ['openai', 'anthropic']
    })
    expect(NoSuchProviderError.isInstance(provTheirs)).toBe(true)
    expect(AiNoSuchProviderError.isInstance(provOurs)).toBe(true)
    expect(provOurs.providerId).toBe('nope')
    expect(provOurs.modelId).toBe('openai::gpt-4o')
  })

  it('vendored NoObjectGeneratedError and ToolCallRepairError cross-detect ai instances', () => {
    const response = { id: 'resp-1', timestamp: new Date(0), modelId: 'openai::gpt-4o' }
    const usage = {
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokens: 5,
      outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
      totalTokens: 15
    }
    const objOurs = new NoObjectGeneratedError({
      cause: new Error('parse'),
      text: 'partial',
      response,
      usage,
      finishReason: 'stop'
    })
    const objTheirs = new AiNoObjectGeneratedError({
      cause: new Error('parse'),
      text: 'partial',
      response,
      usage,
      finishReason: 'stop'
    })
    expect(NoObjectGeneratedError.isInstance(objTheirs)).toBe(true)
    expect(AiNoObjectGeneratedError.isInstance(objOurs)).toBe(true)
    expect(objOurs.text).toBe('partial')
    expect(objOurs.message).toBe('No object generated.')

    const oursOriginal = new NoSuchToolError({ toolName: 't' })
    const repairOurs = new ToolCallRepairError({ cause: new Error('bad json'), originalError: oursOriginal })
    const theirsOriginal = new AiNoSuchToolError({ toolName: 't' })
    const repairTheirs = new AiToolCallRepairError({ cause: new Error('bad json'), originalError: theirsOriginal })
    expect(ToolCallRepairError.isInstance(repairTheirs)).toBe(true)
    expect(AiToolCallRepairError.isInstance(repairOurs)).toBe(true)
    expect(repairOurs.originalError).toBe(oursOriginal)
    expect(repairTheirs.originalError).toBe(theirsOriginal)
  })
})
