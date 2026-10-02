import { DIAGNOSTIC_UPLOAD_URL } from '@main/services/diagnostics'
import { resolveRegistryBaseUrl } from '@main/services/ProviderRegistryUpdaterService'

import type { NetworkEndpoint } from './types'

/** Built-in URLs use their owning services' resolution. */
export async function builtinEndpoints(): Promise<readonly NetworkEndpoint[]> {
  return [
    { id: 'registry', url: `${await resolveRegistryBaseUrl()}/manifest.json` },
    { id: 'diagnostics', url: DIAGNOSTIC_UPLOAD_URL }
  ]
}
