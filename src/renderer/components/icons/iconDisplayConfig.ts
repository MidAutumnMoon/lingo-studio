import { getProviderIconAssetMetrics } from '@cherrystudio/ui/icons'

export interface IconDisplayConfig {
  scale: number
  borderRadius?: number
}

const providerListContainedIcon: IconDisplayConfig = { scale: 5 / 7, borderRadius: 5 }
const defaultIcon: IconDisplayConfig = { scale: 1.2 }

export function getIconDisplayConfig(iconId: string | undefined): IconDisplayConfig | undefined {
  if (!iconId) return undefined
  return getProviderIconAssetMetrics({ kind: 'provider', iconId }).kind === 'tile'
    ? providerListContainedIcon
    : defaultIcon
}
