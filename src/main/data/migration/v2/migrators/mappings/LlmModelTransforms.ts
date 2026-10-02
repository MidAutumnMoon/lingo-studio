import { loggerService } from '@logger'

import { legacyChatModelToUniqueId, type LegacyModelRef } from '../transformers/ModelTransformers'
import type { TransformResult } from './ComplexPreferenceMappings'

const logger = loggerService.withContext('LlmModelTransforms')

function describeLegacyModelRef(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return { valueType: typeof value }
  }

  const { id, provider } = value as { id?: unknown; provider?: unknown }
  return {
    valueType: 'object',
    id: typeof id === 'string' ? id : undefined,
    provider: typeof provider === 'string' ? provider : undefined
  }
}

function resolveChatModelPreference(preferenceKey: string, value: unknown): string | null {
  const modelId = legacyChatModelToUniqueId(value as LegacyModelRef | null | undefined)
  if (modelId) {
    return modelId
  }

  if (value != null) {
    // No bundled default model exists to fall back to: an unresolvable legacy
    // reference migrates to null (no default model) and onboarding asks the user.
    logger.warn('Legacy model preference could not be parsed; migrating to no default model', {
      preferenceKey,
      ...describeLegacyModelRef(value)
    })
  }

  return null
}

/**
 * Transform legacy LLM Model objects into UniqueModelId preference values.
 *
 * Sources: llm.defaultModel, llm.translateModel
 * Targets: chat.default_model_id, feature.translate.model_id
 * (the legacy quickModel had no surviving feature and is not migrated)
 */
export function transformLlmModelIds(sources: Record<string, unknown>): TransformResult {
  return {
    'chat.default_model_id': resolveChatModelPreference('chat.default_model_id', sources.defaultModel),
    'feature.translate.model_id': resolveChatModelPreference('feature.translate.model_id', sources.translateModel)
  }
}
