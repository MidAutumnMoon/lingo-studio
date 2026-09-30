import { replaceComposerTokenPromptText } from '@renderer/utils/message/composerTokens'
import type { CherryMessagePart } from '@shared/data/types/message'
import { readCherryMeta } from '@shared/data/types/uiParts'

const TURN_PREVIEW_MAX_CHARS = 240

export interface TurnPreview {
  /** Display text: composer-token markers for user turns, plain text otherwise. Empty when the turn has no text. */
  text: string
  imageCount: number
  fileCount: number
}

/** Extraction stops at the character cap, so parts beyond it are never read —
 * sealed history may own getters that must not fire again after the first pass. */
function readTextPart(part: Extract<CherryMessagePart, { type: 'text' }>): string {
  const composer = readCherryMeta(part)?.composer
  return composer ? replaceComposerTokenPromptText(part.text, composer) : part.text
}

function isImagePart(part: CherryMessagePart): boolean {
  return part.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/')
}

const previewCache = new WeakMap<CherryMessagePart[], TurnPreview>()

export function getTurnPreview(parts: CherryMessagePart[]): TurnPreview {
  const cached = previewCache.get(parts)
  if (cached) return cached

  let text = ''
  let imageCount = 0
  let fileCount = 0

  for (const part of parts) {
    if (part.type === 'file') {
      if (isImagePart(part)) imageCount++
      else fileCount++
      continue
    }

    if (part.type !== 'text') continue
    if (text.length >= TURN_PREVIEW_MAX_CHARS) break

    const partText = readTextPart(part)
    if (!/\S/.test(partText)) continue

    if (text.length > 0) {
      if (text.length + 2 >= TURN_PREVIEW_MAX_CHARS) break
      text += '\n\n'
    }
    text += partText.slice(0, TURN_PREVIEW_MAX_CHARS - text.length)
  }

  const preview: TurnPreview = { text, imageCount, fileCount }
  previewCache.set(parts, preview)
  return preview
}
