import { describe, expect, it } from 'vitest'

import type { CherryMessagePart } from '@shared/data/types/message'

import { getTurnPreview, TURN_PREVIEW_MAX_CHARS } from '../turnPreview'

const textPart = (text: string): CherryMessagePart => ({ type: 'text', text })

const filePart = (mediaType: string): CherryMessagePart =>
  ({ type: 'file', mediaType, url: 'file:///x' }) as CherryMessagePart

describe('getTurnPreview', () => {
  it('joins text parts and caps the preview at the character limit', () => {
    const a = 'x'.repeat(200)
    const b = 'y'.repeat(200)
    const preview = getTurnPreview([textPart(a), textPart(b)])

    expect(preview.text).toBe(`${a}\n\n${'y'.repeat(38)}`)
    expect(preview.text).toHaveLength(TURN_PREVIEW_MAX_CHARS)
  })

  it('stops reading parts once the cap is reached', () => {
    const beyond = {
      type: 'text',
      get text(): string {
        throw new Error('preview extraction read past its limit')
      }
    } as CherryMessagePart
    const preview = getTurnPreview([textPart('x'.repeat(240)), beyond])

    expect(preview.text).toHaveLength(TURN_PREVIEW_MAX_CHARS)
  })

  it('shows composer token markers instead of the substituted prompt text', () => {
    // A skill token persists `text` with the full prompt substituted in; the
    // composer snapshot on the part maps it back to the /marker/ form.
    const part = {
      type: 'text',
      text: 'Full translated skill prompt body',
      providerMetadata: {
        cherry: {
          composer: {
            version: 1,
            tokens: [
              {
                id: 'skill:translate',
                kind: 'skill',
                label: 'Translate',
                textOffset: 0,
                index: 0,
                promptText: 'Full translated skill prompt body'
              }
            ]
          }
        }
      }
    } as unknown as CherryMessagePart

    const preview = getTurnPreview([part])

    expect(preview.text).toBe('/translate/')
  })

  it('counts image and non-image file parts alongside the text', () => {
    const preview = getTurnPreview([
      filePart('image/png'),
      filePart('image/jpeg'),
      filePart('application/pdf'),
      textPart('Look at this')
    ])

    expect(preview).toMatchObject({ text: 'Look at this', imageCount: 2, fileCount: 1 })
  })

  it('returns no text and zero counts for a turn without content parts', () => {
    const preview = getTurnPreview([{ type: 'data-translation', data: { content: 'x', targetLanguage: 'de' } } as unknown as CherryMessagePart])

    expect(preview).toEqual({ text: '', imageCount: 0, fileCount: 0 })
  })

  it('skips whitespace-only text parts', () => {
    const preview = getTurnPreview([textPart('   \n\t '), textPart('real')])

    expect(preview.text).toBe('real')
  })

  it('extracts each parts array only once', () => {
    let reads = 0
    const parts = [
      {
        type: 'text',
        get text() {
          reads++
          return 'cached?'
        }
      }
    ] as unknown as CherryMessagePart[]

    getTurnPreview(parts)
    getTurnPreview(parts)

    expect(reads).toBe(1)
  })

  it('treats two different parts arrays as distinct cache entries', () => {
    expect(getTurnPreview([textPart('a')]).text).toBe('a')
    expect(getTurnPreview([textPart('a')]).text).toBe('a')
  })
})
