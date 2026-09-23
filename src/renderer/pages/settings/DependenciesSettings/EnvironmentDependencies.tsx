import { Icon } from '@iconify/react'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, FolderOpen, Terminal, TriangleAlert } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import babeldocIcon from '@renderer/assets/images/dependencies/babeldoc.png'
import { ipcApi } from '@renderer/ipc'
import { openExternalWebsite } from '@renderer/services/website'
import { interpretBinarySnapshot } from '@renderer/utils/binarySnapshot'
import { cn } from '@renderer/utils/style'
import { type BinaryToolPreset, PRESETS_BINARY_TOOLS } from '@shared/data/presets/binaryTools'
import type { BinaryToolSnapshot } from '@shared/types/binary'

const logger = loggerService.withContext('EnvironmentDependencies')

// Tools whose brand mark isn't in an icon font (iconify) ship a bundled image instead, keyed by
// preset name. Lives here rather than on the shared preset, which must not import renderer assets.
const TOOL_IMAGE_ICONS: Record<string, string> = {
  'babeldoc-stream': babeldocIcon
}

const ToolIcon: FC<{ name?: string; icon?: string; className?: string }> = ({ name, icon, className }) => {
  const imageSrc = name ? TOOL_IMAGE_ICONS[name] : undefined
  if (imageSrc) {
    return <img src={imageSrc} alt="" className={cn('size-5 rounded-[5px]', className)} />
  }
  if (icon) {
    return <Icon icon={icon} className={cn('size-5', className)} />
  }
  return <Terminal className={cn('size-5', className)} />
}

interface EnvironmentDependenciesProps {
  mini?: boolean
}

// Read-only PATH dashboard: this fork installs nothing, so the page only
// reports whether each preset executable resolves on the user's login shell.
const EnvironmentDependencies: FC<EnvironmentDependenciesProps> = ({ mini = false }) => {
  // Null until the one-shot mount fetch settles — mini mode stays hidden until then.
  const [snapshots, setSnapshots] = useState<Record<string, BinaryToolSnapshot> | null>(null)
  const { t } = useTranslation()
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    ipcApi
      .request(
        'binary.get_tool_snapshots',
        PRESETS_BINARY_TOOLS.map((tool) => tool.name)
      )
      .then((nextSnapshots) => {
        if (!cancelled) setSnapshots(nextSnapshots)
      })
      .catch((error) => {
        logger.error('Failed to read tool snapshots', error as Error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openToolDir = (binaryPath: string) => {
    const separator = Math.max(binaryPath.lastIndexOf('/'), binaryPath.lastIndexOf('\\'))
    void ipcApi.request('system.shell.open_path', separator > 0 ? binaryPath.slice(0, separator) : binaryPath)
  }

  if (mini) {
    if (!snapshots) {
      return null
    }

    const uvAvailable = !!snapshots.uv && snapshots.uv.availability.source !== 'none'
    const bunAvailable = !!snapshots.bun && snapshots.bun.availability.source !== 'none'
    if (uvAvailable && bunAvailable) {
      return null
    }

    return (
      <Button
        className="nodrag h-8 rounded-lg px-2 text-destructive shadow-none hover:text-destructive"
        variant="ghost"
        aria-label={t('settings.dependencies.title')}
        title={t('settings.dependencies.title')}
        onClick={() => navigate({ to: '/settings/dependencies' })}>
        <TriangleAlert size={14} />
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-[15px] leading-6 font-semibold text-foreground">{t('settings.dependencies.title')}</h1>
          <span className="text-xs text-foreground-tertiary">{PRESETS_BINARY_TOOLS.length}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.dependencies.description')}</p>
      </div>

      <div role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {PRESETS_BINARY_TOOLS.map((tool) => {
          const view = interpretBinarySnapshot(snapshots?.[tool.name])
          return (
            <BinaryToolPresetCard
              key={tool.name}
              tool={tool}
              found={view.installed}
              resolvedPath={view.resolvedPath}
              onOpenPath={() => view.resolvedPath && openToolDir(view.resolvedPath)}
            />
          )
        })}
      </div>
    </div>
  )
}

const BinaryToolPresetCard: FC<{
  tool: BinaryToolPreset
  found: boolean
  resolvedPath?: string
  onOpenPath: () => void
}> = ({ tool, found, resolvedPath, onOpenPath }) => {
  const { t } = useTranslation()
  const description = t(`settings.dependencies.tools.${tool.name}`)

  return (
    <div
      role="listitem"
      className="flex flex-col rounded-xl border border-border p-4 transition-colors duration-200 ease-in-out hover:border-border-strong"
      style={{ backgroundColor: 'var(--settings-group-background, var(--card))' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              found ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            )}>
            <ToolIcon name={tool.name} icon={tool.icon} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm leading-5 text-foreground">{tool.displayName}</span>
              {tool.displayName !== tool.name && (
                <span className="text-xs text-foreground-tertiary">({tool.name})</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              {found ? (
                <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[11px] leading-4" title={resolvedPath}>
                  {t('settings.dependencies.source.system')}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[11px] leading-4">
                  {t('settings.dependencies.source.none')}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 text-xs leading-4 text-muted-foreground" title={description}>
        {description}
      </p>

      <div className="mt-3 flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => void openExternalWebsite(tool.repoUrl)}>
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{tool.repoUrl.replace('https://github.com/', '')}</span>
        </button>
        {tool.homepage && (
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void openExternalWebsite(tool.homepage!)}>
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">{tool.homepage.replace(/^https?:\/\//, '')}</span>
          </button>
        )}
        {found && (
          <button
            type="button"
            onClick={onOpenPath}
            aria-label={t('settings.dependencies.openBinariesDir')}
            title={t('settings.dependencies.openBinariesDir')}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <FolderOpen className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

export default EnvironmentDependencies
