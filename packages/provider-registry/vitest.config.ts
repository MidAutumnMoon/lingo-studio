import { defineConfig } from 'vitest/config'

// Package-local config: Vitest 5 no longer resolves parent-directory configs, so
// `pnpm test` here would otherwise run with no config at all.
export default defineConfig({
  test: {
    environment: 'node'
  }
})
