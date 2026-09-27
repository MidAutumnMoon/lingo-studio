import type {
  AiUsageCaptureContext,
  AiUsageCredentialReceipt,
  MessageRef,
  SourceSnapshot
} from '@data/services/AiUsageRecordService'
import { type AiUsagePricingSnapshot, AiUsagePricingSnapshotSchema } from '@shared/data/types/aiUsageRecord'
import type { Currency, RuntimeModelPricing } from '@shared/data/types/model'

export interface CreateAiUsageCaptureContextInput {
  providerId: string
  providerName?: string | null
  modelId: string
  modelName?: string | null
  pricing?: RuntimeModelPricing | null
  pricingSnapshot?: AiUsagePricingSnapshot | null
  trustProviderReportedCost?: boolean
  reportedCostCurrency?: Currency | null
  credentialReceipt?: AiUsageCredentialReceipt
  source?: SourceSnapshot | null
  messageRef?: MessageRef | null
  capturedAt?: string
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function cloneAndFreeze<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value))
}

function pricingCurrency(pricing: RuntimeModelPricing): AiUsagePricingSnapshot['currency'] | undefined {
  const tokenRates = [
    pricing.input,
    pricing.output,
    pricing.cacheRead,
    pricing.cacheWrite,
    ...(pricing.inputTokenTiers ?? []).flatMap((tier) => [tier.input, tier.output, tier.cacheRead, tier.cacheWrite])
  ].filter((rate) => rate !== undefined)
  const explicitCurrencies = tokenRates
    .map((rate) => rate.currency)
    .filter((currency): currency is AiUsagePricingSnapshot['currency'] => currency !== undefined)
  if (explicitCurrencies.length === 0) return undefined
  if (explicitCurrencies.some((currency) => currency !== explicitCurrencies[0])) return undefined
  return explicitCurrencies[0]
}

export function createAiUsagePricingSnapshot(
  pricing: RuntimeModelPricing | null | undefined,
  capturedAt = new Date().toISOString()
): AiUsagePricingSnapshot | null {
  if (!pricing) return null
  const currency = pricingCurrency(pricing)
  if (!currency) return null

  const snapshot = {
    currency,
    ...(pricing.input?.perMillionTokens != null ? { inputPerMillionTokens: pricing.input.perMillionTokens } : {}),
    ...(pricing.output?.perMillionTokens != null ? { outputPerMillionTokens: pricing.output.perMillionTokens } : {}),
    ...(pricing.cacheRead?.perMillionTokens != null
      ? { cacheReadPerMillionTokens: pricing.cacheRead.perMillionTokens }
      : {}),
    ...(pricing.cacheWrite?.perMillionTokens != null
      ? { cacheWritePerMillionTokens: pricing.cacheWrite.perMillionTokens }
      : {}),
    ...(pricing.inputTokenTiers?.length
      ? {
          inputTokenTiers: pricing.inputTokenTiers.map((tier) => ({
            minInputTokens: tier.minInputTokens,
            ...(tier.input.perMillionTokens != null ? { inputPerMillionTokens: tier.input.perMillionTokens } : {}),
            ...(tier.output.perMillionTokens != null ? { outputPerMillionTokens: tier.output.perMillionTokens } : {}),
            ...(tier.cacheRead?.perMillionTokens != null
              ? { cacheReadPerMillionTokens: tier.cacheRead.perMillionTokens }
              : {}),
            ...(tier.cacheWrite?.perMillionTokens != null
              ? { cacheWritePerMillionTokens: tier.cacheWrite.perMillionTokens }
              : {})
          }))
        }
      : {}),
    ...(pricing.perImage
      ? {
          perImage: {
            price: pricing.perImage.price,
            unit: pricing.perImage.unit ?? 'image'
          }
        }
      : {}),
    capturedAt
  }
  const parsed = AiUsagePricingSnapshotSchema.safeParse(snapshot)
  return parsed.success ? cloneAndFreeze(parsed.data) : null
}

/**
 * Freeze every attribution input after provider/model/credential selection and
 * before the provider call. Record completion must never consult mutable
 * provider, model, source, or rotation state.
 */
export function createAiUsageCaptureContext(input: CreateAiUsageCaptureContextInput): AiUsageCaptureContext {
  return cloneAndFreeze({
    providerId: input.providerId,
    providerName: input.providerName ?? null,
    modelId: input.modelId,
    modelName: input.modelName ?? null,
    pricingSnapshot:
      input.pricingSnapshot === undefined
        ? createAiUsagePricingSnapshot(input.pricing, input.capturedAt)
        : input.pricingSnapshot === null
          ? null
          : (() => {
              const parsed = AiUsagePricingSnapshotSchema.safeParse(input.pricingSnapshot)
              return parsed.success ? cloneAndFreeze(parsed.data) : null
            })(),
    trustProviderReportedCost: input.trustProviderReportedCost === true,
    reportedCostCurrency: input.reportedCostCurrency ?? null,
    credentialReceipt: cloneAndFreeze(input.credentialReceipt ?? { attribution: 'unknown' }),
    source: input.source === undefined ? null : input.source === null ? null : cloneAndFreeze(input.source),
    messageRef:
      input.messageRef === undefined ? null : input.messageRef === null ? null : cloneAndFreeze(input.messageRef)
  })
}

/** The assistant-derived usage source snapshot (chat turns without an explicit request source). */
export function sourceSnapshotForAssistant(
  assistant:
    | {
        id: string
        name: string
        emoji?: string | null
      }
    | undefined
): SourceSnapshot | undefined {
  return assistant
    ? {
        type: 'assistant',
        id: assistant.id,
        name: assistant.name,
        icon: assistant.emoji ?? null
      }
    : undefined
}

/**
 * Usage attribution for one chat-turn request — ONE policy for both engines. Agent turns
 * win FIRST, `null` included: `usageContext` means "already decided", so a `??` would
 * attribute a deliberately-anonymous agent turn to some assistant. A plain chat turn
 * references its anchor message; anything else is anonymous.
 */
export function resolveUsageAttribution(
  request: {
    usageContext?: { source?: SourceSnapshot | null; assistantMessageId: string }
    source?: SourceSnapshot | null
    messageId?: string
  },
  assistant: Parameters<typeof sourceSnapshotForAssistant>[0]
): { source: SourceSnapshot | null; messageRef: MessageRef | null } {
  if (request.usageContext) {
    return {
      source: request.usageContext.source ?? null,
      messageRef: { kind: 'agent-session', id: request.usageContext.assistantMessageId }
    }
  }
  return {
    source: request.source ?? sourceSnapshotForAssistant(assistant) ?? null,
    messageRef: request.messageId ? { kind: 'chat', id: request.messageId } : null
  }
}

/**
 * Build a request's capture context from resolved provider/model facts — the shared
 * field mapping for the AI-SDK billing plugin and the pi chat engine's invocation
 * sink (W6: one mapping, both engines).
 */
export function createRequestCaptureContext(input: {
  provider: { id: string; name: string; reportsActualCost?: boolean; reportedCostCurrency?: Currency | null }
  model: { name?: string; pricing?: RuntimeModelPricing | null }
  sdkModelId: string
  credentialReceipt?: CreateAiUsageCaptureContextInput['credentialReceipt']
  source?: SourceSnapshot | null
  messageRef?: MessageRef | null
}): AiUsageCaptureContext {
  return createAiUsageCaptureContext({
    providerId: input.provider.id,
    providerName: input.provider.name,
    modelId: input.sdkModelId,
    modelName: input.model.name,
    pricing: input.model.pricing,
    trustProviderReportedCost: input.provider.reportsActualCost,
    reportedCostCurrency: input.provider.reportedCostCurrency,
    credentialReceipt: input.credentialReceipt,
    source: input.source,
    messageRef: input.messageRef
  })
}
