import { describe, expect, it } from 'vitest'

import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { applyUserTextSuffix, resolveUserThinkingSuffix, type UserThinkingSuffixInput } from './userThinkingSuffix'

function model(id: string): Model {
  return {
    id,
    name: id,
    provider: 'nvidia',
    capabilities: [],
    // `isSupportedThinkingTokenQwenModel` ends in `thinkingTokenLimits != null`.
    reasoning: { thinkingTokenLimits: { min: 0, max: 1000 } }
  } as unknown as Model
}

// Model ids are `providerId/apiModelId` unique ids — getRawModelId parses the separator.
function qwen(id: string): Model {
  return model(`nvidia::${id}`)
}

function provider(id: string): Provider {
  return { id, name: id } as unknown as Provider
}

function input(overrides: Partial<UserThinkingSuffixInput> = {}): UserThinkingSuffixInput {
  return {
    provider: provider('nvidia'),
    model: qwen('qwen3-235b-a22b'),
    reasoningKind: 'auto',
    hasAssistant: true,
    hasExplicitReasoningEffort: false,
    mcpToolCount: 0,
    ...overrides
  }
}

describe('resolveUserThinkingSuffix', () => {
  it('suffices a qwen thinking-token model on a provider without enable_thinking', () => {
    expect(resolveUserThinkingSuffix(input())).toEqual({ text: ' /think', scope: 'every-text-part' })
    expect(resolveUserThinkingSuffix(input({ reasoningKind: 'off' }))).toEqual({
      text: ' /no_think',
      scope: 'every-text-part'
    })
  })

  it('skips the qwen dialect for omitted reasoning, enable_thinking providers, ollama, and qwen3.5+', () => {
    expect(resolveUserThinkingSuffix(input({ reasoningKind: 'omit' }))).toBeUndefined()
    // dashscope is not in the deny list → enable_thinking provider → no suffix.
    expect(resolveUserThinkingSuffix(input({ provider: provider('dashscope') }))).toBeUndefined()
    expect(resolveUserThinkingSuffix(input({ provider: provider('ollama') }))).toBeUndefined()
    expect(resolveUserThinkingSuffix(input({ model: qwen('qwen3.5-instruct') }))).toBeUndefined()
    // The outer gate: neither an assistant nor an explicit effort.
    expect(resolveUserThinkingSuffix(input({ hasAssistant: false }))).toBeUndefined()
    expect(resolveUserThinkingSuffix(input({ hasAssistant: false, hasExplicitReasoningEffort: true }))).toEqual({
      text: ' /think',
      scope: 'every-text-part'
    })
  })

  it('suffices ovms with the final-block scope only when MCP tools are declared', () => {
    const ovms = input({ provider: provider('ovms'), model: model('ovms::gpt-oss-120b') })
    expect(resolveUserThinkingSuffix(ovms)).toBeUndefined()
    expect(resolveUserThinkingSuffix({ ...ovms, mcpToolCount: 2 })).toEqual({
      text: ' /no_think',
      scope: 'final-text-block'
    })
  })

  it('returns undefined for ordinary combinations', () => {
    expect(
      resolveUserThinkingSuffix(input({ provider: provider('openrouter'), model: model('openrouter::gpt-5') }))
    ).toBeUndefined()
  })
})

describe('applyUserTextSuffix', () => {
  it('guards both tokens for the qwen scope and only /no_think for the ovms scope', () => {
    const qwen = { text: ' /think', scope: 'every-text-part' as const }
    expect(applyUserTextSuffix('hello', qwen)).toBe('hello /think')
    expect(applyUserTextSuffix('hello /think', qwen)).toBe('hello /think')
    expect(applyUserTextSuffix('hello /no_think', qwen)).toBe('hello /no_think')

    const ovms = { text: ' /no_think', scope: 'final-text-block' as const }
    expect(applyUserTextSuffix('hello', ovms)).toBe('hello /no_think')
    expect(applyUserTextSuffix('hello /no_think', ovms)).toBe('hello /no_think')
    // Legacy ovms only guards /no_think — a /think ending still gets the suffix.
    expect(applyUserTextSuffix('hello /think', ovms)).toBe('hello /think /no_think')
  })
})
