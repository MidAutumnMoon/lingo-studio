import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))
vi.mock('@main/utils/systemInfo', () => ({
  generateUserAgent: vi.fn(() => 'test-user-agent')
}))

import { getReleaseHistory } from '../releaseHistory'

const BILINGUAL_NOTES = '<!--LANG:en-->\nNew features\n<!--LANG:zh-CN-->\n新功能\n<!--LANG:END-->'

const response = (over: Partial<Response> = {}) =>
  ({
    ok: true,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify([{ releaseNotes: BILINGUAL_NOTES, version: '2.1.0' }])),
    ...over
  }) as unknown as Response

beforeEach(() => {
  netFetchMock.mockReset()
  netFetchMock.mockResolvedValue(response())
})

describe('getReleaseHistory', () => {
  it('sends a cache-busting request and returns the parsed history', async () => {
    const history = await getReleaseHistory()

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://releases.cherry-ai.com/release-history.json',
      expect.objectContaining({
        headers: { 'User-Agent': 'test-user-agent', 'Cache-Control': 'no-cache' }
      })
    )
    expect(history).toEqual([{ releaseNotes: BILINGUAL_NOTES, version: '2.1.0' }])
  })

  it('returns null on a non-2xx response', async () => {
    netFetchMock.mockResolvedValue(response({ ok: false, status: 503 }))

    await expect(getReleaseHistory()).resolves.toBeNull()
  })

  it('returns null when the response exceeds the size limit', async () => {
    netFetchMock.mockResolvedValue(response({ headers: new Headers({ 'content-length': String(2 * 1024 * 1024) }) }))

    await expect(getReleaseHistory()).resolves.toBeNull()
  })

  it('returns null when the body is not a valid release history', async () => {
    netFetchMock.mockResolvedValue(
      response({ text: () => Promise.resolve('[{"releaseNotes":"no markers","version":"2.1.0"}]') })
    )

    await expect(getReleaseHistory()).resolves.toBeNull()
  })

  it('returns null when the request itself fails', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'))

    await expect(getReleaseHistory()).resolves.toBeNull()
  })
})
