/**
 * Shared JSDoc-stub builder for the meta-tools. `tool_inspect` returns it as
 * documentation; `tool_invoke` returns it inside its rejection messages so a
 * model that skipped inspection (or guessed wrong params) gets the exact
 * signature back in one round-trip.
 */

import { asSchema } from '@shared/ai/uiDialect'

import type { ToolEntry } from '../types'
import { schemaToJSDoc } from './formatJsDoc'

/**
 * Normalise a tool's `inputSchema` to canonical JSONSchema. Registry tools carry the
 * neutral `ToolSchema` and wrapped/legacy sets carry the AI SDK `Schema` — both expose
 * `.jsonSchema`, which is the shape the model actually sees inline. Anything else (a raw
 * Zod schema, a lazy schema factory) falls through to the dialect's `asSchema`. Returns
 * undefined on any failure so the stub degrades to a description-only signature.
 */
export async function serializeToolSchema(schema: unknown): Promise<unknown> {
  if (!schema) return undefined
  try {
    const candidate = schema as { jsonSchema?: unknown }
    // Neutral records expose it sync; the SDK's `Schema` may hand back a
    // PromiseLike — `Promise.resolve` covers both without lying about the type.
    if (candidate.jsonSchema !== undefined) return Promise.resolve(candidate.jsonSchema)
    return await asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema
  } catch {
    return undefined
  }
}

/** JSDoc signature for a registered tool — the text `tool_inspect` returns. */
export async function buildToolStub(entry: ToolEntry): Promise<string> {
  const inputSchema = await serializeToolSchema(entry.tool.inputSchema)
  return schemaToJSDoc(entry.name, entry.description, inputSchema)
}
