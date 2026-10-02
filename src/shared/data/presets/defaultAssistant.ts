import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'

export const DEFAULT_ASSISTANT_NAME = 'Cherry Assistant' as const
export const DEFAULT_ASSISTANT_EMOJI = '😀' as const
export const DEFAULT_ASSISTANT_PROMPT = '' as const

export function getDefaultAssistantNameForLocale(locale?: string | null): string {
  return locale?.toLowerCase().startsWith('zh') ? 'Cherry 助手' : DEFAULT_ASSISTANT_NAME
}

// No seeded model: a fresh install starts with no default model; onboarding
// walks the user through provider/model setup before first use.
export const DEFAULT_ASSISTANT_SEED = {
  name: DEFAULT_ASSISTANT_NAME,
  emoji: DEFAULT_ASSISTANT_EMOJI,
  prompt: DEFAULT_ASSISTANT_PROMPT,
  description: '',
  modelId: null,
  settings: DEFAULT_ASSISTANT_SETTINGS
} as const
