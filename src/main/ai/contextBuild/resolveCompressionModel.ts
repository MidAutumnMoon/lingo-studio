/**
 * Resolve a Cherry-side compression-model selector (`<providerId>::<modelId>`
 * UniqueModelId) into the provider/model rows the pi one-shot lane
 * (`runtime/pi/piOneShot.ts`) builds its request from — the wire model id,
 * API family and session headers are the injection's concern, not this one.
 *
 * Returns `null` (never throws) on any failure — the compress feature treats
 * null as "compression off" so a misconfigured model never breaks the chat.
 */
import { loggerService } from '@logger'
import { modelService } from '@main/data/services/ModelService'
import { providerService } from '@main/data/services/ProviderService'
import type { Model } from '@shared/data/types/model'
import { isUniqueModelId, parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import type { ConversationRef } from '../types'
import { resolveContextWindow } from './resolveContextWindow'

const logger = loggerService.withContext('resolveCompressionModel')

/**
 * The compression model plus the window its OWN requests must fit.
 *
 * The two windows are genuinely different: chat-history trigger / keep budgets
 * belong to the request model, but the summarize call is issued against the
 * compressor, so its input+output budget must come from the compressor's
 * window. Chatting on a 128k model while compressing with an 8k one used to
 * hand the summarize call a 128k-derived budget and overflow it — durable then
 * fell back to un-compacted history, and in-loop failed the turn.
 *
 * `contextWindow` is `null` when the compressor row declares none.
 */
export interface CompressionModelDescriptor {
  readonly provider: Provider
  readonly model: Model
  readonly contextWindow: number | null
  /** Owning conversation — session-scoped providers (OpenCode) stamp it on the summarize request. */
  readonly conversationId: string
}

export async function resolveCompressionModel(
  modelIdRaw: string,
  conversation: ConversationRef
): Promise<CompressionModelDescriptor | null> {
  if (!modelIdRaw || !isUniqueModelId(modelIdRaw)) {
    logger.warn('compression modelId is not a valid UniqueModelId', { modelIdRaw })
    return null
  }

  const { providerId, modelId } = parseUniqueModelId(modelIdRaw)

  try {
    const provider = providerService.getByProviderId(providerId)
    const model = modelService.getByKey(providerId, modelId)
    return {
      provider,
      model,
      contextWindow: resolveContextWindow(model.contextWindow),
      conversationId: conversation.id
    }
  } catch (error) {
    logger.warn('compression provider/model lookup failed', {
      providerId,
      modelId,
      error: (error as Error).message
    })
    return null
  }
}
