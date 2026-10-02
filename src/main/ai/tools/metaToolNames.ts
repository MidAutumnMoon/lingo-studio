/**
 * Wire-names of registry meta-tools that surface outside their defining module: the
 * pi history converter replays `tool_invoke` parts as the inner tool they dispatched,
 * and defer exposition plus the loop-termination tests reference the name without
 * pulling in the tool implementation. The renderer mirrors these as string literals
 * (`utils/message/citations.ts`, `meta/metaToolNames.ts`) — it cannot import
 * main-process code, so a rename must update those copies too.
 */
export const TOOL_INVOKE_TOOL_NAME = 'tool_invoke'
