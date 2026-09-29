import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import { useProvider } from '@renderer/hooks/useProvider'

const logger = loggerService.withContext('useOvmsModelDownloadAction')

export function useOvmsModelDownloadAction(providerId: string) {
  const { t } = useTranslation()
  const { provider } = useProvider(providerId)

  const openOvmsModelDownload = useCallback(() => {
    if (provider) {
      // Deferred import keeps the OVMS download machinery out of the settings
      // first-open chunk; it loads on first use.
      void import('./DownloadOvmsModelPopup')
        .then((m) => m.default.show({ title: t('ovms.download.title'), provider }))
        .catch((error) => logger.error('Failed to open OVMS model download popup', error as Error))
    }
  }, [provider, t])

  return {
    openOvmsModelDownload
  }
}
