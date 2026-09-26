import { tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import type { CherryUIMessageChunk } from '@shared/data/types/message'

import { toolApprovalRegistry } from '../../toolApproval/ToolApprovalRegistry'
import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import { createChatToolAuthorizer } from './chatToolApproval'

afterEach(() => {
  // The approval registry is a singleton; nothing may leak between tests.
  toolApprovalRegistry.clear('test-cleanup')
})

/** A registry entry whose tool is approval-gated when `gated` is set. */
function gatedEntry(gated: boolean, execute = vi.fn(async () => ({ ok: true }))): ToolEntry {
  return {
    name: 'dangerous',
    namespace: 'test',
    description: 'A gated tool',
    defer: 'never',
    tool: tool({
      description: 'A gated tool',
      inputSchema: z.object({ path: z.string() }),
      ...(gated ? { needsApproval: true } : {}),
      execute
    })
  }
}

function harness(entry: ToolEntry, options: Partial<Parameters<typeof createChatToolAuthorizer>[0]> = {}) {
  const emitted: CherryUIMessageChunk[] = []
  const onApprovalResolved = vi.fn()
  const authorizer = createChatToolAuthorizer({
    approvalScope: 'pi-chat:test-exec',
    entries: new Map([[entry.name, entry]]),
    onApprovalResolved,
    ...options
  })
  return {
    authorizer,
    emitted,
    onApprovalResolved,
    call: {
      toolName: entry.name,
      toolCallId: 'call-1',
      input: { path: '/tmp/x' },
      signal: new AbortController().signal
    }
  }
}

/** The approval id of the emitted request chunk. */
const approvalIdOf = (chunks: CherryUIMessageChunk[]): string => {
  const request = chunks.find(
    (chunk): chunk is Extract<CherryUIMessageChunk, { type: 'tool-approval-request' }> =>
      chunk.type === 'tool-approval-request'
  )
  if (!request) throw new Error('no approval request chunk emitted')
  return request.approvalId
}

describe('createChatToolAuthorizer', () => {
  it('allows an ungated tool without touching the approval registry', async () => {
    const { authorizer, emitted, call } = harness(gatedEntry(false))
    const verdict = await authorizer(call, (chunk) => emitted.push(chunk))
    expect(verdict).toBeUndefined()
    expect(emitted).toEqual([])
    expect(toolApprovalRegistry.size()).toBe(0)
  })

  it('allows a call for a tool outside the registry (the seam decides what reaches the engine)', async () => {
    const { authorizer, emitted, call } = harness(gatedEntry(true))
    const verdict = await authorizer({ ...call, toolName: 'not-ours' }, (chunk) => emitted.push(chunk))
    expect(verdict).toBeUndefined()
    expect(emitted).toEqual([])
  })

  it('registers, emits the approval chunk, and applies an approved input edit', async () => {
    const { authorizer, emitted, onApprovalResolved, call } = harness(gatedEntry(true))

    const decision = authorizer(call, (chunk) => emitted.push(chunk))
    // The gate evaluation is async; the card surfaces once registration lands.
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(toolApprovalRegistry.size()).toBe(1)
    expect(emitted).toEqual([{ type: 'tool-approval-request', approvalId: expect.any(String), toolCallId: 'call-1' }])

    toolApprovalRegistry.dispatch(approvalIdOf(emitted), {
      approved: true,
      updatedInput: { path: '/tmp/safe' }
    })
    expect(await decision).toBeUndefined()
    // pi mutates the call input in place — the edited input is what the tool receives.
    expect(call.input).toEqual({ path: '/tmp/safe' })
    expect(onApprovalResolved).toHaveBeenCalledWith('call-1', true)
    expect(toolApprovalRegistry.size()).toBe(0)
  })

  it('blocks with the denied marker when the user denies', async () => {
    const { authorizer, emitted, onApprovalResolved, call } = harness(gatedEntry(true))

    const decision = authorizer(call, (chunk) => emitted.push(chunk))
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    toolApprovalRegistry.dispatch(approvalIdOf(emitted), { approved: false, reason: 'not today' })
    expect(await decision).toEqual({ block: true, reason: 'not today', denied: true })
    expect(onApprovalResolved).toHaveBeenCalledWith('call-1', false)
  })

  it('never emits an unanswerable card when registration resolves synchronously', async () => {
    const entry = gatedEntry(true)
    const { authorizer, emitted, call } = harness(entry)
    const aborted = new AbortController()
    aborted.abort()
    // An aborted signal resolves the registration synchronously: no card may surface.
    const verdict = await authorizer({ ...call, signal: aborted.signal }, (chunk) => emitted.push(chunk))
    expect(verdict).toEqual({ block: true, reason: 'Tool request was cancelled before approval', denied: true })
    expect(emitted).toEqual([])
  })
})
