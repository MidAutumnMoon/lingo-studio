import { useMemo } from 'react'

import { useProvider } from '@renderer/hooks/useProvider'
import { hasVisibleProviderApiOptions } from '@renderer/pages/settings/ProviderSettings/utils/providerApiOptions'
import { getFancyProviderName } from '@renderer/pages/settings/ProviderSettings/utils/providerDisplay'
import { isAwsBedrockProvider, isAzureOpenAIProvider, isVertexProvider, matchesPreset } from '@shared/utils/provider'

/** Exposes read-only provider presentation metadata used across provider settings. */
export function useProviderMeta(providerId: string) {
  const { provider } = useProvider(providerId)

  return useMemo(() => {
    const hideApiInput = provider ? isAwsBedrockProvider(provider) : false
    const hideApiKeyInput = provider ? isVertexProvider(provider) : false
    const isDmxapi = provider ? matchesPreset(provider, 'dmxapi') : false

    return {
      provider,
      fancyProviderName: provider ? getFancyProviderName(provider) : '',
      officialWebsite: provider?.websites?.official,
      apiKeyWebsite: provider?.websites?.apiKey,
      docsWebsite: provider?.websites?.docs,
      modelsWebsite: provider?.websites?.models,
      isAzureOpenAI: provider ? isAzureOpenAIProvider(provider) : false,
      isDmxapi,
      showApiOptionsButton: provider ? hasVisibleProviderApiOptions(provider) : false,
      isApiKeyFieldVisible: !hideApiInput && !hideApiKeyInput,
      isConnectionFieldVisible: !hideApiInput && !isDmxapi
    }
  }, [provider])
}
