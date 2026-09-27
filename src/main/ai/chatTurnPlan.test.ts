/**
 * Direct contract pins for the engine-agnostic turn plan. The module's full behavior is
 * enforced by the legacy suite consuming it (`buildAgentParams.test.ts`, unchanged when
 * the core was extracted) — these pin the CROSS-ENGINE contracts that only this module
 * owns, so a Phase 2 refactor of the legacy suite cannot strip the last guard.
 */
import { describe, expect, it } from 'vitest'

import { makeAssistant } from './__tests__/fixtures'
import { CITABLE_BUILTIN_TOOL_NAMES, hasCitableSelection, resolveToolCallLimit } from './chatTurnPlan'
import type { ToolEntry } from './tools/adapters/aiSdk/types'

const citableEntry = (name: string): ToolEntry => ({ name }) as ToolEntry

describe('resolveToolCallLimit', () => {
  it('uses the assistant-bound policy only when an assistant exists', () => {
    // Two policies hide behind one resolver: the assistant's maxToolCalls (default 100,
    // clamped 1..1000, its enable flag reverting to the default) and the assistant-less
    // bound of 20. The seam passes the resolved value — an engine-side default would
    // silently pick one.
    expect(resolveToolCallLimit(undefined)).toBe(20)
    expect(resolveToolCallLimit(makeAssistant({ settings: { maxToolCalls: 7 } }))).toBe(7)
    expect(resolveToolCallLimit(makeAssistant({ settings: { enableMaxToolCalls: false, maxToolCalls: 7 } }))).toBe(100)
    expect(resolveToolCallLimit(makeAssistant({ settings: { maxToolCalls: 1001 } }))).toBe(100)
    expect(resolveToolCallLimit(makeAssistant({ settings: { maxToolCalls: 500 } }))).toBe(500)
  })
})

describe('hasCitableSelection', () => {
  it('counts a citable builtin unless the client declared the same name', () => {
    // The client-tool subtraction is the seam-adjacent invariant: the pi gate excludes
    // client-tool requests, so the plan computing citability with an EMPTY client set is
    // correct only because of that exclusion — this pins both halves of the contract.
    expect(CITABLE_BUILTIN_TOOL_NAMES.has('web_search')).toBe(true)
    expect(hasCitableSelection([citableEntry('web_search')], new Set())).toBe(true)
    expect(hasCitableSelection([citableEntry('web_search')], new Set(['web_search']))).toBe(false)
    expect(hasCitableSelection([citableEntry('echo')], new Set())).toBe(false)
  })
})
