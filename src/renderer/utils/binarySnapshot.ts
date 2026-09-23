import type { BinaryToolSnapshot } from '@shared/types/binary'

/**
 * Normalized, display-ready reading of a raw {@link BinaryToolSnapshot}.
 *
 * Centralizes the rules every surface needs — whether the tool resolves and
 * which path to show — so the Dependencies page and the Code CLI page cannot
 * drift in how they interpret a snapshot.
 */
export interface InterpretedBinarySnapshot {
  source: BinaryToolSnapshot['availability']['source']
  /** True when the tool resolves on the user's PATH. */
  installed: boolean
  /** Executable path when resolved through the system PATH. */
  systemPath?: string
  /** Executable path for any resolved (non-`none`) source. */
  resolvedPath?: string
}

/** Interpret a raw snapshot into the primitives a card renders. */
export function interpretBinarySnapshot(snapshot: BinaryToolSnapshot | undefined): InterpretedBinarySnapshot {
  const availability = snapshot?.availability ?? { source: 'none' as const }
  return {
    source: availability.source,
    installed: availability.source !== 'none',
    systemPath: availability.source === 'system' ? availability.path : undefined,
    resolvedPath: availability.source === 'none' ? undefined : availability.path
  }
}
