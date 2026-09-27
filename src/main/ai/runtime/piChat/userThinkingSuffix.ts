/**
 * User-prompt thinking suffixes — the two legacy prompt-shaping dialects that cannot ride
 * provider parameters (W5 register rows "qwen-thinking (/think suffix)" and "ovms /no_think"):
 *
 * - qwen `/think`·`/no_think`: qwen models with a controllable thinking-token toggle served
 *   by providers WITHOUT native `enable_thinking` (everything outside the
 *   `NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS` deny list that is also not ollama — in
 *   practice nvidia/gpustack). Suffix every user text part.
 * - ovms `/no_think`: the ovms provider, only when MCP tools are declared. Suffix the
 *   FINAL user content block, and only when it is text.
 *
 * One resolver + one text application so the engine (trailing prompt) and the history
 * converter (replayed user messages) cannot drift — legacy re-suffixed the whole outgoing
 * prompt every request, history included, and replay parity requires the same bytes.
 */
import type { ResolvedReasoningKind } from '@main/ai/utils/reasoningSerializers'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { isQwen35to39Model, isSupportedThinkingTokenQwenModel } from '@shared/utils/model'
import { isOllamaProvider, isSupportEnableThinkingProvider } from '@shared/utils/provider'

export interface UserThinkingSuffixInput {
  provider: Provider
  model: Model
  reasoningKind: ResolvedReasoningKind
  /** The qwen feature's outer gate: an assistant context or an explicit per-request effort. */
  hasAssistant: boolean
  hasExplicitReasoningEffort: boolean
  /** MCP tools declared for this request — the ovms feature keys on their presence alone. */
  mcpToolCount: number
}

export interface UserTextSuffix {
  /** Includes the leading space, exactly as legacy appended (`' /think'`). */
  text: string
  /**
   * `every-text-part` — qwen: each user text part gets the suffix unless it already ends
   * with either token. `final-text-block` — ovms: only the last content block, only when
   * it is text, skipped when it already ends with `/no_think`.
   */
  scope: 'every-text-part' | 'final-text-block'
}

/** Resolve the turn's user-text suffix; `undefined` when no dialect applies. */
export function resolveUserThinkingSuffix(input: UserThinkingSuffixInput): UserTextSuffix | undefined {
  const qwenApplies =
    (input.hasAssistant || input.hasExplicitReasoningEffort) &&
    !isOllamaProvider(input.provider) &&
    isSupportedThinkingTokenQwenModel(input.model) &&
    !isQwen35to39Model(input.model) &&
    !isSupportEnableThinkingProvider(input.provider) &&
    input.reasoningKind !== 'omit'
  if (qwenApplies) {
    return { text: input.reasoningKind !== 'off' ? ' /think' : ' /no_think', scope: 'every-text-part' }
  }
  if (input.provider.id === 'ovms' && input.mcpToolCount > 0) {
    return { text: ' /no_think', scope: 'final-text-block' }
  }
  return undefined
}

/**
 * Append the suffix to one user text, honoring the dialect's guard. For a single-text
 * message both scopes coincide — this is also what the engine applies to the trailing
 * prompt (legacy suffixed it as part of the same outgoing-prompt rewrite).
 */
export function applyUserTextSuffix(text: string, suffix: UserTextSuffix): string {
  if (suffix.scope === 'every-text-part') {
    return text.endsWith('/think') || text.endsWith('/no_think') ? text : text + suffix.text
  }
  return text.endsWith('/no_think') ? text : text + suffix.text
}
