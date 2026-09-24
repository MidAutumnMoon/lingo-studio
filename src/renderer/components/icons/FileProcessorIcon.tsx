import { FileText } from 'lucide-react'

import type { CompoundIcon } from '@cherrystudio/ui'
import { Application, Doc2x, Intel, Mineru, Mistral, Paddleocr, TesseractJs } from '@cherrystudio/ui/icons/providers'
import { cn } from '@renderer/utils/style'
import type { FileProcessorId } from '@shared/data/preference/preferenceTypes'

/**
 * The mark for each file processor.
 *
 * This map lives in `components/` because the knowledge RAG panel and the
 * file-processing settings page both need it. They used to keep a copy each,
 * and the day one processor was added to only one of them, `Logo.Avatar` on
 * `undefined` took the whole RAG panel down.
 */
const PROCESSOR_LOGOS = {
  system: Application,
  tesseract: TesseractJs,
  paddleocr: Paddleocr,
  ovocr: Intel,
  mineru: Mineru,
  doc2x: Doc2x,
  mistral: Mistral,
  'open-mineru': Mineru
} as const satisfies Partial<Record<FileProcessorId, CompoundIcon>>

interface FileProcessorIconProps {
  /**
   * Typed as a plain string, not `FileProcessorId`: ids also arrive from
   * persisted config, where one can outlive the processor it names. An unknown
   * id must degrade to the neutral glyph, never throw.
   */
  processorId: string
  size?: number
  className?: string
}

export const FileProcessorIcon = ({ processorId, size = 16, className }: FileProcessorIconProps) => {
  const Logo = (PROCESSOR_LOGOS as Partial<Record<string, CompoundIcon>>)[processorId]

  if (!Logo) {
    return <FileText size={size} className={cn('shrink-0 text-muted-foreground', className)} />
  }

  return <Logo.Avatar size={size} shape="rounded" className={cn('rounded', className)} />
}
