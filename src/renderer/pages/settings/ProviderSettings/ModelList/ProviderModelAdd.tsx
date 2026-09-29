import { Plus } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, NormalTooltip } from '@cherrystudio/ui'
import type { UniqueModelId } from '@shared/data/types/model'

import { modelListClasses } from '../primitives/ProviderSettingsPrimitives'

// Deferred chunk: the add/edit-model form suite is only needed on interaction
// and must not sit in the settings first-open graph.
const AddModelDrawer = lazy(() => import('./ModelDrawer').then((m) => ({ default: m.AddModelDrawer })))

interface ProviderModelAddProps {
  providerId: string
  disabled: boolean
}

interface ProviderModelAddDialogProps {
  providerId: string
  open: boolean
  onClose: () => void
  onSuccess?: (modelIds: UniqueModelId[]) => void
  showPurposeSelection?: boolean
}

export function ProviderModelAddDialog({
  providerId,
  open,
  onClose,
  onSuccess,
  showPurposeSelection
}: ProviderModelAddDialogProps) {
  // Mount-once-opened: the lazy chunk loads on first open; after that the
  // drawer stays mounted so the panel's exit animation has stable content.
  const [mounted, setMounted] = useState(false)
  if (open && !mounted) setMounted(true)

  if (!mounted) return null

  return (
    <Suspense fallback={null}>
      <AddModelDrawer
        providerId={providerId}
        open={open}
        prefill={null}
        onClose={onClose}
        onSuccess={onSuccess}
        showPurposeSelection={showPurposeSelection}
      />
    </Suspense>
  )
}

const ProviderModelAdd: React.FC<ProviderModelAddProps> = ({ providerId, disabled }) => {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
  }, [])
  const label = t('settings.provider.api_setup.add_model_manually')

  return (
    <>
      <NormalTooltip content={label}>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={modelListClasses.addModelIconButton}
          disabled={disabled}
          aria-label={label}
          onClick={openDrawer}>
          <Plus className={modelListClasses.toolbarDesignIcon} />
        </Button>
      </NormalTooltip>
      <ProviderModelAddDialog providerId={providerId} open={drawerOpen} onClose={closeDrawer} />
    </>
  )
}

export default ProviderModelAdd
