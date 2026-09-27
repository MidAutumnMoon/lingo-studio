/**
 * Model-facing text for a replayed BUILTIN tool result (W5 register row
 * "Replayed tool-result rendering").
 *
 * Legacy replay re-derives the view through the live tool's `toModelOutput`
 * (`convertToModelMessages({ tools })`); the pi converter has no tool objects, so the
 * views live here as static per-name renderers — the same helpers the tool definitions
 * themselves call (`webLookup`/`knowledgeLookup`/`painting`), plus the two views re-homed
 * out of the ai-sdk adapter dir (`read_file`, `fs_read`) so this module survives Phase 2.
 *
 * Like legacy, a view applies only to tools the current request DECLARES; MCP call
 * results keep their shape-detected summary path (`toolResultRendering.ts`), and tools
 * without a view here (meta tools, mcp_resource_read, browser) fall back to raw JSON —
 * each such lossy row is owned by the plan's W5 register.
 */
import type { ToolResultOutput } from '@ai-sdk/provider-utils'

import {
  knowledgeListModelOutput,
  knowledgeManageModelOutput,
  knowledgeReadModelOutput,
  knowledgeSearchModelOutput
} from '@main/ai/tools/knowledgeLookup'
import { paintingModelOutput } from '@main/ai/tools/painting'
import { webLookupModelOutput } from '@main/ai/tools/webLookup'
import {
  FS_READ_TOOL_NAME,
  type FsReadOutput,
  KB_LIST_TOOL_NAME,
  KB_MANAGE_TOOL_NAME,
  KB_READ_TOOL_NAME,
  KB_SEARCH_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type ReadFileResult
} from '@shared/ai/builtinTools'
import { GENERATE_IMAGE_TOOL_NAME } from '@shared/ai/generateImageTool'

/** A view as the wire text pi sends — json views stringify, exactly as the legacy loop serialized them. */
function viewText(view: ToolResultOutput): string {
  switch (view.type) {
    case 'text':
    case 'error-text':
      return view.value
    case 'json':
    case 'error-json':
      return JSON.stringify(view.value) ?? String(view.value)
    case 'execution-denied':
      return view.reason ?? 'Tool execution was denied.'
    case 'content':
      return view.value.map((block) => ('text' in block ? block.text : JSON.stringify(block))).join('\n')
  }
}

/** Project a `read_file` result into the model-facing text (re-homed from ReadFileTool). */
export function readFileModelOutput(output: ReadFileResult): ToolResultOutput {
  if ('error' in output) {
    return { type: 'text', value: output.error }
  }
  const more =
    output.nextOffset != null
      ? `\n\n[Showing ${output.text.length} of ${output.totalChars} chars. Call read_file again with offset=${output.nextOffset} for more.]`
      : ''
  return { type: 'text', value: output.text + more }
}

/** Project an `fs_read` result into the model-facing text (re-homed from FsReadTool). */
export function fsReadModelOutput(output: FsReadOutput): ToolResultOutput {
  if (output.kind === 'error') {
    return { type: 'error-text', value: `[Error: ${output.code}] ${output.message}` }
  }
  const remaining = output.totalLines - output.endLine
  const tail =
    remaining > 0
      ? `\n\n[showing lines ${output.startLine}-${output.endLine} of ${output.totalLines}; ${remaining} more — call again with offset=${output.endLine + 1} to continue]`
      : ''
  return { type: 'text', value: `${output.text}${tail}` }
}

/**
 * The model-facing text for a replayed builtin tool output, or `undefined` when the name
 * carries no view. `input` is the persisted tool-call input — `kb_list`'s view keys its
 * outline mode off it, matching live dispatch.
 */
export function builtinToolResultModelText(toolName: string, output: unknown, input: unknown): string | undefined {
  switch (toolName) {
    case WEB_SEARCH_TOOL_NAME:
    case WEB_FETCH_TOOL_NAME:
      return viewText(webLookupModelOutput(output as never))
    case KB_SEARCH_TOOL_NAME:
      return viewText(knowledgeSearchModelOutput(output as never))
    case KB_READ_TOOL_NAME:
      return viewText(knowledgeReadModelOutput(output as never))
    case KB_MANAGE_TOOL_NAME:
      return viewText(knowledgeManageModelOutput(output as never))
    case KB_LIST_TOOL_NAME:
      return viewText(knowledgeListModelOutput(output as never, input as never))
    case GENERATE_IMAGE_TOOL_NAME:
      return viewText(paintingModelOutput(output as never))
    case READ_FILE_TOOL_NAME:
      return viewText(readFileModelOutput(output as ReadFileResult))
    case FS_READ_TOOL_NAME:
      return viewText(fsReadModelOutput(output as FsReadOutput))
    default:
      return undefined
  }
}
