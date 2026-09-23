import type { IconComponent } from '@cherrystudio/ui/icons'
import type { CodeCli } from '@shared/types/codeCli'

export interface CodeToolMeta {
  id: CodeCli
  label: string
  icon: IconComponent | null | undefined
}

/** Read-only PATH observation for a single CLI tool executable. */
export interface VersionStatus {
  installed: boolean
  source: 'system' | 'none'
  systemPath?: string
}
