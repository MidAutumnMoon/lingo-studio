/**
 * W4a — chat tool registry → pi `ToolDefinition`s (plan:
 * docs/plans/2026-09-pi-unification.md, W4).
 *
 * One uniform bridge over `ToolEntry`: builtin (Zod-backed), MCP (raw JSON Schema
 * with its validator), and meta tools all convert the same way, because the registry
 * entry — not the pi adapter — owns execution. MCP tools keep routing through their
 * registry execute (`McpRuntimeService.callTool` with its per-topic abort scope and
 * catalog routing); the agent path's InMemoryTransport bridge (`piMcpToolAdapter`)
 * assembles its OWN server instances per session and does not fit the chat registry
 * model.
 *
 * Schema pivot: the registry's neutral `ToolSchema.jsonSchema` is the raw JSON Schema
 * the model sees — Zod tools converted it once at definition time through the vendored
 * dialect's `asSchema` (see `tools/neutralTool.ts`), so it matches the legacy engine's
 * wire byte for byte. pi validates raw JSON Schema natively (`validateToolArguments`
 * falls back to a JSON-Schema path for schemas without TypeBox kind symbols — same
 * contract the pi MCP adapter relies on), so no TypeBox rewrite is needed.
 *
 * Result split (`AgentToolResult`): `content` is the MODEL-facing view — the
 * entry's `toModelOutput` when it declares one, else the raw output as JSON text
 * (legacy parity) — while `details` carries the raw execute output. The chat engine
 * declares these tool names to the stream adapter (`payloadToolNames`), which projects
 * `details` onto the part so the renderer's tool card and the history converter's
 * replay see exactly what the legacy engine persisted.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import { truncateInFlightToolResultText } from '@main/ai/contextBuild/inFlightTruncate'
import { createFileManagerStorageAdapter } from '@main/ai/contextBuild/persistedOutputAdapter'

import type { RequestContext } from '../../tools/adapters/aiSdk/context'
import type { ToolEntry } from '../../tools/adapters/aiSdk/types'
import type { ToolModelContentBlock, ToolModelOutput } from '../../tools/neutralTool'
import { getTrustedLocalToolTerminalFailure } from '../../tools/toolLoopTerminal'

/** pi content blocks for tool results (the multimodal subset the adapter projects). */
type PiToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** A block of a `content` view — the registry's neutral block union. */
type ToolContentBlock = ToolModelContentBlock

export interface PiChatToolContext {
  /**
   * Threaded to every registry execute as `experimental_context` (the dialect's
   * execute-options field); the tools read it via `getToolCallContext` (a missing
   * context throws there, so it is required here too — the W6 seam builds it from
   * the request).
   */
  requestContext: RequestContext
}

/** Convert one registry entry into the pi tool the chat engine hands to the session. */
export function toPiChatToolDefinition(entry: ToolEntry, context: PiChatToolContext): ToolDefinition {
  const tool = entry.tool
  return {
    name: entry.name,
    label: entry.namespaceLabel ?? entry.name,
    description: tool.description ?? entry.description,
    parameters: tool.inputSchema.jsonSchema,
    async execute(toolCallId, params, signal) {
      const execute = tool.execute
      if (!execute) {
        throw new Error(`Chat tool "${entry.name}" has no execute implementation`)
      }
      const output = await execute(params, {
        toolCallId,
        // Inert for registry tools (they read `experimental_context` via
        // `getToolCallContext`); the field is part of the AI SDK's execute options.
        messages: [],
        ...(signal && { abortSignal: signal }),
        experimental_context: context.requestContext
      })
      const view = tool.toModelOutput && (await tool.toModelOutput({ toolCallId, input: params, output }))
      // Trusted local tools brand terminal failures the legacy loop stopped on; pi's
      // native per-result `terminate` hint is the same stop (the branding is
      // process-local, and the tool ran in this process).
      const terminalFailure = getTrustedLocalToolTerminalFailure(output)
      const blocks = toPiContent(view, output)
      return {
        // In-flight truncation reshapes only what the MODEL sees (legacy parity — the
        // card, the persisted part, and the brand check all read the raw `details`);
        // `truncatable: false` entries are exempt (fs_read's loop protection).
        content: entry.truncatable === false ? blocks : await truncateContentBlocks(blocks, context),
        details: output ?? null,
        ...(terminalFailure && { terminate: true })
      }
    }
  }
}

/**
 * Apply the request's in-flight truncation to the model-facing content. Offload
 * storage is the same FileManager adapter legacy seeds (marker bytes stay identical so
 * prefix caches and `fs_read` read-back keep working across engines).
 *
 * The truncation unit is the result's TEXT, as legacy defined it (aiCore joins the text
 * blocks of a `content` view with `\n` and thresholds the joined string) — per-block
 * truncation would silently skip a multi-block view whose blocks are each under the
 * threshold. Image blocks survive: legacy replaced the whole output with the truncated
 * text, this path keeps what pi can carry.
 */
async function truncateContentBlocks(blocks: PiToolContent[], context: PiChatToolContext): Promise<PiToolContent[]> {
  const truncation = context.requestContext.toolResultTruncation
  if (truncation === undefined) return blocks
  const textBlocks = blocks.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
  if (textBlocks.length === 0) return blocks
  const joined = textBlocks.map((block) => block.text).join('\n')
  const storage =
    truncation.canOffload && context.requestContext.persistedOutputPaths
      ? createFileManagerStorageAdapter({
          messageId: context.requestContext.requestId,
          persistedOutputPaths: context.requestContext.persistedOutputPaths
        })
      : undefined
  const truncated = await truncateInFlightToolResultText(joined, {
    thresholdChars: truncation.thresholdChars,
    ...(storage && { storage })
  })
  if (truncated === joined) return blocks
  return [
    { type: 'text', text: truncated },
    ...blocks.filter((block): block is Exclude<PiToolContent, { type: 'text' }> => block.type !== 'text')
  ]
}

/** Convert the turn's selected registry entries; selection (`selectActive`) is the seam's job. */
export function toPiChatTools(entries: readonly ToolEntry[], context: PiChatToolContext): ToolDefinition[] {
  return entries.map((entry) => toPiChatToolDefinition(entry, context))
}

/**
 * The model-facing content blocks. `toModelOutput` is the registry contract for what
 * the model sees next turn (citation markers, summaries, screenshots); without one the
 * legacy loop sent the raw output as JSON — same here.
 *
 * `content` views map block by block: pi tool results carry text and images
 * (`AgentToolResult.content`), and its per-family adapters do the rest — Anthropic
 * gets native image blocks, the OpenAI families hoist them into a following user
 * message ("Attached image(s) from tool result:"). Anything else (file data, urls)
 * has no pi representation and becomes a note, never a silent drop.
 */
function toPiContent(view: ToolModelOutput | undefined, output: unknown): PiToolContent[] {
  if (view === undefined) {
    return [{ type: 'text', text: stringify(output) }]
  }
  switch (view.type) {
    case 'text':
      return [{ type: 'text', text: view.value }]
    case 'json':
    case 'error-json':
      return [{ type: 'text', text: stringify(view.value) }]
    case 'error-text':
      return [{ type: 'text', text: view.value }]
    case 'execution-denied':
      return [{ type: 'text', text: view.reason ?? 'Tool execution was denied.' }]
    case 'content': {
      const blocks = view.value.flatMap(toPiContentBlock)
      return blocks.length > 0 ? blocks : [{ type: 'text', text: stringify(view.value) }]
    }
  }
}

/** One AI SDK tool-content block as a pi block, or a note when pi cannot carry it. */
function toPiContentBlock(block: ToolContentBlock): PiToolContent[] {
  if (block.type === 'text') return [{ type: 'text', text: block.text }]
  // `media` is the deprecated image variant; both carry base64 image data.
  if (block.type === 'image-data' || block.type === 'media') {
    return [{ type: 'image', data: block.data, mimeType: block.mediaType }]
  }
  return [{ type: 'text', text: `[${block.type} block omitted: pi tool results carry text and images only]` }]
}

function stringify(value: unknown): string {
  const json = JSON.stringify(value)
  return json === undefined ? String(value) : json
}
