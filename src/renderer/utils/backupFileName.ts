import { ipcApi } from '@renderer/ipc'
import { formatNumericNow } from '@renderer/utils/time'

export async function createDefaultBackupFileName(): Promise<string> {
  const [deviceType, hostname] = await Promise.all([
    ipcApi.request('system.get_device_type'),
    window.api.system.getHostname()
  ])
  const timestamp = formatNumericNow('YYYYMMDDHHmmss')

  return `cherry-studio.${timestamp}.${hostname}.${deviceType}.zip`
}
