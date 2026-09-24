import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const ripgrepExecutable = process.platform === 'win32' ? 'rg.exe' : 'rg'

function systemRipgrepPath(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, [ripgrepExecutable], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]
    return out && fs.existsSync(out) ? out : null
  } catch {
    return null
  }
}

/**
 * Absolute path to a real ripgrep binary for file-tree tests.
 *
 * Production resolves ripgrep from the user's login-shell PATH
 * (`findExecutableInEnv('rg')`), which has no test-visible locations. Tests
 * mock the resolver to return this binary so directory scans spawn real ripgrep.
 */
export function testRipgrepPath(): string {
  const systemPath = systemRipgrepPath()
  if (systemPath) return systemPath

  throw new Error('Test ripgrep binary not found')
}

/** Non-throwing variant — returns `null` when no ripgrep binary can be located. */
export function tryTestRipgrepPath(): string | null {
  try {
    return testRipgrepPath()
  } catch {
    return null
  }
}
