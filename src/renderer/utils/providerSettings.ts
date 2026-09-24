import type { Provider } from '@shared/data/types/provider'
import { isCherryAIProvider } from '@shared/utils/provider'

export function isProviderSettingsListVisibleProvider(provider: Provider): boolean {
  return !isCherryAIProvider(provider)
}
