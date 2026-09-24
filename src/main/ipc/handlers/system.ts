import { nativeTheme, shell } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
import { regionService } from '@main/services/RegionService'
import { isSafeExternalUrl } from '@main/utils/externalUrlSafety'
import { getDeviceType } from '@main/utils/system'
import { ThemeMode } from '@shared/data/preference/preferenceTypes'
import type { systemRequestSchemas } from '@shared/ipc/schemas/system'
import type { IpcHandlersFor } from '@shared/ipc/types'

const logger = loggerService.withContext('systemHandlers')

/**
 * System-domain handlers. Most are stateless host-environment queries; `toggle_dev_tools`
 * acts on the caller window, resolved from `ctx.senderId` via WindowManager (the legacy
 * handler used `BrowserWindow.fromWebContents(event.sender)`).
 *
 * The `system.shell.*` routes delegate straight to Electron's `shell` and ignore
 * `IpcContext` (they act on app-level OS resources, not the caller's window). `open_website`
 * drops a URL that fails the scheme guard with a warning instead of opening it externally.
 */
export const systemHandlers: IpcHandlersFor<typeof systemRequestSchemas> = {
  'system.get_device_type': async () => getDeviceType(),
  'system.get_native_theme': async () => (nativeTheme.shouldUseDarkColors ? ThemeMode.dark : ThemeMode.light),
  'system.toggle_dev_tools': async (_input, { senderId }) => {
    if (!senderId) return
    application.get('WindowManager').getWindow(senderId)?.webContents.toggleDevTools()
  },
  'system.get_fonts': async () => {
    try {
      const { default: fontList } = await import('font-list')
      const fonts = await fontList.getFonts()
      return fonts.map((font: string) => font.replace(/^"(.*)"$/, '$1')).filter((font: string) => font.length > 0)
    } catch (error) {
      logger.error('Failed to get system fonts:', error as Error)
      return []
    }
  },
  'system.get_ip_country': async () => regionService.getCountry(),
  'system.shell.open_path': async (path) => {
    await shell.openPath(path)
  },
  'system.shell.open_external_website': async (url) => {
    if (isSafeExternalUrl(url)) await shell.openExternal(url)
  },
  'system.shell.open_website': async (url) => {
    if (!isSafeExternalUrl(url)) {
      logger.warn(`Blocked shell.openExternal for untrusted URL scheme: ${url}`)
      return
    }
    await application.get('MainWindowService').openWebsite(url)
  }
}
