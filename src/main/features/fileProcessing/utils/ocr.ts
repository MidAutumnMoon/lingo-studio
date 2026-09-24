import { readFile } from 'fs/promises'

import { preprocessImage } from '@main/utils/ocr'
import type { FileInfo } from '@shared/types/file'

export const loadOcrImage = async (file: FileInfo): Promise<Buffer> => {
  const buffer = await readFile(file.path)
  return preprocessImage(buffer)
}
