import { net } from 'electron'

import { loggerService } from '@logger'
import { generateUserAgent } from '@main/utils/systemInfo'
import { parseReleaseHistory, type ReleaseNotesEntry } from '@shared/utils/releaseNotes'

const logger = loggerService.withContext('releaseHistory')

const RELEASE_HISTORY_URL = 'https://releases.cherry-ai.com/release-history.json'
const RELEASE_HISTORY_TIMEOUT_MS = 10_000
const RELEASE_HISTORY_MAX_BYTES = 1024 * 1024

/**
 * Fetch the upstream release history for the release-notes page. Best-effort:
 * returns null on any failure so the page can fall back to bundled notes.
 */
export async function getReleaseHistory(): Promise<ReleaseNotesEntry[] | null> {
  try {
    const response = await net.fetch(RELEASE_HISTORY_URL, {
      headers: {
        'User-Agent': generateUserAgent(),
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(RELEASE_HISTORY_TIMEOUT_MS)
    })

    if (!response.ok) {
      throw new Error(`Release history request failed with HTTP ${response.status}`)
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > RELEASE_HISTORY_MAX_BYTES) {
      throw new Error('Release history response exceeds the size limit')
    }

    const source = await response.text()
    if (Buffer.byteLength(source, 'utf-8') > RELEASE_HISTORY_MAX_BYTES) {
      throw new Error('Release history response exceeds the size limit')
    }

    return parseReleaseHistory(source)
  } catch (error) {
    logger.warn('Failed to fetch release history', error as Error)
    return null
  }
}
