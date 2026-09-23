/**
 * Provider ids for sidebar shortcut targets. Cross-process: the renderer resolves and activates
 * shortcuts by id, and the main process reads the same ids back out of stored preferences.
 */
export const SIDEBAR_SHORTCUT_PROVIDER_IDS = {
  APP: 'core.app',
  MINI_APP: 'core.mini-app',
  AGENT: 'core.agent',
  ASSISTANT: 'core.assistant',
  KNOWLEDGE_BASE: 'core.knowledge-base',
  TOPIC: 'core.topic',
  AGENT_SESSION: 'core.agent-session',
  FILE_ENTRY: 'core.file-entry',
  CODE_CLI: 'core.code-cli'
} as const

/**
 * Providers that no longer resolve; stored entries for them are filtered out on read.
 * `core.assistant` is retired because the sidebar lists assistants itself.
 */
export const RETIRED_SIDEBAR_SHORTCUT_PROVIDER_IDS = new Set([
  'core.skill',
  'core.mcp-server',
  'core.provider',
  'core.assistant'
])
