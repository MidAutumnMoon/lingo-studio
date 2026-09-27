/**
 * The engine-agnostic chat-turn plan (pi unification W6): everything BOTH chat
 * engines resolve identically before their shapes diverge — retained context,
 * context settings, tool selection, web-tool routing, reasoning selection, the
 * tool-call limit, and the offload-eligibility inputs.
 *
 * Extracted from `runtime/aiSdk/params/buildAgentParams.ts`, which now consumes
 * it and keeps only the AI-SDK-shaped tail (sdk config, capabilities, feature
 * plugins, agent options). The pi chat seam (`runtime/piChat/chatTurnSeam.ts`)
 * consumes the same plan, so the two engines cannot drift on any of these
 * resolutions. Lives at the `ai/` root next to its caller `AiService` because
 * it belongs to neither engine's directory.
 */
import type { UIMessage } from 'ai'

import { application } from '@application'
import { projectRuntimeReasoning, providerRegistryService } from '@data/services/ProviderRegistryService'
import { loggerService } from '@logger'
import { hasAnchorRow } from '@main/ai/contextBuild/anchorRow'
import type { CompressionModelDescriptor } from '@main/ai/contextBuild/resolveCompressionModel'
import { resolveRequestedMaxOutputTokens } from '@main/ai/contextBuild/resolveOutputReservation'
import { resolveRequestContextSettings } from '@main/ai/contextBuild/resolveRequestContextSettings'
import { resolveKnowledgeBaseScope } from '@main/ai/utils/knowledgeScope'
import { getProviderById, getProviderForCapability, isPermanentWebSearchConfigError } from '@main/services/webSearch'
import {
  FS_READ_TOOL_NAME,
  KB_READ_TOOL_NAME,
  KB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME
} from '@shared/ai/builtinTools'
import type { WebSearchCapability } from '@shared/data/preference/preferenceTypes'
import type { Assistant } from '@shared/data/types/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import type { EffectiveContextSettings } from '@shared/data/types/contextSettings'
import { ENDPOINT_TYPE, type EndpointType, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type { ReasoningEffortOption } from '@shared/types/aiSdk'
import { isFunctionCallingModel } from '@shared/utils/model'
import { finalizeWebToolRoutes, resolveWebToolRoutes, type WebToolRoutes } from '@shared/utils/provider'
import { getWebSearchFallbackProviderIds, resolveReadyWebSearchProvider } from '@shared/utils/webSearch'

import type { FileAttachmentRef } from './messages/attachmentTypes'
import { collectRetainedContext, type RetainedContext } from './messages/retainedContext'
import { resolveEffectiveEndpoint } from './provider/endpoint'
import { syncMcpToolsToRegistry } from './tools/adapters/aiSdk/mcp/mcpTools'
import {
  resolveAssistantMcpToolIds,
  resolveMcpResourceServers
} from './tools/adapters/aiSdk/mcp/resolveAssistantMcpTools'
import { registry } from './tools/adapters/aiSdk/registry'
import type { ToolEntry } from './tools/adapters/aiSdk/types'
import { resolveConfiguredPaintingModel } from './tools/painting'
import type { AiChatRequest } from './types'
import { filterStandardParams } from './utils/modelParameters'
import { extractAiSdkStandardParams } from './utils/options'
import { getCustomParameters } from './utils/reasoning'
import {
  normalizeRequestedSelection,
  resolveReasoningInvocation,
  type ResolvedReasoningInvocation
} from './utils/reasoningSerializers'

const logger = loggerService.withContext('chatTurnPlan')

const NO_WEB_TOOL_ROUTES: WebToolRoutes = { webSearch: 'none', webFetch: 'none' }

/** First-party lookup tools carrying the citation-id contract (citations prompt gate). */
export const CITABLE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  KB_SEARCH_TOOL_NAME,
  KB_READ_TOOL_NAME
])

export type ChatTurnPlanRequest = AiChatRequest & {
  messageId?: string
  messages?: UIMessage[]
  /** Raw-path surviving context from the chat provider (see AiStreamRequest.retainedContext). */
  retainedContext?: RetainedContext
}

export interface ChatTurnPlanInput {
  request: ChatTurnPlanRequest
  provider: Provider
  model: Model
  assistant?: Assistant
  /**
   * The request's runtime provider id: legacy passes `sdkConfig.providerId`, the pi seam passes
   * `resolveAiSdkProviderId(provider, endpointType)`. Only the `google-vertex-maas` reasoning
   * endpoint remap reads it (and vertex is pi-excluded, so the two agree wherever pi runs).
   */
  runtimeProviderId: string
  /**
   * The endpoint the SERVING engine will actually use. The pi seam passes pi's preference
   * (`piPreferredEndpointType` — dual-protocol models ride anthropic-messages); legacy
   * leaves it unset (`endpointTypes[0]`). The plan's reasoning profile, effort normalization
   * and output-cap resolution are endpoint-keyed, so this must describe the real wire.
   */
  preferredEndpoint?: EndpointType
}

export interface ChatTurnPlan {
  endpointType: EndpointType | undefined
  retained: RetainedContext
  fileAttachments: FileAttachmentRef[]
  hasFileAttachments: boolean
  hasPersistedOutputs: boolean
  contextSettings: EffectiveContextSettings
  /** Legacy-only consumer (in-loop compaction); resolved with the context settings, so shared. */
  compressionModel: CompressionModelDescriptor | null
  toolCallLimit: number
  /** The four-part legacy offload gate — fs_read admission and marker minting eligibility. */
  canOffloadToolOutputs: boolean
  knowledgeBaseIds: readonly string[]
  /** Whether the model supports native function calling at all — false ⇒ no tool selection. */
  canConsumeTools: boolean
  mcpToolIds: ReadonlySet<string>
  mcpResourceServerIds: ReadonlySet<string>
  /** Finalized routing — the `webSearch !== 'none'` flag feeds the system prompt's date anchor. */
  webToolRoutes: WebToolRoutes
  /** Registry selection AFTER the lone-fs_read drop; registry entries only (client tools are engine business). */
  selectedEntries: readonly ToolEntry[]
  hasCitableTools: boolean
  requestedSelection: ReasoningEffortOption
  hasExplicitReasoningEffort: boolean
  reasoningInvocation: ResolvedReasoningInvocation
  /** The resolved wire profile — the legacy scope exposes it to reasoning features. */
  reasoningProfile: ReturnType<typeof providerRegistryService.resolveReasoningProfile>
  requestedMaxOutputTokens: number | undefined
  /** Assistant custom params split standard/provider (already capability-filtered) — legacy options input. */
  customParameters: ReturnType<typeof extractAiSdkStandardParams>
}

/** Mirrors the AI SDK / `ToolLoopAgent` default step cap (`stepCountIs(20)`): the assistant-less
 *  bound. With an assistant, its `maxToolCalls` setting (default 100) wins — unless capped off. */
const SDK_DEFAULT_STEP_COUNT = 20
const MIN_TOOL_CALLS = 1
const MAX_TOOL_CALLS = 1000

/** The turn's tool-call bound — one policy for both engines (W5 made it a required engine input). */
export function resolveToolCallLimit(assistant: Assistant | undefined): number {
  if (!assistant) return SDK_DEFAULT_STEP_COUNT

  const enableMaxToolCalls = assistant.settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls
  if (!enableMaxToolCalls) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }
  const raw = assistant.settings?.maxToolCalls
  const valid = raw !== undefined && raw >= MIN_TOOL_CALLS && raw <= MAX_TOOL_CALLS
  return valid ? raw : DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
}

export async function resolveChatTurnPlan(input: ChatTurnPlanInput): Promise<ChatTurnPlan> {
  const { request, provider, model, assistant, runtimeProviderId } = input

  const resolvedEndpoint = resolveEffectiveEndpoint(provider, model, input.preferredEndpoint)
  const endpointType = resolvedEndpoint.endpointType

  // Prefer the request-carried retained context: the persistent chat provider
  // computes it from the RAW message path, so attachments and persisted tool
  // outputs folded away by durable compaction stay readable via read_file /
  // fs_read. Scanning `messages` only sees the served (post-fold) view — the
  // fallback is for providers that never fold (temporary chat, agent).
  const retained = request.retainedContext ?? collectRetainedContext(request.messages ?? [])
  const fileAttachments = retained.fileAttachments
  const hasFileAttachments = fileAttachments.length > 0
  const hasPersistedOutputs = retained.persistedOutputPaths.size > 0

  const { contextSettings, compressionModel } = await resolveRequestContextSettings(
    model,
    request.conversation,
    assistant?.settings.contextSettings
  )
  const toolCallLimit = resolveToolCallLimit(assistant)
  // A marker minted on the last permitted tool step can never be read back —
  // the producing tool consumes that step and the loop ends.
  const canOffloadToolOutputs =
    contextSettings.enabled && request.contextOwner !== 'caller' && hasAnchorRow(request.messageId) && toolCallLimit > 1

  const knowledgeBaseIds = resolveKnowledgeBaseScope(assistant?.knowledgeBaseIds, request.knowledgeBaseIds)
  const hasClientTools = Object.keys(request.callOverrides?.tools ?? {}).length > 0

  const canConsumeTools = isFunctionCallingModel(model)
  const signals = canConsumeTools ? await resolveRequestToolSignals(request, assistant) : undefined
  const mcpToolIds = signals?.mcpToolIds ?? new Set<string>()
  const mcpResourceServerIds = signals?.mcpResourceServerIds ?? new Set<string>()

  const webToolRoutes = await resolveRequestWebToolRoutes(model, provider, assistant, {
    endpointType,
    hasFunctionToolSignals: Boolean(
      signals &&
      (signals.browserEnabled === true ||
        signals.mcpToolIds.size > 0 ||
        // Same `applies` gate the mcp_resource_* tools use, so a resource-only assistant is not
        // mistaken for a request that loads no function tool.
        signals.mcpResourceServerIds.size > 0 ||
        // Mirrors the KB tools' own `applies`: owning a base is not enough, this request must also
        // scope one. ORing the two made every user with any KB look like a function-tool conflict,
        // which withheld the server web-search route on Gemini 2.5 for requests that load no tool.
        (signals.hasAnyKnowledgeBase && knowledgeBaseIds.length > 0) ||
        hasFileAttachments ||
        hasClientTools ||
        assistant?.settings.enableGenerateImage === true)
    ),
    reasoningEffort: request.reasoningEffort ?? assistant?.settings.reasoning_effort
  })

  const selectedEntries = canConsumeTools
    ? await selectRegistryTools({
        assistant,
        signals,
        mcpToolIds,
        mcpResourceServerIds,
        hasFileAttachments,
        hasPersistedOutputs,
        canOffloadToolOutputs,
        knowledgeBaseIds,
        hasClientTools,
        webToolRoutes
      })
    : []
  const finalWebToolRoutes = finalizeWebToolRoutes(
    webToolRoutes,
    model,
    provider,
    selectedEntries.length > 0 || hasClientTools
  )
  const hasCitableTools = hasCitableSelection(selectedEntries, new Set())

  const customParameters = extractAiSdkStandardParams(assistant ? getCustomParameters(assistant) : {})
  customParameters.standardParams = filterStandardParams(customParameters.standardParams, model)
  const requestedMaxOutputTokens = resolveRequestedMaxOutputTokens(
    request.callOverrides?.maxOutputTokens,
    customParameters.standardParams.maxOutputTokens,
    assistant,
    model,
    endpointType
  )
  const requestedReasoningSelection = request.reasoningEffort ?? assistant?.settings.reasoning_effort ?? 'default'
  const reasoningProfile = providerRegistryService.resolveReasoningProfile(
    provider,
    model,
    runtimeProviderId === 'google-vertex-maas' ? ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS : endpointType
  )
  const invocationModel = reasoningProfile.support
    ? { ...model, reasoning: projectRuntimeReasoning(reasoningProfile.support, reasoningProfile.wire) }
    : model
  const selection = normalizeRequestedSelection(requestedReasoningSelection, invocationModel)
  const reasoningInvocation = resolveReasoningInvocation({
    selection,
    model: invocationModel,
    profile: reasoningProfile.wire,
    maxTokens: requestedMaxOutputTokens ?? model.maxOutputTokens,
    assistantSummary: assistant?.settings.reasoning_summary
  })

  return {
    endpointType,
    retained,
    fileAttachments,
    hasFileAttachments,
    hasPersistedOutputs,
    contextSettings,
    compressionModel,
    toolCallLimit,
    canOffloadToolOutputs,
    knowledgeBaseIds,
    canConsumeTools,
    mcpToolIds,
    mcpResourceServerIds,
    webToolRoutes: finalWebToolRoutes,
    selectedEntries,
    hasCitableTools,
    requestedSelection: selection,
    hasExplicitReasoningEffort: request.reasoningEffort !== undefined,
    reasoningInvocation,
    reasoningProfile,
    requestedMaxOutputTokens,
    customParameters
  }
}

/** The citable-selection predicate shared with the legacy tail (which subtracts client tool names). */
export function hasCitableSelection(entries: readonly ToolEntry[], clientToolNames: ReadonlySet<string>): boolean {
  return entries.some((entry) => CITABLE_BUILTIN_TOOL_NAMES.has(entry.name) && !clientToolNames.has(entry.name))
}

interface SelectTurnToolsInput {
  assistant: Assistant | undefined
  signals: Awaited<ReturnType<typeof resolveRequestToolSignals>> | undefined
  mcpToolIds: ReadonlySet<string>
  mcpResourceServerIds: ReadonlySet<string>
  hasFileAttachments: boolean
  hasPersistedOutputs: boolean
  canOffloadToolOutputs: boolean
  knowledgeBaseIds: readonly string[]
  hasClientTools: boolean
  webToolRoutes: WebToolRoutes
}

/** Registry selection via `applies` predicates (the legacy `resolveTools` core, engine-shared). */
export async function selectRegistryTools(input: SelectTurnToolsInput): Promise<readonly ToolEntry[]> {
  const { assistant, signals, mcpToolIds, webToolRoutes } = input
  if (mcpToolIds.size) {
    // Reconcile selected tool ids against every active server's cache-only catalog,
    // resolving ownership by exact id without MCP network round trips.
    await syncMcpToolsToRegistry(undefined, { selectedToolIds: mcpToolIds })
  }

  const paintingModel = resolveConfiguredPaintingModel()
  const selected = registry.selectActive({
    assistant,
    paintingModel: paintingModel ?? undefined,
    browserEnabled: signals?.browserEnabled,
    mcpToolIds,
    mcpResourceServerIds: input.mcpResourceServerIds,
    hasFileAttachments: input.hasFileAttachments,
    hasPersistedOutputs: input.hasPersistedOutputs,
    canOffloadToolOutputs: input.canOffloadToolOutputs,
    hasAnyKnowledgeBase: signals?.hasAnyKnowledgeBase ?? false,
    knowledgeBaseIds: input.knowledgeBaseIds,
    webToolRoutes
  })
  // A lone fs_read has nothing to read back: no other tool can produce an
  // offloadable output mid-loop (#18084).
  if (
    !input.hasPersistedOutputs &&
    !input.hasClientTools &&
    selected.length === 1 &&
    selected[0].name === FS_READ_TOOL_NAME
  ) {
    return []
  }
  return selected
}

export async function resolveRequestToolSignals(
  request: ChatTurnPlanInput['request'],
  assistant: Assistant | undefined
): Promise<{
  mcpToolIds: ReadonlySet<string>
  mcpResourceServerIds: ReadonlySet<string>
  hasAnyKnowledgeBase: boolean
  browserEnabled?: boolean
}> {
  let mcpIdList = request.mcpToolIds
  if (!mcpIdList && request.assistantId) {
    mcpIdList = await resolveAssistantMcpToolIds(request.assistantId)
  }
  return {
    mcpToolIds: new Set(mcpIdList ?? []),
    mcpResourceServerIds: new Set(resolveMcpResourceServers(assistant).map((server) => server.id)),
    browserEnabled: Boolean(
      request.conversation.topicId &&
      assistant &&
      assistant.settings.enableBrowser !== false &&
      application.get('PreferenceService').get('app.browser.agent_control.enabled')
    ),
    hasAnyKnowledgeBase: resolveHasAnyKnowledgeBase()
  }
}

async function resolveRequestWebToolRoutes(
  model: Model,
  provider: Provider,
  assistant: Assistant | undefined,
  requestContext: {
    endpointType: EndpointType | undefined
    hasFunctionToolSignals: boolean
    reasoningEffort: string | undefined
  }
): Promise<WebToolRoutes> {
  if (!assistant) return NO_WEB_TOOL_ROUTES

  const preferenceService = application.get('PreferenceService')
  const clientWebToolsEnabled = assistant.settings.enableWebSearch === true
  const [clientSearchAvailable, clientFetchAvailable] = clientWebToolsEnabled
    ? await Promise.all([
        resolveClientWebCapabilityAvailability('searchKeywords'),
        resolveClientWebCapabilityAvailability('fetchUrls')
      ])
    : [false, false]
  const modelToolsPreferred = preferenceService.get('chat.web_search.model_tools_preferred')

  return resolveWebToolRoutes(model, provider, {
    webSearchEnabled: clientWebToolsEnabled,
    clientSearchAvailable,
    clientFetchAvailable,
    modelToolsPreferred,
    endpointType: requestContext.endpointType,
    hasFunctionToolSignals: requestContext.hasFunctionToolSignals,
    reasoningEffort: requestContext.reasoningEffort
  })

  async function resolveClientWebCapabilityAvailability(capability: WebSearchCapability): Promise<boolean> {
    try {
      const clientProvider = await getProviderForCapability(undefined, capability, preferenceService)
      const fallbackProviders = await Promise.all(
        getWebSearchFallbackProviderIds(clientProvider.id, capability).map((providerId) =>
          getProviderById(providerId, preferenceService)
        )
      )

      return Boolean(resolveReadyWebSearchProvider([clientProvider, ...fallbackProviders], clientProvider, capability))
    } catch (error) {
      if (!isPermanentWebSearchConfigError(error)) {
        logger.warn(`Failed to resolve the client ${capability} provider; falling back to the server tool`, { error })
      }
      return false
    }
  }
}

/**
 * Whether the user has any knowledge base, used to gate the `kb_*` tools in `selectActive`. Fail-open:
 * a transient count error must not suppress the KB tools for users who do have bases (the tools
 * themselves steer gracefully when a lookup fails), so an error is treated as "present".
 */
function resolveHasAnyKnowledgeBase(): boolean {
  try {
    return application.get('KnowledgeService').hasAnyBase()
  } catch (error) {
    logger.warn('Failed to check for knowledge bases during tool resolution; treating as present', { error })
    return true
  }
}
