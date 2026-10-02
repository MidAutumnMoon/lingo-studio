/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/ui/ui-messages.ts) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md). The upstream `ai` dep still serves aiCore.
 */
import type {
  DataUIPart,
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessagePart,
  UITools
} from './types'

/**
 * Check if a message part is a data part.
 */
export function isDataUIPart<DATA_TYPES extends Record<string, unknown>>(
  part: UIMessagePart<DATA_TYPES, UITools>
): part is DataUIPart<DATA_TYPES> {
  return part.type.startsWith('data-')
}

/**
 * Type guard to check if a message part is a text part.
 */
export function isTextUIPart(part: UIMessagePart<Record<string, unknown>, UITools>): part is TextUIPart {
  return part.type === 'text'
}

/**
 * Type guard to check if a message part is a file part.
 */
export function isFileUIPart(part: UIMessagePart<Record<string, unknown>, UITools>): part is FileUIPart {
  return part.type === 'file'
}

/**
 * Type guard to check if a message part is a reasoning part.
 */
export function isReasoningUIPart(part: UIMessagePart<Record<string, unknown>, UITools>): part is ReasoningUIPart {
  return part.type === 'reasoning'
}

/**
 * Check if a message part is a static tool part.
 *
 * Static tools are tools for which the types are known at development time.
 */
export function isStaticToolUIPart<TOOLS extends UITools>(
  part: UIMessagePart<Record<string, unknown>, TOOLS>
): part is ToolUIPart<TOOLS> {
  return part.type.startsWith('tool-')
}

/**
 * Check if a message part is a dynamic tool part.
 */
export function isDynamicToolUIPart(part: UIMessagePart<Record<string, unknown>, UITools>): part is DynamicToolUIPart {
  return part.type === 'dynamic-tool'
}

/**
 * Check if a message part is a tool part.
 *
 * Tool parts are either static or dynamic tools.
 *
 * Use `isStaticToolUIPart` or `isDynamicToolUIPart` to check the type of the tool.
 */
export function isToolUIPart<TOOLS extends UITools>(
  part: UIMessagePart<Record<string, unknown>, TOOLS>
): part is ToolUIPart<TOOLS> | DynamicToolUIPart {
  return isStaticToolUIPart(part) || isDynamicToolUIPart(part)
}

/**
 * Returns the name of the static tool.
 *
 * The possible values are the keys of the tool set.
 */
export function getStaticToolName<TOOLS extends UITools>(part: ToolUIPart<TOOLS>): keyof TOOLS {
  return part.type.split('-').slice(1).join('-')
}

/**
 * Returns the name of the tool (static or dynamic).
 *
 * This function will not restrict the name to the keys of the tool set.
 * If you need to restrict the name to the keys of the tool set, use `getStaticToolName` instead.
 */
export function getToolName(part: ToolUIPart<UITools> | DynamicToolUIPart): string {
  return isDynamicToolUIPart(part) ? part.toolName : getStaticToolName(part)
}
