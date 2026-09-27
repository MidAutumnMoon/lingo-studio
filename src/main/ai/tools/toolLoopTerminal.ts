/**
 * Trusted terminal tool failures: a process-local brand over a tool output shape,
 * plus the turn-level error the loop surfaces for one.
 *
 * Lives at the tools layer (not the ai-sdk runtime dir) because BOTH engines consume
 * it — the legacy loop stops on the brand at a step boundary, the pi engine maps it
 * onto pi's per-result `terminate` hint and fails the turn at verdict time — and the
 * ai-sdk adapter dir does not survive the pi unification's Phase 2.
 */

export interface TerminalToolFailure {
  error: string
  userMessage?: string
  i18nKey?: string
}

const trustedTerminalFailures = new WeakSet<object>()

type TerminalFailureOutput = {
  terminal: true
  retryable: false
  error: string
  userMessage?: unknown
  i18nKey?: unknown
}

function isTerminalFailureOutput(output: unknown): output is TerminalFailureOutput {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return false

  const candidate = output as Record<string, unknown>
  return candidate.terminal === true && candidate.retryable === false && typeof candidate.error === 'string'
}

/** Preserve output identity and brand it only when it has the terminal failure shape. */
export function markTrustedLocalToolTerminalFailure<T>(output: T): T {
  if (isTerminalFailureOutput(output)) trustedTerminalFailures.add(output)
  return output
}

export function getTrustedLocalToolTerminalFailure(output: unknown): TerminalToolFailure | undefined {
  if (!isTerminalFailureOutput(output) || !trustedTerminalFailures.has(output)) return undefined

  return {
    error: output.error,
    ...(typeof output.userMessage === 'string' && { userMessage: output.userMessage }),
    ...(typeof output.i18nKey === 'string' && { i18nKey: output.i18nKey })
  }
}

export class ToolLoopTerminalError extends Error {
  constructor(
    message: string,
    public readonly i18nKey?: string
  ) {
    super(message)
    this.name = 'ToolLoopTerminalError'
  }
}

export const TOOL_CALL_LIMIT_I18N_KEY = 'tool_call_limit_reached'

export const TOOL_CALL_LIMIT_MESSAGE =
  'The assistant reached the tool-call limit before producing a final answer. Raise "Max tool call rounds" in the assistant settings, or reduce the task scope.'
