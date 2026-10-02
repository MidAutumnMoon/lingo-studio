/**
 * SDK-neutral tool contract for the tool registry (Track B of the ai-sdk retirement).
 * `ToolEntry.tool` is a plain object of this shape: the pi chat engine
 * (`runtime/piChat/chatToolAdapter`) and the meta-tools consume it directly, and the
 * legacy engine wraps it back into AI SDK `Tool`s at its boundary
 * (`runtime/aiSdk/params/toSdkToolSet.ts`). Field-for-field it mirrors the subset of
 * the AI SDK `Tool` surface the registry actually uses, so the wrap is a faithful
 * pass-through and neither engine's behavior changes.
 *
 * Schemas convert ONCE, at tool-definition time: `zodToolSchema` delegates to the
 * vendored dialect's `asSchema` (same conversion the AI SDK applied inline —
 * `additionalProperties: false` on every object node included), so both engines and
 * the meta-tools see byte-identical wire schemas.
 */
import type { JSONSchema7 } from 'json-schema'
import type * as z from 'zod'

import { asSchema } from '@shared/ai/uiDialect'

/** Result of a {@link ToolSchema} parse: the canonical value, or a failure error. */
export type ToolSchemaResult = { success: true; value: unknown } | { success: false; error: Error }

/**
 * A tool's schema in neutral form: the raw JSON Schema the model sees, plus the
 * optional canonicalizing parse (defaults / coercions) that produced it. Both AI SDK
 * `Schema` objects and this interface expose `.jsonSchema`, which
 * `serializeToolSchema` relies on to normalize either without branching.
 */
export interface ToolSchema {
  readonly jsonSchema: JSONSchema7
  readonly validate?: (value: unknown) => ToolSchemaResult | PromiseLike<ToolSchemaResult>
}

/**
 * Convert a Zod schema once, at tool-definition time. The JSON Schema and the parse
 * delegate to the same vendored conversion the AI SDK applied per use, laziness
 * included — the wire schema is only built on first `.jsonSchema` access.
 */
export function zodToolSchema(schema: z.ZodType): ToolSchema {
  const converted = asSchema(schema)
  return {
    get jsonSchema(): JSONSchema7 {
      // The dialect's `Schema.jsonSchema` type admits PromiseLike, but the zod conversion
      // is always synchronous — assert the value both consumers here need.
      return converted.jsonSchema as JSONSchema7
    },
    validate: (value) => converted.validate!(value)
  }
}

/** One block of a `content` model-output view — the AI SDK dialect's block union, mirrored neutrally. */
export type ToolModelContentBlock =
  | { type: 'text'; text: string }
  | /** @deprecated Use image-data instead. */ { type: 'media'; data: string; mediaType: string }
  | { type: 'image-data'; data: string; mediaType: string }
  | { type: 'image-url'; url: string }
  | { type: 'image-file-id'; fileId: string | Record<string, string> }
  | { type: 'file-data'; data: string; mediaType: string; filename?: string }
  | { type: 'file-url'; url: string; mediaType?: string }
  | { type: 'file-id'; fileId: string | Record<string, string> }
  | { type: 'custom' }

/**
 * What `toModelOutput` hands the model instead of the raw execute output — the AI
 * SDK dialect's `ToolResultOutput` union, mirrored neutrally.
 */
export type ToolModelOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
  | { type: 'content'; value: readonly ToolModelContentBlock[] }

/** Options every registry tool `execute` / `needsApproval` receives. */
export interface ToolExecuteOptions {
  readonly toolCallId: string
  /** Conversation-so-far in the SDK's model-message shape; registry tools only thread it through. */
  readonly messages: readonly unknown[]
  readonly abortSignal?: AbortSignal
  /** The per-request `RequestContext` (see `adapters/aiSdk/context`). */
  readonly experimental_context?: unknown
}

/** The registry's neutral tool. See the module doc — the legacy engine wraps this, nothing else. */
export interface NeutralTool {
  /**
   * `function` (default) for schema-defined input; `dynamic` marks a runtime-shaped
   * input the tool parses itself (generate_image) — the legacy wrap maps it to the
   * SDK's `dynamicTool` so input-available parts keep their `dynamic-tool` typing.
   */
  type?: 'function' | 'dynamic'
  description?: string
  /** Propagated onto tool-call/result parts (e.g. the MCP `cherry.tool` identity the renderer reads). */
  metadata?: Record<string, unknown>
  inputSchema: ToolSchema
  inputExamples?: Array<{ input: unknown }>
  needsApproval?: boolean | ((input: unknown, options: ToolExecuteOptions) => boolean | Promise<boolean>)
  /** Constrained-decoding request for providers that support it; the registry keeps every tool non-strict. */
  strict?: boolean
  outputSchema?: ToolSchema
  execute?: (input: any, options: ToolExecuteOptions) => unknown | Promise<unknown>
  toModelOutput?: (options: {
    toolCallId: string
    input: unknown
    output: unknown
  }) => ToolModelOutput | Promise<ToolModelOutput>
}
