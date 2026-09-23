import type { BinaryToolSnapshot } from '@shared/types/binary'

// Tool identity validator, shared so the IPC boundary can reject malformed
// names before main probes them.
export const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/** A built-in, code-owned Dependencies preset. */
export interface BinaryToolPreset {
  name: string
  displayName: string
  icon?: string
  repoUrl: string
  homepage?: string
}

/** The tool name for the BabelDOC PDF layout-preserving engine. */
export const BABELDOC_TOOL_NAME = 'babeldoc-stream'

export type BabelDocInstallationStatus = 'missing' | 'available'

/**
 * Whether BabelDOC is resolvable on the user's PATH. This fork installs no
 * binaries, so an absent executable is simply "install it yourself".
 */
export function getBabelDocInstallationStatus(snapshot: BinaryToolSnapshot | undefined): BabelDocInstallationStatus {
  return snapshot?.availability.source === 'system' ? 'available' : 'missing'
}

export const PRESETS_BINARY_TOOLS: BinaryToolPreset[] = [
  {
    name: 'uv',
    displayName: 'uv',
    icon: 'simple-icons:uv',
    repoUrl: 'https://github.com/astral-sh/uv',
    homepage: 'https://docs.astral.sh/uv/'
  },
  {
    name: 'bun',
    displayName: 'Bun',
    icon: 'simple-icons:bun',
    repoUrl: 'https://github.com/oven-sh/bun',
    homepage: 'https://bun.sh'
  },
  {
    name: 'fd',
    displayName: 'fd',
    repoUrl: 'https://github.com/sharkdp/fd'
  },
  {
    name: 'rg',
    displayName: 'ripgrep',
    repoUrl: 'https://github.com/BurntSushi/ripgrep'
  },
  {
    name: 'rtk',
    displayName: 'RTK',
    repoUrl: 'https://github.com/rtk-ai/rtk',
    homepage: 'https://www.rtk-ai.app/'
  },
  {
    name: 'lark-cli',
    displayName: 'Lark CLI',
    // No recognizable Feishu/Lark brand glyph exists in the icon sets we ship, so
    // fall back to the default tool icon rather than an unrelated or invisible one.
    repoUrl: 'https://github.com/larksuite/cli'
  },
  {
    name: 'gh',
    displayName: 'GitHub CLI',
    icon: 'simple-icons:github',
    repoUrl: 'https://github.com/cli/cli',
    homepage: 'https://cli.github.com'
  },
  {
    name: 'ntn',
    displayName: 'Notion CLI',
    icon: 'simple-icons:notion',
    repoUrl: 'https://github.com/makenotion/cli',
    homepage: 'https://ntn.dev'
  },
  {
    name: BABELDOC_TOOL_NAME,
    displayName: 'BabelDOC Stream',
    repoUrl: 'https://github.com/eeee0717/BabelDOC',
    homepage: 'https://pypi.org/project/babeldoc-stream/'
  }
  // Managed Code CLIs are listed in codeCliTools.ts instead of here.
]
