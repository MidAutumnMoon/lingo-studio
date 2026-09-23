import { ExternalLink, Play, Square } from 'lucide-react'
import { type FC, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Tooltip } from '@cherrystudio/ui'
import { CliIcon } from '@renderer/components/icons/CliIcon'

import type { VersionStatus } from '../types'

interface VersionStatusCardProps {
  toolId: string
  toolName: string
  status: VersionStatus
  onLaunch?: () => void
  onStop?: () => void
  onOpenDashboard?: () => void
  canLaunch?: boolean
  launching?: boolean
  running?: boolean
  stopping?: boolean
  launchDisabledHint?: string
}

export const VersionStatusCard: FC<VersionStatusCardProps> = ({
  toolId,
  toolName,
  status,
  onLaunch,
  onStop,
  onOpenDashboard,
  canLaunch,
  launching,
  running,
  stopping,
  launchDisabledHint
}) => {
  const { t } = useTranslation()
  const launchDisabledHintId = useId()
  const isInstalled = status.installed
  const launchUnavailable = !running && !canLaunch

  const launchButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={launchUnavailable ? undefined : running ? onStop : onLaunch}
      disabled={(running ? stopping : launching) || (launchUnavailable && !launchDisabledHint)}
      aria-disabled={(launchUnavailable && !!launchDisabledHint) || undefined}
      aria-describedby={launchUnavailable && launchDisabledHint ? launchDisabledHintId : undefined}
      className={
        running
          ? 'shrink-0 text-destructive hover:text-destructive'
          : `shrink-0 text-foreground${launchUnavailable ? ' cursor-not-allowed opacity-40' : ''}`
      }>
      {running && stopping ? (
        <>
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          {t('code.stop')}
        </>
      ) : running ? (
        <>
          <Square size={12} />
          {t('code.stop')}
        </>
      ) : launching ? (
        <>
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          {t('code.launching')}
        </>
      ) : (
        <>
          <Play size={12} />
          {t('code.launch.label')}
        </>
      )}
    </Button>
  )

  return (
    <div className="rounded-lg border border-border-subtle bg-background px-4 py-5">
      <div className="flex items-center gap-3">
        <CliIcon id={toolId} size={28} className="size-7 shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{toolName}</span>
            {status.source === 'system' && (
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title={status.systemPath}>
                {t('settings.dependencies.source.system')}
              </span>
            )}
          </div>

          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {isInstalled
              ? status.systemPath && <span className="truncate font-mono">{status.systemPath}</span>
              : // The app never installs CLIs — a missing one is the user's to install.
                t('code.not_installed')}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isInstalled && (
            <>
              {launchDisabledHint && launchUnavailable ? (
                <Tooltip content={launchDisabledHint} placement="top" delay={300} sideOffset={6}>
                  {launchButton}
                </Tooltip>
              ) : (
                launchButton
              )}
              {launchDisabledHint && launchUnavailable ? (
                <span id={launchDisabledHintId} className="sr-only">
                  {launchDisabledHint}
                </span>
              ) : null}
            </>
          )}

          {isInstalled && running && onOpenDashboard && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenDashboard}
              className="shrink-0 text-foreground">
              <ExternalLink size={12} />
              {t('code.open_web_ui')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
