import { describe, expect, it, vi } from 'vitest'

// Focused byte-format coverage for the backup filename stamps. The heavyweight LegacyBackupManager
// suite covers workflows; these tests pin only the frozen filename contracts. Infrastructure
// (@logger/@application/electron) comes from the global mocks in tests/main.setup.ts.

vi.mock('@main/utils/system', () => ({
  getDeviceType: () => 'test-device',
  getHostname: () => 'test-host'
}))

vi.mock('@main/utils/file', () => ({
  createAtomicWriteStream: vi.fn()
}))

vi.mock('@main/data/db/restore/hashDbFile', () => ({ hashDbFile: vi.fn() }))
vi.mock('@main/data/db/restore/restoreJournal', () => ({
  readRestoreJournal: vi.fn(),
  writeRestoreJournal: vi.fn()
}))
vi.mock('@main/data/db/restore/checkpoint', () => ({ checkpointTruncateAssert: vi.fn() }))
vi.mock('@main/data/db/restore/appliedChain', () => ({ readAppliedChain: vi.fn() }))

vi.mock('fs-extra', () => ({ ensureDir: vi.fn(async () => undefined) }))
vi.mock('archiver', () => ({ ZipArchive: vi.fn() }))
vi.mock('node-stream-zip', () => ({ default: { async: vi.fn() } }))
vi.mock('../WebDav', () => ({ default: vi.fn(class {}) }))
vi.mock('../S3Storage', () => ({ default: vi.fn() }))

import BackupManager from '../LegacyBackupManager'

describe('BackupManager filename stamps', () => {
  it('names default backups with the 17-digit local-clock stamp and device identity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 6, 7, 8, 9, 123))
    try {
      // Private helper, but the filename it mints is the frozen remote-backup contract.
      const fileName = (new BackupManager() as unknown as { createBackupFileName: () => string }).createBackupFileName()
      expect(fileName).toBe('cherry-studio.20261006070809123.test-host.test-device.zip')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names LAN transfer backups with the 14-digit UTC-derived stamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 6, 7, 8, 9))
    try {
      const manager = new BackupManager()
      const backupLegacy = vi.spyOn(manager, 'backupLegacy').mockResolvedValue('/mock/dest/backup.zip')

      await manager.createLanTransferBackup({} as never, '{}', '/mock/dest')

      expect(backupLegacy).toHaveBeenCalledWith(
        expect.anything(),
        'cherry-studio.20261006070809.zip',
        '{}',
        '/mock/dest',
        true
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
