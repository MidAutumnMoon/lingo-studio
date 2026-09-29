import { app } from 'electron'

import { defineDoctorCheck } from '../types'

/**
 * An x64 build on an arm64 machine (Apple Silicon via Rosetta, Windows on ARM via WOW) runs
 * translated: slower, and every prebuilt native module is the x64 one. `process.arch` cannot
 * see this — the translator exists precisely to report `x64` — so ask Electron, which reads
 * the OS translation flag. The property is darwin/win32 only; elsewhere there is no translator.
 */
export const installArchitectureMatch = defineDoctorCheck({
  id: 'install-architecture-match',
  async run() {
    if (!app.runningUnderARM64Translation) return { status: 'pass' }
    return {
      status: 'warn',
      attribution: 'user-fixable',
      detail: { variant: 'translated', params: { arch: process.arch } },
      actions: [{ kind: 'navigate', target: '/settings/about' }],
      devMessage: `Running the ${process.arch} build under ARM64 translation on ${process.platform}`,
      evidence: [
        { key: 'processArch', value: process.arch, dataClass: 'public' },
        { key: 'platform', value: process.platform, dataClass: 'public' },
        { key: 'translated', value: true, dataClass: 'public' }
      ]
    }
  },
  fixes: {}
})
