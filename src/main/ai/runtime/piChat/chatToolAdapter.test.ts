import { validateToolArguments } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { mcpResultToTextSummary } from '../../messages/toolResultRendering'
import { registerBuiltinTools } from '../../tools/adapters/aiSdk/builtin/registerBuiltinTools'
import { ToolRegistry } from '../../tools/adapters/aiSdk/registry'
import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import { zodToolSchema } from '../../tools/neutralTool'
import { markTrustedLocalToolTerminalFailure } from '../../tools/toolLoopTerminal'
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
    tool: {
      description: 'Echo the query back',
      inputSchema: zodToolSchema(z.object({ q: z.string().describe('the query') })),
      execute
    },
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

  it('truncates the model-facing text in flight while the payload keeps the full output', async () => {
    const huge = { blob: 'x'.repeat(4000) + '\n' + 'y'.repeat(4000) }
    const entry = zodEntry({
      tool: { description: 'echo', inputSchema: zodToolSchema(z.object({})), execute: async () => huge }
    })
    const context = {
      requestContext: { requestId: 'req-trunc', toolResultTruncation: { thresholdChars: 100, canOffload: false } }
    }

    const result = await toPiChatToolDefinition(entry, context).execute('call-t', {}, undefined, undefined, {} as never)

    const text = (result.content as Array<{ type: string; text: string }>)[0]
    expect(text.text).toContain('--- truncated (')
    expect(text.text.length).toBeLessThan(JSON.stringify(huge).length)
    // The card/persisted payload and the brand surface read the untouched raw output.
    expect(result.details).toEqual(huge)
  })

  it('thresholds the joined text of a multi-block view, keeping image blocks', async () => {
    const view = {
      type: 'content' as const,
      value: [
        { type: 'text' as const, text: 'A'.repeat(1200) },
        { type: 'image-data' as const, data: 'aGk=', mediaType: 'image/png' },
        { type: 'text' as const, text: 'B'.repeat(1200) }
      ]
    }
    const entry = zodEntry({
      tool: {
        description: 'browser',
        inputSchema: zodToolSchema(z.object({})),
        execute: async () => ({ ignored: true }),
        toModelOutput: () => view
      }
    })
    const context = {
      requestContext: { requestId: 'req-multi', toolResultTruncation: { thresholdChars: 2000, canOffload: false } }
    }

    const result = await toPiChatToolDefinition(entry, context).execute('call-m', {}, undefined, undefined, {} as never)

    // 2400 joined chars > 2000: the guard fires on the text as a whole (legacy's input),
    // not per block (2400 would otherwise ride through untouched).
    const blocks = result.content as Array<{ type: string; text?: string; data?: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('--- truncated (')
    expect(blocks[1]).toMatchObject({ type: 'image', data: 'aGk=' })
    expect(result.details).toEqual({ ignored: true })
  })

  it('leaves `truncatable: false` entries fully intact', async () => {
    const huge = 'x'.repeat(4000) + '\n' + 'y'.repeat(4000)
    const entry: ToolEntry = {
      name: 'exempt',
      namespace: 'test',
      description: 'exempt',
      defer: 'never',
      truncatable: false,
      tool: {
        description: 'exempt',
        inputSchema: zodToolSchema(z.object({})),
        execute: async () => ({ text: huge })
      }
    }
    const context = {
      requestContext: { requestId: 'req-exempt', toolResultTruncation: { thresholdChars: 100, canOffload: false } }
    }

    const result = await toPiChatToolDefinition(entry, context).execute('call-e', {}, undefined, undefined, {} as never)

    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ text: huge }) }])
  })

  it('uses the tool declared model view when present', async () => {
    const entry = zodEntry({
      tool: {
        description: 'echo',
        inputSchema: zodToolSchema(z.object({ q: z.string() })),
        execute: async ({ q }: { q: string }) => ({ results: [{ id: 'x', content: q }] }),
        toModelOutput: ({ output }) => ({
          type: 'text' as const,
          value: `[x] ${(output as { results: Array<{ content: string }> }).results[0].content}`
        })
      }
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })

    const result = await definition.execute('call-2', { q: 'hi' }, undefined, undefined, {} as never)

    expect(result.content).toEqual([{ type: 'text', text: '[x] hi' }])
    expect(result.details).toEqual({ results: [{ id: 'x', content: 'hi' }] })
  })

  it('converts an MCP registry entry: raw JSON Schema parameters and the summary model view', async () => {
    // Mirrors `createMcpTool`: raw-JSON-Schema input schema, full McpCallToolResponse
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
        inputSchema: {
          jsonSchema: {
            type: 'object',
            properties: { sql: { type: 'string' } },
            required: ['sql']
          }
        },
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
      tool: { description: 'stub', inputSchema: zodToolSchema(z.object({ q: z.string() })) }
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })
    await expect(definition.execute('call-4', { q: 'x' }, undefined, undefined, {} as never)).rejects.toThrow(
      /no execute implementation/
    )
  })

  it('carries a multimodal model view into pi content blocks', async () => {
    const entry = zodEntry({
      tool: {
        description: 'screenshot',
        inputSchema: zodToolSchema(z.object({})),
        execute: async () => ({ blob: 'aGk=', text: 'shot' }),
        toModelOutput: () => ({
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: '{"shot":1}' },
            { type: 'image-data' as const, data: 'aGk=', mediaType: 'image/png' }
          ]
        })
      }
    })

    const result = await toPiChatToolDefinition(entry, { requestContext }).execute(
      'call-6',
      {},
      undefined,
      undefined,
      {} as never
    )

    // pi tool results carry text AND images (AgentToolResult.content); the MCP resource-read
    // and browser screenshot views depend on both — dropping the image loses model input.
    expect(result.content).toEqual([
      { type: 'text', text: '{"shot":1}' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' }
    ])
    expect(result.details).toEqual({ blob: 'aGk=', text: 'shot' })

    // Blocks pi cannot carry (file data, urls) become a note — never a silent drop.
    const fileEntry = zodEntry({
      tool: {
        description: 'attachment',
        inputSchema: zodToolSchema(z.object({})),
        execute: async () => ({ ok: true }),
        toModelOutput: () => ({
          type: 'content' as const,
          value: [{ type: 'file-data' as const, data: 'aGk=', mediaType: 'application/pdf' }]
        })
      }
    })
    const fileResult = await toPiChatToolDefinition(fileEntry, { requestContext }).execute(
      'call-7',
      {},
      undefined,
      undefined,
      {} as never
    )
    expect(fileResult.content).toEqual([
      { type: 'text', text: '[file-data block omitted: pi tool results carry text and images only]' }
    ])
  })

  it('compiles every registered builtin parameters under pi argument validation', () => {
    const registry = new ToolRegistry()
    registerBuiltinTools(registry)

    for (const entry of registry.getAll()) {
      const definition = toPiChatToolDefinition(entry, { requestContext })
      // pi compiles raw JSON Schema through TypeBox; an unsupported keyword/shape throws a
      // TypeBox error here instead of the validator's own "Validation failed for tool" message.
      let message = ''
      try {
        validateToolArguments(
          { name: definition.name, parameters: definition.parameters } as never,
          { name: definition.name, arguments: {} } as never
        )
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message, `${entry.name}: ${message}`).toMatch(/^Validation failed for tool|^$/)
    }
  })

  it('maps a trusted terminal failure onto pi terminate hint', async () => {
    const entry = zodEntry({
      tool: {
        description: 'lookup',
        inputSchema: zodToolSchema(z.object({ q: z.string() })),
        execute: async () => markTrustedLocalToolTerminalFailure({ terminal: true, retryable: false, error: 'gone' })
      }
    })
    const definition = toPiChatToolDefinition(entry, { requestContext })

    const result = await definition.execute('call-5', { q: 'x' }, undefined, undefined, {} as never)

    expect(result.terminate).toBe(true)
    // The failure itself still reaches the model and the tool card.
    expect(result.details).toEqual({ terminal: true, retryable: false, error: 'gone' })
  })
})
