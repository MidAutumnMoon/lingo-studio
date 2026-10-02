/**
 * Resolve a Cherry `UniqueModelId` into the pi provider/model configuration a
 * pi `AgentSession` needs. Cherry owns the model + API key; this module maps
 * Cherry's provider/model/endpoint data onto pi's `registerProvider` shape.
 *
 * Key ownership (plan D1): the raw Cherry API key is returned SEPARATELY and
 * never placed in the `registerProvider` config — the config carries only a
 * non-secret placeholder so keys that start with `$`/`!` never hit pi's config
 * interpolation semantics. The driver injects the real key at runtime via
 * `ModelRuntime.setRuntimeApiKey(providerName, apiKey)`.
 */

import type { ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

import { application } from '@application'
import type { AiUsageCredentialReceipt } from '@data/services/AiUsageRecordService'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { customFetch } from '@main/ai/utils/customFetch'
import { getExtraHeaders } from '@main/ai/utils/provider'
import { createAiUsagePricingSnapshot } from '@main/ai/utils/usageCapture'
import { CHERRY_NODE_PROXY_RULES_ENV, getProxyEnvironment, proxyUrlHasCredentials } from '@main/services/proxy/proxyEnv'
import { mapEndpointToPiApi, type PiApi } from '@shared/ai/piModelCompatibility'
import { isCodexProviderId } from '@shared/data/presets/codex'
import { hasRuntimeTransportAdapter } from '@shared/data/presets/runtimeTransport'
import {
  ENDPOINT_TYPE,
  type EndpointType,
  MODALITY,
  type Model,
  MODEL_CAPABILITY,
  parseUniqueModelId,
  type UniqueModelId
} from '@shared/data/types/model'
import type { ApiKeyEntry, Provider } from '@shared/data/types/provider'
import { formatApiHost, withoutTrailingApiVersion } from '@shared/utils/api'
import { getRawModelId, isQwenModel } from '@shared/utils/model'
import {
  isLoginBasedProvider,
  isSupportEnableThinkingProvider,
  matchesPreset,
  resolveEndpointDialect
} from '@shared/utils/provider'
import { SystemProviderIds } from '@shared/utils/systemProviderId'

import { resolveEffectiveEndpoint } from '../../provider/endpoint'
import { getProviderTransportAdapter, type ProviderTransportAdapter } from '../../provider/runtimeTransport'
import { resolveAgentContextWindow } from '../agentContextWindow'
import { toAgentProviderHeaders } from '../agentProviderHeaders'
import type { AgentSessionUsageCapture } from '../types'
import { loadPiApiStreamSimple, PI_API_SUPPORTS_CUSTOM_FETCH } from './piSdk'
import { loadPiAiStreamFns, withTransportStream } from './piTransportStream'

/**
 * Non-secret placeholder written into the `registerProvider` config. pi
 * validates that a custom-model provider declares `apiKey` (or `oauth`), so we
 * satisfy it with this literal and supply the real key out-of-band.
 */
export const PI_PLACEHOLDER_API_KEY = 'cherry-managed-runtime-key'

// Pi uses maxTokens as a request output cap. Keep the existing conservative
// default when Cherry has no more specific output limit.
const DEFAULT_MAX_TOKENS = 8_192

/** Thrown when the selected model's provider has no pi `api` mapping (plan D2). */
export class PiUnsupportedProviderError extends Error {
  readonly providerId: string

  constructor(providerId: string) {
    super(`Provider "${providerId}" is not supported by pi agents: no compatible pi API family`)
    this.name = 'PiUnsupportedProviderError'
    this.providerId = providerId
  }
}

/** Thrown when Cherry has no usable API key for the selected pi provider. */
export class PiMissingApiKeyError extends Error {
  readonly providerId: string

  constructor(providerId: string) {
    super(`Provider "${providerId}" has no API key configured for pi agents`)
    this.name = 'PiMissingApiKeyError'
    this.providerId = providerId
  }
}

interface PiProviderInjectionBase {
  /** pi provider name to register + target with `setRuntimeApiKey`. Cherry's provider id. */
  providerName: string
  /** Resolved Pi wire family; duplicated from providerConfig because that SDK field is optional in its public type. */
  api: PiApi
  /** Config for `pi.registerProvider(providerName, config)`. `apiKey` is the placeholder. */
  providerConfig: ProviderConfig
  /** The real Cherry API key — inject via `ModelRuntime.setRuntimeApiKey`, never into the config. */
  apiKey: string
  /** The pi model id to select for the session (Cherry's `apiModelId`). */
  modelId: string
  /**
   * Present for app-managed-OAuth providers. When set, the connection wires a
   * `streamSimple` onto the pi provider config that fetches per-call OAuth creds
   * from this adapter; `apiKey` is then only the placeholder (no real app-side key).
   */
  transportAdapter?: ProviderTransportAdapter
  /** Provider-specific environment consumed by pi-ai's request implementation. */
  requestEnvironment?: Record<string, string>
}

/** Native/OAuth route whose invocations are accounted for by the Agent SDK. */
export interface PiDirectProviderInjection extends PiProviderInjectionBase {
  usageCapture: Extract<AgentSessionUsageCapture, { owner: 'agent-sdk' }>
}

export type PiProviderInjection = PiDirectProviderInjection

/**
 * Request-level stream options the host resolves per turn (assistant settings /
 * callOverrides). pi's session loop never sets these itself (verified against
 * pi-agent-core 0.87: no `maxTokens`/`temperature`/`samplingParams` references), and
 * 4 of 5 adapters gate the wire fields on `options` — not on the model config — so
 * without this injection the request-level values are wire-inert.
 */
export interface PiStreamRequestOptions {
  /**
   * The request-level output cap. Also patch the model entry's `maxTokens` (the seam
   * does): the anthropic adapter ceilings `options.maxTokens` at `model.maxTokens` and
   * adds its thinking budget on top, so config+options equal to the cap reproduce
   * legacy's total-cap semantics.
   */
  maxTokens?: number
  temperature?: number
  /** Wire-named extra sampling/body params (`top_p`, custom server params). Applied by the
   *  openai-compatible adapters only; other families ignore the field. */
  samplingParams?: Record<string, unknown>
}

/** Materialize provider-specific stream compatibility before the connection consumes it.
 *
 * The returned `streamSimple` is the COMPLETE transport for this injection: provider
 * compatibility wrappers, Cherry's request environment (proxy rules + Electron fetch),
 * the request-level stream options, and — when the provider config declares none — pi's
 * builtin api stream. Consumers must not wrap it again: one prepared artifact is what
 * keeps the agent connection and the pi chat engine on the same network path.
 */
export async function materializePiProviderStream(
  injection: PiProviderInjection,
  requestOptions?: PiStreamRequestOptions
): Promise<{
  providerConfig: ProviderConfig
  streamSimple: NonNullable<ProviderConfig['streamSimple']>
}> {
  const providerConfig = injection.transportAdapter
    ? withTransportStream(injection.providerConfig, injection.transportAdapter, await loadPiAiStreamFns())
    : injection.providerConfig
  const streamSimple = withStreamRequestOptions(
    withPiRequestEnvironment(
      providerConfig.streamSimple ?? (await loadPiApiStreamSimple(injection.api)),
      injection.requestEnvironment,
      injection.api
    ),
    requestOptions
  )
  return { providerConfig: { ...providerConfig, streamSimple }, streamSimple }
}

/**
 * Layer the host-resolved request options onto the prepared stream. Never overrides a
 * value the caller of `streamSimple` already set (pi's own retry/cache-warmer paths
 * re-issue with the same options, so injection must stay idempotent).
 */
function withStreamRequestOptions(
  streamSimple: NonNullable<ProviderConfig['streamSimple']>,
  requestOptions: PiStreamRequestOptions | undefined
): NonNullable<ProviderConfig['streamSimple']> {
  if (!requestOptions) return streamSimple
  return (model, context, options) => {
    const merged = {
      ...options,
      ...(requestOptions.maxTokens !== undefined && options?.maxTokens === undefined
        ? { maxTokens: requestOptions.maxTokens }
        : {}),
      ...(requestOptions.temperature !== undefined && options?.temperature === undefined
        ? { temperature: requestOptions.temperature }
        : {}),
      ...(requestOptions.samplingParams && {
        samplingParams: { ...requestOptions.samplingParams, ...options?.samplingParams }
      })
    }
    return streamSimple(model, context, merged)
  }
}

/**
 * Layer Cherry's request environment onto a provider stream: proxy rules from Cherry's
 * own config (undici does not read them by itself) and the Electron-aware `customFetch`
 * unless the proxy authenticates in the Node dispatcher, which `net.fetch` cannot do.
 *
 * The fetch half is per-family: see {@link PI_API_SUPPORTS_CUSTOM_FETCH} for the
 * Google exemption and the proxy parity gap it implies.
 */
function withPiRequestEnvironment(
  streamSimple: NonNullable<ProviderConfig['streamSimple']>,
  providerEnvironment: Record<string, string> | undefined,
  api: PiApi
): NonNullable<ProviderConfig['streamSimple']> {
  return (model, context, options) => {
    const proxyEnvironment = getProxyEnvironment(process.env)
    const usesAuthenticatedNodeProxy = proxyUrlHasCredentials(proxyEnvironment[CHERRY_NODE_PROXY_RULES_ENV])

    // Electron net.fetch cannot authenticate these proxies; retain NodeProxyBackend's credential-aware dispatcher.
    return streamSimple(model, context, {
      ...options,
      env: { ...options?.env, ...proxyEnvironment, ...providerEnvironment },
      ...(PI_API_SUPPORTS_CUSTOM_FETCH[api] && !usesAuthenticatedNodeProxy && { fetch: customFetch })
    })
  }
}

/**
 * The endpoint pi's own resolution prefers: a dual-protocol model (openai-completions AND
 * anthropic-messages declared) rides anthropic-messages. Exported so the chat seam can
 * resolve the shared turn plan against the SAME endpoint the injection will serve — the
 * plan's reasoning profile and output-cap resolution are endpoint-keyed, and a
 * `endpointTypes[0]` view silently diverges from the anthropic wire for those models.
 */
export function piPreferredEndpointType(model: Model): EndpointType | undefined {
  return model.endpointTypes?.includes(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS) &&
    model.endpointTypes.includes(ENDPOINT_TYPE.ANTHROPIC_MESSAGES)
    ? ENDPOINT_TYPE.ANTHROPIC_MESSAGES
    : undefined
}

function resolvePiEndpoint(provider: Provider, model: Model) {
  return resolveEffectiveEndpoint(provider, model, piPreferredEndpointType(model))
}

/**
 * Pure mapping: build the pi provider injection from an already-resolved Cherry
 * `Provider`, `Model`, and API key. Kept free of service/IO so it is unit
 * testable in isolation.
 *
 * @throws PiUnsupportedProviderError when the provider's endpoint has no pi mapping.
 */
export function buildPiProviderInjection(
  provider: Provider,
  model: Model,
  apiKey: string,
  credentialReceipt?: AiUsageCredentialReceipt
): PiDirectProviderInjection {
  // Unsupported-provider beats missing-key: a login-based provider (grok-cli,
  // CLI-login providers have no key by design, and "missing API key" would misdiagnose it.
  const resolvedEndpoint = resolvePiEndpoint(provider, model)
  const adapterFamily = resolvedEndpoint.endpointType
    ? provider.endpointConfigs?.[resolvedEndpoint.endpointType]?.adapterFamily
    : undefined
  const api =
    isLoginBasedProvider(provider) && !hasRuntimeTransportAdapter(provider.id)
      ? undefined
      : mapEndpointToPiApi(resolvedEndpoint.endpointType, adapterFamily)
  if (!api) {
    throw new PiUnsupportedProviderError(provider.id)
  }
  // Transport-adapter (app-managed-OAuth) providers authenticate per stream call
  // via the adapter; the connect-time `apiKey` is only the placeholder, so the
  // empty-key guard does not apply to them.
  const transportAdapter = getProviderTransportAdapter(provider.id)
  if (!transportAdapter && !apiKey.trim()) throw new PiMissingApiKeyError(provider.id)

  const baseUrl = isCodexProviderId(provider.id)
    ? formatApiHost(resolvedEndpoint.baseUrl, false)
    : formatPiBaseUrl(resolvedEndpoint.baseUrl, api)
  const modelId = getRawModelId(model)
  const modelConfig = buildPiModelConfig(provider, model, modelId, api, resolvedEndpoint.endpointType, baseUrl)

  const providerConfig: ProviderConfig = {
    name: provider.name,
    baseUrl,
    apiKey: PI_PLACEHOLDER_API_KEY,
    api,
    headers: toPiHeaders(getExtraHeaders(provider)),
    models: [modelConfig]
  }

  return {
    providerName: provider.id,
    api,
    providerConfig,
    apiKey,
    modelId,
    usageCapture: {
      owner: 'agent-sdk',
      credentialReceipt:
        credentialReceipt ?? (transportAdapter ? { attribution: 'auth', method: 'oauth' } : { attribution: 'unknown' }),
      providerId: provider.id,
      providerName: provider.name ?? null,
      source: null,
      frozenModels: [
        {
          modelId: model.id,
          apiModelId: modelId,
          modelName: model.name ?? model.id,
          aliases: [...new Set([model.id, modelId])],
          pricingSnapshot: createAiUsagePricingSnapshot(model.pricing)
        }
      ]
    },
    ...(transportAdapter ? { transportAdapter } : {}),
    ...(api === 'azure-openai-responses' && provider.settings?.apiVersion?.trim()
      ? { requestEnvironment: { AZURE_OPENAI_API_VERSION: provider.settings.apiVersion.trim() } }
      : {})
  }
}

/**
 * Cherry header values are literals, but pi resolves each one as a `$ENV` / `!command`
 * template — the same interpolation the `apiKey` placeholder dodges.
 */
function toPiHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const coerced = toAgentProviderHeaders(headers)
  if (!coerced) return undefined
  return Object.fromEntries(
    Object.entries(coerced).map(([name, value]) => [name, value.replaceAll('$', '$$$$').replace(/^!/, '$!')])
  )
}

function formatPiBaseUrl(baseUrl: string, api: PiApi): string {
  switch (api) {
    case 'openai-completions':
    case 'openai-responses':
      return formatApiHost(baseUrl)
    case 'google-generative-ai':
      return formatApiHost(baseUrl, true, 'v1beta')
    case 'anthropic-messages':
      // Anthropic's SDK appends `/v1/messages` itself; unlike the AI SDK adapter,
      // pi needs the gateway root rather than a versioned API prefix.
      return withoutTrailingApiVersion(formatApiHost(baseUrl, false))
    case 'azure-openai-responses':
      return formatApiHost(baseUrl, false)
  }
}

/**
 * Resolve a Cherry `UniqueModelId` into a pi provider injection, fetching the
 * provider, model, and rotated API key from Cherry's data services.
 *
 * @throws PiUnsupportedProviderError when the provider has no pi mapping.
 */
export async function resolvePiProviderInjection(uniqueModelId: UniqueModelId): Promise<PiDirectProviderInjection> {
  const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
  const provider = providerService.getByProviderId(providerId)
  const model = modelService.getByKey(providerId, modelId)

  return resolvePiProviderInjectionFromSnapshot(provider, model)
}

/** Select one credential for already-captured provider/model facts without re-reading either row. */
export function resolvePiProviderInjectionFromSnapshot(
  provider: Provider,
  model: Model,
  enabledApiKeys?: readonly ApiKeyEntry[]
): PiDirectProviderInjection {
  // Transport-adapter providers hold no app-side key: the real OAuth token is
  // fetched per stream call by the adapter. Skip the round-robin key rotation.
  if (getProviderTransportAdapter(provider.id)) {
    return buildPiProviderInjection(provider, model, PI_PLACEHOLDER_API_KEY)
  }

  const resolvedApiKey = providerService.resolveApiKey(provider.id)
  if (!resolvedApiKey.value.trim()) {
    // Keyless local servers (registry authOptional) need no credential; the
    // placeholder keeps the pi-side auth storage non-empty.
    if (provider.authOptional !== true) throw new PiMissingApiKeyError(provider.id)
    return buildPiProviderInjection(provider, model, PI_PLACEHOLDER_API_KEY)
  }
  if (enabledApiKeys && !enabledApiKeys.some((entry) => entry.key === resolvedApiKey.value)) {
    throw new Error(`Pi provider credentials changed during materialization: ${provider.id}`)
  }
  return buildPiProviderInjection(provider, model, resolvedApiKey.value, resolvedApiKey.apiKeySelection)
}

/** Resolve a session-bound Pi route. */
export async function resolvePiProviderInjectionForSession(
  sessionId: string,
  provider: Provider,
  model: Model,
  enabledApiKeys?: readonly ApiKeyEntry[]
): Promise<PiProviderInjection> {
  const injection = resolvePiProviderInjectionFromSnapshot(provider, model, enabledApiKeys)
  const headers = injection.providerConfig.headers
  if (
    matchesPreset(provider, SystemProviderIds.opencode) &&
    !Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'x-opencode-session')
  ) {
    injection.providerConfig.headers = { ...headers, ...toPiHeaders({ 'x-opencode-session': sessionId }) }
  }
  return injection
}

/**
 * Validate pi compatibility without consuming ProviderService's round-robin API
 * key rotation. Dispatch validation runs before every turn; selecting the key is
 * a connect-time concern only.
 */
export async function assertPiProviderUsable(uniqueModelId: UniqueModelId): Promise<void> {
  const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
  const provider = providerService.getByProviderId(providerId)
  const model = modelService.getByKey(providerId, modelId)

  // Unsupported beats missing-credential (parity with buildPiProviderInjection):
  // a login-based provider with no adapter has no key by design, and reporting
  // "missing API key" for it would misdiagnose an unsupported provider.
  const resolvedEndpoint = resolvePiEndpoint(provider, model)
  const adapterFamily = resolvedEndpoint.endpointType
    ? provider.endpointConfigs?.[resolvedEndpoint.endpointType]?.adapterFamily
    : undefined
  if (
    (isLoginBasedProvider(provider) && !hasRuntimeTransportAdapter(provider.id)) ||
    !mapEndpointToPiApi(resolvedEndpoint.endpointType, adapterFamily)
  ) {
    throw new PiUnsupportedProviderError(providerId)
  }
  // Transport-adapter providers validate the OAuth session (cheap `hasToken`),
  // not app-side keys; a signed-out provider is surfaced as a missing credential.
  if (getProviderTransportAdapter(providerId)) {
    const signedIn = await application.get('OAuthRuntimeService').hasToken(providerId)
    if (!signedIn) throw new PiMissingApiKeyError(providerId)
    return
  }

  const apiKeys = providerService.getApiKeys(providerId, { enabled: true })
  // Keyless local servers (registry authOptional) carry no credential at all.
  if (!apiKeys.some((entry) => entry.key.trim()) && provider.authOptional !== true) {
    throw new PiMissingApiKeyError(providerId)
  }
}

/** pi's thinking ladder. `off` is its name for Cherry's `none`; the rest share Cherry's spelling. */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/**
 * Project the model's declared efforts onto pi's ladder, marking the rest `null`.
 *
 * pi clamps its own default level (`medium`) against this map. Without one it assumes every level
 * below `xhigh` is available and sends `medium` verbatim — which strict endpoints reject for models
 * like Kimi K3, whose vocabulary is low/high/max (#20029). A model declaring no concrete tier gets
 * no map: its toggle is expressed by the wire, and an all-`null` ladder would disable thinking.
 */
function buildThinkingLevelMap(model: Model): ProviderModelConfig['thinkingLevelMap'] | undefined {
  const declared = model.reasoning?.selectableEfforts ?? []
  if (!declared.some((effort) => effort !== 'none' && effort !== 'auto')) return undefined

  const map: NonNullable<ProviderModelConfig['thinkingLevelMap']> = {}
  for (const level of PI_THINKING_LEVELS) {
    const effort = level === 'off' ? 'none' : level
    map[level] = declared.includes(effort) ? effort : null
  }
  return map
}

/**
 * Hosts/providers pi-ai's own openai-completions `detectCompat` (0.87.1) already maps to a
 * NON-'openai' reasoning dialect — deepseek's `reasoning_content` echo, zai, together,
 * ant-ling, openrouter. Where pi detected one, an explicit `thinkingFormat: 'qwen'` would
 * replace it; where it detected nothing (or plain `openai`), our override only adds
 * `enable_thinking`, which is exactly the legacy `qwenEnableThinking` plugin's reach.
 */
const PI_DETECTED_OPENAI_DIALECTS = [
  'deepseek.com',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.together.ai',
  'api.together.xyz',
  'api.ant-ling.com',
  'openrouter.ai'
] as const
const PI_DETECTED_OPENAI_DIALECT_PROVIDER_IDS = [
  'deepseek',
  'zai',
  'zai-coding-cn',
  'together',
  'ant-ling',
  'openrouter'
] as const

function piDetectsOwnDialect(provider: Provider, baseUrl: string): boolean {
  const host = baseUrl.toLowerCase()
  return (
    PI_DETECTED_OPENAI_DIALECT_PROVIDER_IDS.some((id) => id === provider.id) ||
    PI_DETECTED_OPENAI_DIALECTS.some((fragment) => host.includes(fragment))
  )
}

/**
 * Explicit compat overrides where pi-ai's URL/provider auto-detection cannot identify
 * the dialect. DashScope's compatible-mode host is one such case: its Qwen models speak
 * `enable_thinking` (the legacy `qwenEnableThinking` plugin's gate — `isQwenModel` on any
 * provider that is not in `NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS`), while its other
 * models ride the registry's openai-chat dialect. So the override is model-gated, not
 * provider-wide, and it yields to pi's own detection where that exists.
 */
function piDialectCompat(
  provider: Provider,
  model: Model,
  api: PiApi,
  baseUrl: string
): ProviderModelConfig['compat'] | undefined {
  if (api !== 'openai-completions' || !isQwenModel(model)) return undefined
  if (!isSupportEnableThinkingProvider(provider) || piDetectsOwnDialect(provider, baseUrl)) return undefined
  return { thinkingFormat: 'qwen' }
}

function buildPiModelConfig(
  provider: Provider,
  model: Model,
  id: string,
  api: PiApi,
  endpointType: EndpointType | undefined,
  baseUrl: string
): ProviderModelConfig {
  const input: ('text' | 'image')[] = ['text']
  const supportsImage =
    model.capabilities.includes(MODEL_CAPABILITY.IMAGE_RECOGNITION) ||
    (model.inputModalities?.includes(MODALITY.IMAGE) ?? false)
  if (supportsImage) {
    input.push('image')
  }
  const thinkingLevelMap = buildThinkingLevelMap(model)
  // Compat overrides stack: endpoint dialect first, then provider dialects —
  // all touch disjoint keys.
  const compat = {
    ...(api === 'openai-completions' || api === 'openai-responses'
      ? // Cherry's provider capability is the source of truth; pi otherwise infers
        // developer-role support from the endpoint URL.
        { supportsDeveloperRole: resolveEndpointDialect(provider, endpointType).developerRole }
      : {}),
    ...piDialectCompat(provider, model, api, baseUrl)
  }

  return {
    id,
    name: model.name,
    api,
    reasoning: model.capabilities.includes(MODEL_CAPABILITY.REASONING) || model.reasoning !== undefined,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input,
    // pi tracks per-token cost for its own UI; Cherry owns cost accounting, so
    // leave zeros — pi's tracking is unused here.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveAgentContextWindow(model),
    maxTokens: model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    ...(Object.keys(compat).length > 0 ? { compat } : {})
  }
}
