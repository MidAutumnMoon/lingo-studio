import { jsonSchema, tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { mcpResultToTextSummary } from '../../messages/toolResultRendering'
import { registerBuiltinTools } from '../../tools/adapters/aiSdk/builtin/registerBuiltinTools'
import { ToolRegistry } from '../../tools/adapters/aiSdk/registry'
import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import { markTrustedLocalToolTerminalFailure } from '../aiSdk'
import { toPiChatToolDefinition, toPiChatTools } from './chatToolAdapter'

const requestContext = { requestId: 'req-test' } as never

/** A zod-defined builtin in the registry's shape. */
function zodEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  const execute = vi.fn(async ({ q }: { q: string }) => ({ echoed: q }))
  const entry: ToolEntry = {
    name: 'echo',
    namespace: 'test',
    description: 'Echo the query',
    defer: 'never',
    tool: tool({
      description: 'Echo the query back',
      inputSchema: z.object({ q: z.string().describe('the query') }),
      execute
    }),
    ...overrides
  }
  return entry
}

describe('toPiChatToolDefinition', () => {
  it('converts every registered builtin without a schema or shape failure', () => {
    const registry = new ToolRegistry()
    registerBuiltinTools(registry)
    const converted = toPiChatTools(registry.getAll(), { requestContext })

    // The sweep is the contract: every builtin's schema (zod or JSON-Schema wrapped)
    // must pivot to a JSON Schema pi accepts, or new/changed tools fail here.
    expect(converted.length).toBe(registry.getAll().length)
    expect(converted.length).toBeGreaterThan(10)
    for (const definition of converted) {
      expect(definition.name, `${definition.name}`).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/)
      expect(definition.description.length).toBeGreaterThan(0)
      const parameters = definition.parameters as Record<string, unknown>
      expect(parameters.type, `${definition.name} parameters`).toBe('object')
      expect(typeof definition.execute).toBe('function')
    }
    // The MCP wire-name format survives verbatim (the stream adapter routes by it).
    expect(converted.some((definition) => definition.name.startsWith('mcp__') === false)).toBe(true)
  })

  it('bridges execute: registry input/context in, model view + raw output out', async () => {
    const entry = zodEntry()
    const definition = toPiChatToolDefinition(entry, { requestContext })
    const signal = new AbortController().signal

    const result = await definition.execute('call-1', { q: 'hi' }, signal, undefined, {} as never)

    expect(entry.tool.execute).toHaveBeenCalledWith(
      { q: 'hi' },
      expect.objectContaining({ toolCallId: 'call-1', abortSignal: signal, experimental_context: requestContext })
    )
    // No toModelOutput: the model sees the raw output as JSON (legacy parity)…
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: 'hi' }) }])
    // …while the renderer tool card and replay see the raw output via `details`.
    expect(result.details).toEqual({ echoed: 'hi' })
  })

  it('uses the tool declared model view when present', async () => {
    const entry = zodEntry({
      tool: tool({
        description: 'echo',
        inputSchema: z.object({ q: z.string() }),
        execute: async ({ q }) => ({ results: [{ id: 'x', content: q }] }),
        toModelOutput: ({ output }) => ({ type: 'text' as const, value: `[x] ${output.results[0].content}` })
      })
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })

    const result = await definition.execute('call-2', { q: 'hi' }, undefined, undefined, {} as never)

    expect(result.content).toEqual([{ type: 'text', text: '[x] hi' }])
    expect(result.details).toEqual({ results: [{ id: 'x', content: 'hi' }] })
  })

  it('converts an MCP registry entry: raw JSON Schema parameters and the summary model view', async () => {
    // Mirrors `createMcpTool`: jsonSchema-wrapped input schema, full McpCallToolResponse
    // output, text-summary toModelOutput.
    const callResponse = {
      content: [{ type: 'text', text: '{"rows":1}' }],
      structuredContent: { rows: 1 },
      isError: false,
      metadata: { type: 'mcp' as const, name: 'query', serverId: 's1', serverName: 'db' }
    }
    const entry: ToolEntry = {
      name: 'mcp__db__query_abc123',
      namespace: 'mcp:s1',
      namespaceLabel: 'mcp:db',
      description: 'Query the database',
      defer: 'never',
      tool: {
        type: 'function',
        description: 'Query the database',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { sql: { type: 'string' } },
          required: ['sql']
        } as never),
        execute: vi.fn(async () => callResponse),
        toModelOutput: ({ output }) => ({ type: 'text' as const, value: mcpResultToTextSummary(output as never) })
      }
    }
    const definition = toPiChatToolDefinition(entry, { requestContext })

    expect(definition.name).toBe('mcp__db__query_abc123')
    expect(definition.parameters).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql']
    })

    const result = await definition.execute('call-3', { sql: 'select 1' }, undefined, undefined, {} as never)
    // The model sees the MCP summary; the part output (details) is the full response —
    // exactly what the legacy engine persisted for the renderer's tool card.
    expect(result.content).toEqual([{ type: 'text', text: mcpResultToTextSummary(callResponse as never) }])
    expect(result.details).toEqual(callResponse)
  })

  it('fails loudly at call time for an entry without execute', async () => {
    const entry = zodEntry({
      tool: { description: 'stub', inputSchema: z.object({ q: z.string() }) }
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })
    await expect(definition.execute('call-4', { q: 'x' }, undefined, undefined, {} as never)).rejects.toThrow(
      /no execute implementation/
    )
  })

  it('maps a trusted terminal failure onto pi terminate hint', async () => {
    const entry = zodEntry({
      tool: tool({
        description: 'lookup',
        inputSchema: z.object({ q: z.string() }),
        execute: async () => markTrustedLocalToolTerminalFailure({ terminal: true, retryable: false, error: 'gone' })
      })
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })

    const result = await definition.execute('call-5', { q: 'x' }, undefined, undefined, {} as never)

    expect(result.terminate).toBe(true)
    // The failure itself still reaches the model and the tool card.
    expect(result.details).toEqual({ terminal: true, retryable: false, error: 'gone' })
  })
})
