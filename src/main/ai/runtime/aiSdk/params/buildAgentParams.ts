import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { stepCountIs, type StopCondition, type ToolSet, type UIMessage } from 'ai'

import type { AiPlugin } from '@cherrystudio/ai-core'
import { providerRegistryService } from '@data/services/ProviderRegistryService'
import {
  hasCitableSelection,
  resolveChatTurnPlan,
  resolveRequestToolSignals,
  resolveToolCallLimit,
  selectRegistryTools
} from '@main/ai/chatTurnPlan'
import { mergeHeaders } from '@main/utils/http'
import type { CompactionSink } from '@shared/ai/compaction'
import type { Assistant } from '@shared/data/types/assistant'
import { ENDPOINT_TYPE, type EndpointType, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type { WebToolRoutes } from '@shared/utils/provider'

import type { FileAttachmentRef } from '../../../messages/attachmentTypes'
import type { RetainedContext } from '../../../messages/retainedContext'
import { applyHttpTrace } from '../../../observability'
import type { ServingCredentialReceipt } from '../../../provider/credential'
import { resolveAiSdkProviderId, resolveEffectiveEndpoint } from '../../../provider/endpoint'
import { resolveSdkConfig } from '../../../provider/sdkConfig'
import type { RequestContext } from '../../../tools/adapters/aiSdk/context'
import { applyDeferExposition } from '../../../tools/adapters/aiSdk/exposition/applyDeferExposition'
import { registry, ToolRegistry } from '../../../tools/adapters/aiSdk/registry'
import { createAiRepair } from '../../../tools/adapters/aiSdk/repair'
import type { ToolEntry } from '../../../tools/adapters/aiSdk/types'
import type { AiChatRequest, CallOverrides } from '../../../types'
import {
  adjustMaxOutputTokensForReasoning,
  filterStandardParams,
  getTemperature,
  getTopP
} from '../../../utils/modelParameters'
import type { extractAiSdkStandardParams } from '../../../utils/options'
import {
  applyFastModeToProviderOptions,
  applyServiceTierToProviderOptions,
  buildCapabilityProviderOptions,
  mergeCustomProviderParameters,
  resolveServiceTierWireValue
} from '../../../utils/options'
import { createToolCallLimitStopCondition } from '../loop/toolLoopTermination'
import type { AgentLoopHooks, AgentOptions } from '../loop/types'
import { assembleSystemPrompt } from './assembleSystemPrompt'
import { buildTelemetry } from './buildTelemetry'
import { resolveCapabilities } from './capabilities'
import { collectFromFeatures } from './collectFromFeatures'
import { createCustomParamsFetch, selectCustomBodyParameters } from './customParamsFetch'
import type { RequestFeature } from './feature'
import { INTERNAL_FEATURES } from './features/internalFeatures'
import { type NativeFileSupport, resolveNativeFileSupport } from './nativeFileSupport'
import type { RequestScope, SdkConfig } from './scope'

const NO_WEB_TOOL_ROUTES: WebToolRoutes = { webSearch: 'none', webFetch: 'none' }

export interface BuildAgentParamsInput {
  request: AiChatRequest & {
    messageId?: string
    messages?: UIMessage[]
    /** Raw-path surviving context from the chat provider (see AiStreamRequest.retainedContext). */
    retainedContext?: RetainedContext
  }
  signal: AbortSignal | undefined
  provider: Provider
  model: Model
  assistant?: Assistant
  /** Caller-supplied features merged after `INTERNAL_FEATURES`. */
  extraFeatures?: readonly RequestFeature[]
  /** Late-bound request usage middleware for nested tool-repair calls. */
  getRepairUsagePlugins?: () => AiPlugin[]
  /** Reports compaction progress to the UI; absent when there is no live stream. */
  compactionSink?: CompactionSink
}

export interface BuiltAgentParams {
  sdkConfig: SdkConfig
  /** Non-secret receipt for the credential path selected for this request. */
  credentialReceipt: ServingCredentialReceipt
  tools: ToolSet | undefined
  plugins: AiPlugin<any, any>[]
  system: string | undefined
  options: AgentOptions
  /** Hook contributions from features — caller composes with its own internal hooks. */
  hookParts: ReadonlyArray<Partial<AgentLoopHooks>>
  /** Attachment routing inputs for `prepareChatMessages` (chat path). */
  nativeFileSupport: NativeFileSupport
  fileAttachments: FileAttachmentRef[]
}

export async function buildAgentParams(input: BuildAgentParamsInput): Promise<BuiltAgentParams> {
  const { request, signal, provider, model, assistant, extraFeatures, compactionSink } = input

  const resolvedEndpoint = resolveEffectiveEndpoint(provider, model)
  const { sdkConfig, credentialReceipt } = await resolveSdkConfig(
    provider,
    model,
    resolvedEndpoint,
    request.apiKeyOverride
  )
  applyHttpTrace(sdkConfig.providerSettings, {
    topicId: request.conversation.topicId,
    modelName: model.name ?? model.id
  })

  // The engine-agnostic core (W6): retained context, context settings, tool
  // selection, web routing, reasoning, and the tool-call limit resolve once
  // here for BOTH chat engines — the pi seam consumes the same plan.
  const plan = await resolveChatTurnPlan({
    request,
    provider,
    model,
    assistant,
    runtimeProviderId: sdkConfig.providerId
  })

  const { endpointType } = resolvedEndpoint
  const aiSdkProviderId = resolveAiSdkProviderId(provider, endpointType)
  const serviceTierControl = providerRegistryService.resolveServiceTierControl(provider, model, endpointType)
  const capabilities = assistant
    ? resolveCapabilities(model, provider, {
        webToolRoutes: plan.webToolRoutes,
        runtimeProviderId: sdkConfig.providerId,
        serving: sdkConfig.providerSettings
      })
    : undefined
  const nativeFileSupport = resolveNativeFileSupport(provider, model, {
    endpointType,
    aiSdkProviderId,
    runtimeProviderId: sdkConfig.providerId
  })

  const { tools, deferredEntries, hasCitableTools } = await toExposedToolSet(
    plan.selectedEntries,
    request.callOverrides?.tools,
    model
  )

  const requestContext: RequestContext = {
    requestId: request.messageId ?? crypto.randomUUID(),
    topicId: request.conversation.topicId,
    assistant,
    abortSignal: signal,
    fileAttachments: plan.fileAttachments,
    knowledgeBaseIds: plan.knowledgeBaseIds,
    // fs_read's exact allow-list: blobs referenced by the conversation, plus
    // whatever the in-flight offload adapter appends mid-turn. Cloned so those
    // per-turn appends never contaminate the RetainedContext shared across the
    // models of a multi-model send.
    persistedOutputPaths: new Set(plan.retained.persistedOutputPaths),
    // Frozen with the tool set: `mcp_resource_*` may only ever narrow this at execution time.
    mcpResourceServerIds: plan.mcpResourceServerIds,
    toolOutputCharCap: plan.contextSettings.truncateThreshold
  }

  const scope: RequestScope = {
    request,
    signal,
    registry,
    assistant,
    model,
    provider,
    capabilities,
    sdkConfig,
    endpointType,
    aiSdkProviderId,
    reasoningProfile: plan.reasoningProfile,
    reasoning: plan.reasoningInvocation,
    serviceTierControl,
    requestContext,
    mcpToolIds: plan.mcpToolIds,
    mcpResourceServerIds: plan.mcpResourceServerIds,
    contextSettings: plan.contextSettings,
    compressionModel: plan.compressionModel,
    compactionSink,
    webToolRoutes: plan.webToolRoutes,
    hasFileAttachments: plan.hasFileAttachments,
    hasPersistedOutputs: plan.hasPersistedOutputs,
    canOffloadToolOutputs: plan.canOffloadToolOutputs,
    knowledgeBaseIds: plan.knowledgeBaseIds
  }

  const features = extraFeatures?.length ? [...INTERNAL_FEATURES, ...extraFeatures] : INTERNAL_FEATURES
  const contributions = collectFromFeatures(scope, features)

  const system = await assembleSystemPrompt({
    assistant,
    model,
    tools,
    deferredEntries,
    hasCitableTools,
    webSearchEnabled: plan.webToolRoutes.webSearch !== 'none'
  })
  const options = buildAgentOptions(
    scope,
    contributions.stopConditions,
    plan.customParameters,
    plan.requestedMaxOutputTokens,
    input.getRepairUsagePlugins
  )
  applyResponsesInstructions(options, system, endpointType, sdkConfig.providerOptionsKey)

  return {
    sdkConfig,
    credentialReceipt,
    tools,
    plugins: contributions.modelAdapters,
    system,
    options,
    hookParts: contributions.hookParts,
    nativeFileSupport,
    fileAttachments: plan.fileAttachments
  }
}

/**
 * OpenAI Responses API expects the system prompt in the top-level `instructions`
 * field. The AI SDK only turns `system` into an input message and leaves
 * `instructions` empty, which lets relay servers inject their own default system
 * prompt and override the user's. Mirror the assembled system prompt there for
 * Responses-endpoint models, unless the user already set it explicitly. (#16008)
 */
export function applyResponsesInstructions(
  options: AgentOptions,
  system: string | undefined,
  endpointType: EndpointType | undefined,
  providerOptionsKey: string
): void {
  if (!system || endpointType !== ENDPOINT_TYPE.OPENAI_RESPONSES) return
  const providerOptions = (options.providerOptions ??= {})
  const namespace = (providerOptions[providerOptionsKey] ??= {})
  if (namespace.instructions != null) return
  namespace.instructions = system
  // `instructions` does not displace the system input message; without this the
  // whole prompt ships twice.
  namespace.systemMessageMode = 'remove'
}

/**
 * The legacy ToolSet tail over a plan selection: client-tool merge, defer
 * exposition, and the citable flag. Selection itself lives in the shared plan
 * (`selectRegistryTools`), so this only shapes what the AI SDK consumes.
 */
async function toExposedToolSet(
  selectedEntries: readonly ToolEntry[],
  clientTools: CallOverrides['tools'],
  model: Model
): Promise<{ tools: ToolSet | undefined; deferredEntries: ToolEntry[]; hasCitableTools: boolean }> {
  // Client tools (no `execute`) from assistant-less callers; merged below so
  // they share the registry/defer-exposition path.
  const clientToolNames = new Set(Object.keys(clientTools ?? {}))
  let tools: ToolSet | undefined
  if (selectedEntries.length > 0) {
    tools = {}
    for (const entry of selectedEntries) tools[entry.name] = entry.tool
  }
  if (clientTools && Object.keys(clientTools).length > 0) {
    tools = {
      ...tools,
      ...clientTools
    }
  }
  // Meta-tools must see request-materialized entries rather than the process-wide static entries.
  const requestRegistry = new ToolRegistry()
  for (const entry of selectedEntries) requestRegistry.register(entry)
  const exposed = await applyDeferExposition(tools, requestRegistry, model.contextWindow)
  return {
    tools: exposed.tools,
    deferredEntries: exposed.deferredEntries,
    hasCitableTools: hasCitableSelection(selectedEntries, clientToolNames)
  }
}

/**
 * Tool selection: pick MCP ids (caller wins, else derived from assistant),
 * sync the MCP entries into the registry, then materialise the active
 * `ToolSet` via `applies` predicates and defer exposition.
 *
 * Retained as the standalone (test-facing) entry over the shared plan
 * selection; the main path consumes `resolveChatTurnPlan` directly.
 */
export async function resolveTools(
  request: BuildAgentParamsInput['request'],
  assistant: Assistant | undefined,
  model: Model,
  hasFileAttachments: boolean,
  knowledgeBaseIds: readonly string[],
  webToolRoutes: WebToolRoutes = NO_WEB_TOOL_ROUTES,
  signals?: Awaited<ReturnType<typeof resolveRequestToolSignals>>,
  hasPersistedOutputs: boolean = false,
  canOffloadToolOutputs: boolean = false
): Promise<{
  tools: ToolSet | undefined
  deferredEntries: ToolEntry[]
  hasCitableTools: boolean
  mcpToolIds: ReadonlySet<string>
  mcpResourceServerIds: ReadonlySet<string>
}> {
  const resolved = signals ?? (await resolveRequestToolSignals(request, assistant))
  const selected = await selectRegistryTools({
    assistant,
    signals: resolved,
    mcpToolIds: resolved.mcpToolIds,
    mcpResourceServerIds: resolved.mcpResourceServerIds,
    hasFileAttachments,
    hasPersistedOutputs,
    canOffloadToolOutputs,
    knowledgeBaseIds,
    hasClientTools: Object.keys(request.callOverrides?.tools ?? {}).length > 0,
    webToolRoutes
  })
  const exposed = await toExposedToolSet(selected, request.callOverrides?.tools, model)
  return {
    tools: exposed.tools,
    deferredEntries: exposed.deferredEntries,
    hasCitableTools: exposed.hasCitableTools,
    mcpToolIds: resolved.mcpToolIds,
    mcpResourceServerIds: resolved.mcpResourceServerIds
  }
}

/**
 * Assemble `AgentOptions`: capability-driven providerOptions overlaid with
 * the user's customParameters (split into AI-SDK standard params vs
 * provider-scoped params), per-call headers/maxRetries, stop-after-N-tools,
 * and the tool-call repair function.
 */
function buildAgentOptions(
  scope: RequestScope,
  featureStopConditions: StopCondition<ToolSet>[],
  customParameters: ReturnType<typeof extractAiSdkStandardParams>,
  requestedMaxOutputTokens: number | undefined,
  getRepairUsagePlugins?: () => AiPlugin[]
): AgentOptions {
  const {
    assistant,
    capabilities,
    model,
    provider,
    sdkConfig,
    requestContext,
    request,
    aiSdkProviderId,
    endpointType,
    reasoning,
    serviceTierControl
  } = scope

  // One path for both callers, so protocol/model defaults (store, safetySettings, num_ctx…)
  // can't diverge. Assistant-less callers (translate, prompt streams) carry no capabilities;
  // they opt into reasoning by setting `request.reasoningEffort` explicitly.
  let providerOptions = buildCapabilityProviderOptions(
    model,
    provider,
    {
      enableReasoning: capabilities ? capabilities.enableReasoning : request.reasoningEffort !== undefined,
      enableGenerateImage: capabilities?.enableGenerateImage ?? false,
      enableWebSearch: capabilities ? scope.webToolRoutes?.webSearch === 'server' : false
    },
    {
      aiSdkProviderId,
      runtimeProviderId: sdkConfig.providerId,
      providerOptionsKey: sdkConfig.providerOptionsKey,
      endpointType,
      reasoning
    }
  )
  let standardParams: Partial<Record<string, unknown>> = {}
  if (assistant) {
    const temperature = getTemperature(assistant.settings, model, reasoning)
    const topP = getTopP(assistant.settings, model, reasoning)
    standardParams = {
      ...(temperature !== undefined && { temperature }),
      ...(topP !== undefined && { topP }),
      ...customParameters.standardParams
    }

    if (Object.keys(customParameters.providerParams).length > 0) {
      const customBodyParams = selectCustomBodyParameters(customParameters.providerParams, providerOptions, provider.id)
      providerOptions = mergeCustomProviderParameters(
        providerOptions,
        customParameters.providerParams,
        provider.id,
        sdkConfig.providerId === 'google-vertex-maas' ? 'openai-compatible' : aiSdkProviderId
      )
      if (Object.keys(customBodyParams).length > 0) {
        sdkConfig.providerSettings.fetch = createCustomParamsFetch(
          sdkConfig.providerSettings.fetch ?? globalThis.fetch,
          customBodyParams
        )
      }
    }
  }

  if (serviceTierControl) {
    providerOptions = applyServiceTierToProviderOptions(
      providerOptions,
      sdkConfig.providerOptionsKey,
      serviceTierControl,
      request.serviceTier ?? assistant?.settings.service_tier
    )
    if (serviceTierControl.wire.delivery.type === 'request-body') {
      sdkConfig.providerSettings.fetch = createCustomParamsFetch(sdkConfig.providerSettings.fetch ?? globalThis.fetch, {
        [serviceTierControl.wire.delivery.key]: resolveServiceTierWireValue(
          serviceTierControl,
          request.serviceTier ?? assistant?.settings.service_tier
        )
      })
    }
  }

  // Highest-precedence per-request overrides (assistant-less callers, e.g. the API gateway).
  const callOverrides = request.callOverrides
  const overridden = applyCallOverrides({ standardParams, providerOptions }, callOverrides, model)
  standardParams = overridden.standardParams
  const effectiveProviderOptions = applyFastModeToProviderOptions(
    provider,
    model,
    overridden.providerOptions,
    request.fastMode === true
  )
  // A namespace that ended up empty carries nothing; emitting it would ship a bare
  // `providerOptions` for callers that opted into nothing.
  const hasProviderOptions = Object.values(effectiveProviderOptions).some((ns) => Object.keys(ns ?? {}).length > 0)
  const effectiveBudgetTokens = resolveEffectiveThinkingBudget(
    effectiveProviderOptions,
    sdkConfig.providerOptionsKey,
    reasoning.budgetTokens
  )
  const maxOutputTokens = adjustMaxOutputTokensForReasoning(requestedMaxOutputTokens, endpointType, {
    budgetTokens: effectiveBudgetTokens
  })
  if (maxOutputTokens !== undefined) {
    standardParams = { ...standardParams, maxOutputTokens }
  } else if ('maxOutputTokens' in standardParams) {
    standardParams = { ...standardParams }
    delete standardParams.maxOutputTokens
  }

  const { headers: callerHeaders, maxRetries } = request.requestOptions ?? {}
  // A provider that keys on the conversation declared the header; the caller's own headers win.
  const headers = sdkConfig.conversationHeader
    ? mergeHeaders({ [sdkConfig.conversationHeader]: request.conversation.id }, callerHeaders)
    : callerHeaders
  const toolCallLimit = resolveToolCallLimit(assistant)
  const baseStopWhen = createToolCallLimitStopCondition(toolCallLimit)
  const stopWhen = composeStopWhen(baseStopWhen, featureStopConditions)
  const telemetry = buildTelemetry(scope)

  return {
    maxRetries: maxRetries ?? 0,
    ...(stopWhen && { stopWhen }),
    ...(headers && { headers }),
    ...(callOverrides?.toolChoice && { toolChoice: callOverrides.toolChoice }),
    ...(hasProviderOptions && { providerOptions: effectiveProviderOptions }),
    ...(telemetry && { telemetry }),
    ...standardParams,
    context: requestContext,
    repairToolCall: createAiRepair({
      providerId: sdkConfig.providerId,
      providerSettings: sdkConfig.providerSettings,
      modelId: sdkConfig.modelId,
      headers,
      getUsagePlugins: getRepairUsagePlugins
    })
  }
}

function resolveEffectiveThinkingBudget(
  providerOptions: ProviderOptions,
  providerOptionsKey: string,
  fallbackBudgetTokens: number | undefined
): number | undefined {
  const thinking = providerOptions[providerOptionsKey]?.thinking
  if (thinking === undefined) return fallbackBudgetTokens
  if (thinking === null || typeof thinking !== 'object' || Array.isArray(thinking)) return undefined

  const thinkingOptions = thinking as Record<string, unknown>
  return thinkingOptions.type === 'enabled' && typeof thinkingOptions.budgetTokens === 'number'
    ? thinkingOptions.budgetTokens
    : undefined
}

/**
 * Merge per-request `callOverrides` (highest precedence) onto base sampling params +
 * providerOptions. Sampling passes through `filterStandardParams` for model-capability
 * gating (e.g. topK dropped for Gemini 3.x / Claude 4.7); providerOptions merge
 * per-provider so other providers' keys aren't clobbered. Exported for unit testing.
 */
export function applyCallOverrides(
  base: { standardParams: Partial<Record<string, unknown>>; providerOptions: ProviderOptions },
  callOverrides: CallOverrides | undefined,
  model: Model
): { standardParams: Partial<Record<string, unknown>>; providerOptions: ProviderOptions } {
  if (!callOverrides) return base

  const sampling: Partial<Record<string, unknown>> = {}
  if (callOverrides.temperature !== undefined) sampling.temperature = callOverrides.temperature
  if (callOverrides.maxOutputTokens !== undefined) sampling.maxOutputTokens = callOverrides.maxOutputTokens
  if (callOverrides.topP !== undefined) sampling.topP = callOverrides.topP
  if (callOverrides.topK !== undefined) sampling.topK = callOverrides.topK
  if (callOverrides.stopSequences !== undefined) sampling.stopSequences = callOverrides.stopSequences
  const standardParams = { ...base.standardParams, ...filterStandardParams(sampling, model) }

  let providerOptions = base.providerOptions
  if (callOverrides.providerOptions) {
    const merged: ProviderOptions = { ...providerOptions }
    for (const [pid, opts] of Object.entries(callOverrides.providerOptions)) {
      merged[pid] = { ...merged[pid], ...opts }
    }
    providerOptions = merged
  }
  return { standardParams, providerOptions }
}

/** Mirrors the AI SDK / `ToolLoopAgent` default step cap (`stepCountIs(20)`). Used as the fallback
 *  bound when a feature contributes a `stopWhen` but no assistant base supplies one — passing any
 *  explicit `stopWhen` otherwise suppresses the SDK default and leaves the tool loop uncapped. */
const SDK_DEFAULT_STEP_COUNT = 20
/**
 * OR the assistant's step cap with feature-contributed stop conditions. An explicit `stopWhen`
 * suppresses the loop's default `stepCountIs(20)`, so when a feature contributes a condition but no
 * assistant base supplies a cap, fall back to that default — otherwise an assistant-less tool loop
 * (e.g. a `chatId`-only steer-yield request) would run unbounded.
 */
export function composeStopWhen(
  baseStopWhen: StopCondition<ToolSet> | undefined,
  featureStopConditions: StopCondition<ToolSet>[]
): StopCondition<ToolSet> | StopCondition<ToolSet>[] | undefined {
  if (featureStopConditions.length === 0) return baseStopWhen
  const base = baseStopWhen ?? stepCountIs(SDK_DEFAULT_STEP_COUNT)
  return [base, ...featureStopConditions]
}
