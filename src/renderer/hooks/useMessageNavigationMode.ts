import { usePreference } from '@data/hooks/usePreference'
import { normalizeChatMessageNavigationMode } from '@shared/data/preference/preferenceTypes'

/** Reads `chat.message.navigation_mode` with legacy values normalized: the
 * removed 'buttons' mode (and anything unknown) reads as the anchor rail. */
export function useMessageNavigationMode() {
  const [mode, setMode] = usePreference('chat.message.navigation_mode')
  return [normalizeChatMessageNavigationMode(mode), setMode] as const
}
