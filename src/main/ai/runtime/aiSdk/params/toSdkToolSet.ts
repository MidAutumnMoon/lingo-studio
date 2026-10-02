/**
 * Legacy-boundary wrap: neutral registry tools → AI SDK `Tool`s (Track B of the
 * ai-sdk retirement). The registry is SDK-neutral (`tools/neutralTool.ts`); this is
 * the one place neutral tools become SDK objects again, so the legacy engine's
 * behavior — wire schemas, input validation, `dynamic-tool` part typing, metadata
 * projection, approval gating — is unchanged.
 */
import { dynamicTool, jsonSchema, type Tool, type ToolSet } from 'ai'

import type { NeutralTool, ToolSchema } from '@main/ai/tools/neutralTool'

/** Re-wrap one neutral schema as an AI SDK `Schema` (lazily, as the SDK's own zod path does). */
function toSdkSchema(schema: ToolSchema) {
  return jsonSchema(() => schema.jsonSchema, schema.validate ? { validate: schema.validate } : undefined)
}

/** Convert one neutral registry tool into the AI SDK `Tool` the legacy engine consumes. */
export function toSdkTool(neutral: NeutralTool): Tool {
  const { inputSchema, outputSchema, ...rest } = neutral
  // The SDK's `Tool` is a per-`type` union; the neutral shape passes through unchanged
  // apart from the schema re-wrap, so a single boundary cast keeps the mapping honest.
  const wrapped = {
    ...rest,
    metadata: neutral.metadata as Tool['metadata'],
    inputSchema: toSdkSchema(inputSchema)
  } as Tool
  if (outputSchema) {
    wrapped.outputSchema = toSdkSchema(outputSchema)
  }
  // `dynamicTool` demands a non-optional `execute`; registry dynamic tools always carry
  // one (the SDK `dynamicTool()` they were built with pre-neutrality required it).
  return neutral.type === 'dynamic' ? dynamicTool(wrapped as Parameters<typeof dynamicTool>[0]) : wrapped
}

/** Convert a whole neutral tool map into a legacy `ToolSet`. */
export function toSdkToolSet(tools: Record<string, NeutralTool> | undefined): ToolSet | undefined {
  if (!tools) return undefined
  const out: ToolSet = {}
  for (const [name, neutral] of Object.entries(tools)) out[name] = toSdkTool(neutral)
  return out
}
