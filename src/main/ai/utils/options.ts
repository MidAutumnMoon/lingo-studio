import type { ProviderOptions } from '@ai-sdk/provider-utils'

import { ENDPOINT_TYPE, type EndpointType, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { type AiSdkParam, isAiSdkParam } from '@shared/types/aiSdk'
import { isSupportFastMode } from '@shared/utils/provider'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import type { AppProviderId } from '../types'
import { encodeReasoningInvocation, type ResolvedReasoningInvocation } from './reasoningSerializers'

export function applyFastModeToProviderOptions(
  provider: Pick<Provider, 'fastMode'>,
  model: Pick<Model, 'supportsFastMode'>,
  providerOptions: ProviderOptions,
  fastMode: boolean
): ProviderOptions {
  if (!fastMode || !isSupportFastMode(provider, model)) {
    return providerOptions
  }
  if (provider.fastMode.transport !== 'openai-priority') return providerOptions
  const serviceTier = provider.fastMode.serviceTier ?? 'priority'

  return {
    ...providerOptions,
    openai: {
      ...providerOptions.openai,
      serviceTier
    }
  }
}

function shouldNormalizeOpenAICompatibleReasoning(
  providerId: AppProviderId,
  endpointType: EndpointType | undefined
): boolean {
  return (
    providerId === 'openai-compatible' ||
    providerId === 'google-vertex-maas' ||
    (endpointType === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS &&
      (providerId === 'aihubmix' || providerId === SystemProviderIds.dmxapi))
  )
}

export function extractAiSdkStandardParams(customParams: Record<string, any>): {
  standardParams: Partial<Record<AiSdkParam, any>>
  providerParams: Record<string, any>
} {
  const standardParams: Partial<Record<AiSdkParam, any>> = {}
  const providerParams: Record<string, any> = {}

  for (const [key, value] of Object.entries(customParams)) {
    if (isAiSdkParam(key)) {
      standardParams[key] = value
    } else {
      providerParams[key] = value
    }
  }
  return { standardParams, providerParams }
}

function encodeReasoningOptions(
  providerOptionsKey: string,
  invocation: ResolvedReasoningInvocation
): { providerId: string; options: Record<string, unknown> } {
  return { providerId: providerOptionsKey, options: encodeReasoningInvocation(invocation) }
}

/** Build the single providerOptions namespace that owns reasoning for this endpoint adapter. */
export function buildResolvedReasoningProviderOptions(context: {
  aiSdkProviderId: AppProviderId
  providerOptionsKey: string
  endpointType: EndpointType | undefined
  reasoning: ResolvedReasoningInvocation
}): Record<string, Record<string, unknown>> {
  const encoded = encodeReasoningOptions(context.providerOptionsKey, context.reasoning)
  const options = shouldNormalizeOpenAICompatibleReasoning(context.aiSdkProviderId, context.endpointType)
    ? normalizeOpenAICompatibleParams(encoded.options)
    : encoded.options
  if (Object.keys(options).length === 0) return {}

  return {
    [encoded.providerId]: {
      ...options,
      ...(context.endpointType === ENDPOINT_TYPE.OPENAI_RESPONSES &&
        encoded.providerId === 'openai' && { forceReasoning: true })
    }
  }
}

/**
 * For OpenAI-compatible adapter families, rename `reasoning_effort` → `reasoningEffort` —
 * AI SDK silently drops the snake_case form.
 *
 * Covers `'openai-compatible'` (custom OpenAI-compatible providers, see #11987) — it speaks the
 * OpenAI Chat Completions dialect and silently drops snake_case reasoning keys.
 */
function normalizeOpenAICompatibleParams(params: Record<string, any>): Record<string, any> {
  if (!('reasoning_effort' in params)) return params

  const normalized = { ...params }
  if (!('reasoningEffort' in normalized)) normalized.reasoningEffort = normalized.reasoning_effort
  delete normalized.reasoning_effort
  return normalized
}
