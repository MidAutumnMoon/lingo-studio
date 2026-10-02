import { dataApiService } from '@data/DataApiService'
import { preferenceService } from '@data/PreferenceService'
import type { Model, UniqueModelId } from '@shared/data/types/model'

/**
 * Async resolver for the user's chosen default model.
 *
 * Composition is split across two stores:
 *   - id lives in Preference (`chat.default_model_id`)
 *   - shape lives in DataApi (`/models/:uniqueId`)
 *
 * For React contexts use the {@link useDefaultModel} hook; this exists for
 * non-React callers (services, utils) that need a one-shot read.
 */
export async function readDefaultModel(): Promise<Model | undefined> {
  const id = (await preferenceService.get('chat.default_model_id')) as UniqueModelId | undefined
  if (!id) return undefined
  return (await dataApiService.get(`/models/${id}`)) ?? undefined
}

export async function readTranslateModel(): Promise<Model | undefined> {
  const id = ((await preferenceService.get('feature.translate.model_id')) ??
    (await preferenceService.get('chat.default_model_id'))) as UniqueModelId | undefined
  if (!id) return undefined
  return (await dataApiService.get(`/models/${id}`)) ?? undefined
}

/**
 * The conversation-naming model (`feature.topic_naming.model_id`) — the same
 * selection TopicNamingService uses for auto naming. Deliberately NO fallback to
 * the chat default (owner decision: naming is an explicit setting, skip when
 * unset). A configured id whose row no longer exists resolves to undefined
 * instead of throwing, so callers render their friendly "not exists" message.
 */
export async function readNamingModel(): Promise<Model | undefined> {
  const id = (await preferenceService.get('feature.topic_naming.model_id')) as UniqueModelId | undefined
  if (!id) return undefined
  try {
    return (await dataApiService.get(`/models/${id}`)) ?? undefined
  } catch {
    return undefined
  }
}
