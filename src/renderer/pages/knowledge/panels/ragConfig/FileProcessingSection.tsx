import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { openSettingsTab } from '@renderer/services/mainWindowNavigation'

import { useOpenMineruConnectivity } from '../../hooks/useOpenMineruConnectivity'
import { FileProcessorSelector, type FileProcessorSelectorOption } from './FileProcessorSelector'
import { RagFieldLabel } from './panelPrimitives'

const openFileProcessingSettings = () => openSettingsTab('/settings/file-processing')

interface FileProcessingSectionProps {
  fileProcessorId: string | null
  initialFileProcessorId: string | null
  fileProcessorOptions: FileProcessorSelectorOption[]
  onFileProcessorChange: (value: string | null) => void
}

const FileProcessingSection = ({
  fileProcessorId,
  initialFileProcessorId,
  fileProcessorOptions,
  onFileProcessorChange
}: FileProcessingSectionProps) => {
  const { t } = useTranslation()
  // Open MinerU is the only self-hosted processor, so one unconditional probe
  // covers it. Probing every API processor instead would
  // fire requests at third-party SaaS hosts the user never asked us to contact.
  const { reachable, isResolved: isConnectivityResolved } = useOpenMineruConnectivity()

  const options = useMemo(
    () =>
      fileProcessorOptions.flatMap((option) => {
        if (option.value !== 'open-mineru') {
          return [option]
        }

        const unreachable = isConnectivityResolved && !reachable
        const isPersistedSelection = option.value === initialFileProcessorId

        // Starting the server is something only the user can do, outside the app,
        // so a dead row offers nothing to act on — drop it rather than grey it out.
        // Unless this base is already saved with it: the trigger reads its label
        // from this list, so hiding it would show "not in use" for a base that is
        // still configured to use it.
        if (unreachable && !isPersistedSelection) {
          return []
        }

        return [
          {
            ...option,
            disabled: option.disabled || !isConnectivityResolved || unreachable,
            statusLabel: unreachable ? t('knowledge.rag.processor_unreachable') : option.statusLabel
          }
        ]
      }),
    [fileProcessorOptions, initialFileProcessorId, isConnectivityResolved, reachable, t]
  )

  const handleChange = (value: string | null) => {
    if (value === 'open-mineru' && (!isConnectivityResolved || !reachable)) {
      return
    }

    onFileProcessorChange(value)
  }

  return (
    <div>
      <RagFieldLabel label={t('knowledge.rag.file_processing')} hint={t('knowledge.rag.file_processing_hint')} />
      <FileProcessorSelector
        aria-label={t('knowledge.rag.file_processing')}
        value={fileProcessorId}
        options={options}
        placeholder={t('knowledge.rag.file_processing_none')}
        settingsLabel={t('common.go_to_settings')}
        onChange={handleChange}
        onSettingsNavigate={openFileProcessingSettings}
      />
    </div>
  )
}

export default FileProcessingSection
