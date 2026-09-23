import { CodeCli } from '@shared/types/codeCli'

/** Canonical facts for a Code CLI tool: how to find it and which skill teaches it. */
export interface CodeCliToolPreset {
  id: CodeCli
  executable: string
  skillFolderName: string
  skillNamespace: `code-cli:${CodeCli}`
}

/**
 * Single source of truth for executable names and the builtin skill that
 * teaches each CLI, used by both main and renderer processes.
 */
const CODE_CLI_TOOL_DEFINITIONS = [
  {
    id: CodeCli.CLAUDE_CODE,
    executable: 'claude',
    skillFolderName: 'code-mate-claude-code',
    skillNamespace: 'code-cli:claude-code'
  },
  {
    id: CodeCli.OPENAI_CODEX,
    executable: 'codex',
    skillFolderName: 'code-mate-codex',
    skillNamespace: 'code-cli:openai-codex'
  },
  {
    id: CodeCli.OPEN_CODE,
    executable: 'opencode',
    skillFolderName: 'code-mate-opencode',
    skillNamespace: 'code-cli:opencode'
  },
  {
    id: CodeCli.ANTIGRAVITY_CLI,
    executable: 'agy',
    skillFolderName: 'code-mate-antigravity',
    skillNamespace: 'code-cli:antigravity-cli'
  },
  {
    id: CodeCli.OPENCLAW,
    executable: 'openclaw',
    skillFolderName: 'code-mate-openclaw',
    skillNamespace: 'code-cli:openclaw'
  },
  {
    id: CodeCli.DEEPSEEK_HARNESS,
    executable: 'dsh',
    skillFolderName: 'code-mate-deepseek-harness',
    skillNamespace: 'code-cli:deepseek-harness'
  },
  {
    id: CodeCli.GEMINI_CLI,
    executable: 'gemini',
    skillFolderName: 'code-mate-gemini',
    skillNamespace: 'code-cli:gemini-cli'
  },
  {
    id: CodeCli.QWEN_CODE,
    executable: 'qwen',
    skillFolderName: 'code-mate-qwen-code',
    skillNamespace: 'code-cli:qwen-code'
  },
  {
    id: CodeCli.KIMI_CODE,
    executable: 'kimi',
    skillFolderName: 'code-mate-kimi-code',
    skillNamespace: 'code-cli:kimi-code'
  },
  {
    id: CodeCli.QODER_CLI,
    executable: 'qoderclicn',
    skillFolderName: 'code-mate-qoder',
    skillNamespace: 'code-cli:qoder-cli'
  },
  {
    id: CodeCli.GITHUB_COPILOT_CLI,
    executable: 'copilot',
    skillFolderName: 'code-mate-github-copilot',
    skillNamespace: 'code-cli:github-copilot-cli'
  },
  {
    id: CodeCli.PI,
    executable: 'pi',
    skillFolderName: 'code-mate-pi',
    skillNamespace: 'code-cli:pi'
  },
  {
    id: CodeCli.HERMES,
    executable: 'hermes',
    skillFolderName: 'code-mate-hermes',
    skillNamespace: 'code-cli:hermes'
  },
  {
    id: CodeCli.MINIMAX_CODE,
    executable: 'mcode',
    skillFolderName: 'code-mate-minimax-code',
    skillNamespace: 'code-cli:minimax-code'
  }
] as const satisfies readonly Readonly<CodeCliToolPreset>[]

export const CODE_CLI_TOOL_PRESETS: readonly Readonly<CodeCliToolPreset>[] = Object.freeze(
  CODE_CLI_TOOL_DEFINITIONS.map((preset) => Object.freeze(preset))
)

export const CODE_CLI_TOOL_PRESET_MAP = Object.freeze(
  Object.fromEntries(CODE_CLI_TOOL_PRESETS.map((preset) => [preset.id, preset])) as Record<
    CodeCli,
    Readonly<CodeCliToolPreset>
  >
)
