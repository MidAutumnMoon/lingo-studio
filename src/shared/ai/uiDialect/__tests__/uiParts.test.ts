import { getToolName as aiGetToolName, isToolUIPart as aiIsToolUIPart } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  isDataUIPart,
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
  isToolUIPart,
  getStaticToolName,
  getToolName,
  type UIDataTypes,
  type UIMessagePart,
  type UITools
} from '../index'

type AnyUIMessagePart = UIMessagePart<UIDataTypes, UITools>

describe('uiParts predicates — vendored parity with ai@6.0.185', () => {
  const part = (p: { type: string } & Record<string, unknown>): AnyUIMessagePart => p as AnyUIMessagePart

  it.each([
    ['tool-web_search', true],
    ['tool-a-b-c', true],
    ['dynamic-tool', true],
    ['text', false],
    ['data-x', false]
  ])('isToolUIPart(%s) === %s', (type, expected) => {
    expect(isToolUIPart(part({ type }))).toBe(expected)
    expect(aiIsToolUIPart(part({ type }))).toBe(expected)
  })

  it('getToolName extracts static tool names including embedded dashes, and dynamic tool names', () => {
    expect(getToolName(part({ type: 'tool-web_search', toolCallId: 'c' }) as any)).toBe('web_search')
    expect(getToolName(part({ type: 'tool-a-b-c', toolCallId: 'c' }) as any)).toBe('a-b-c')
    expect(getToolName(part({ type: 'dynamic-tool', toolName: 'custom', toolCallId: 'c' }) as any)).toBe('custom')
    expect(aiGetToolName(part({ type: 'tool-a-b-c', toolCallId: 'c' }) as any)).toBe('a-b-c')
  })

  it('distinguishes static vs dynamic tool parts and the other part families', () => {
    expect(isStaticToolUIPart(part({ type: 'tool-x' }))).toBe(true)
    expect(isStaticToolUIPart(part({ type: 'dynamic-tool' }))).toBe(false)
    expect(isDynamicToolUIPart(part({ type: 'dynamic-tool' }))).toBe(true)
    expect(isDynamicToolUIPart(part({ type: 'tool-x' }))).toBe(false)
    expect(isTextUIPart(part({ type: 'text' }))).toBe(true)
    expect(isReasoningUIPart(part({ type: 'reasoning' }))).toBe(true)
    expect(isFileUIPart(part({ type: 'file' }))).toBe(true)
    expect(isFileUIPart(part({ type: 'text' }))).toBe(false)
  })

  it('classifies data parts by prefix', () => {
    expect(isDataUIPart(part({ type: 'data-anything' }))).toBe(true)
    expect(isDataUIPart(part({ type: 'tool-x' }))).toBe(false)
    // "tool-x" starts with "tool-" but must not be mistaken for a data part by prefix rules
    expect(isDataUIPart(part({ type: 'database' }))).toBe(false)
  })

  it('getStaticToolName returns the tool-set key view of a static tool part', () => {
    expect(
      getStaticToolName({ type: 'tool-web_search', toolCallId: 'c', state: 'output-available', input: {} } as any)
    ).toBe('web_search')
  })
})
