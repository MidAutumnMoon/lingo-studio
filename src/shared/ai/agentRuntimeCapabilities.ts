import { claudeUserFacingTools } from '@shared/ai/claudecode/toolRegistry'
import { DSH_BUILTIN_TOOLS } from '@shared/ai/dshBuiltinTools'
import { isDshCompatibleModel } from '@shared/ai/dshModelCompatibility'
import { PI_BUILTIN_TOOLS } from '@shared/ai/piBuiltinTools'
import { isPiCompatibleModel } from '@shared/ai/piModelCompatibility'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'
import { isManagedCherryAiDefaultModel } from '@shared/data/presets/cherryai'
import type { AgentType } from '@shared/data/types/agent'
import type { Model } from '@shared/data/types/model'
import { parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import type { SlashCommand } from './slashCommands'

export interface AgentRuntimeCapabilities {
  /** i18n key for runtime selector option. */
  labelKey: string
  labelFallback: string
  permissionModes: readonly AgentPermissionMode[]
  /** plan/small model fields. */
  modelTiers: boolean
  /** Heartbeat orchestration. */
  heartbeat: boolean
  knowledgeBases: boolean
  mcp: boolean
  skills: boolean
  slashCommands: readonly SlashCommand[]
  createDefaults: { permissionMode: AgentPermissionMode }
  /** Extra restriction on top of the base agent-friendly filter; null = none. `provider` is
   *  undefined for orphan models — each runtime decides fail-open vs fail-closed there. */
  isModelCompatible: ((provider: Provider | undefined, model: Model) => boolean) | null
  /** providerMetadata.cherry.transport tag stamped by the runtime's stream adapter. */
  transport: string
  /** Edit-dialog catalog rows. */
  builtinTools: () => readonly {
    id: string
    labelKey: string
    descriptionKey: string
    labelFallback?: string
    descriptionFallback?: string
    category: string
  }[]
}

const ALL_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'bypassPermissions'
] as const satisfies readonly AgentPermissionMode[]

const PI_BUILTIN_COMMANDS = [
  { command: '/compact', description: 'Compact conversation with optional focus instructions' }
] as const satisfies readonly SlashCommand[]

// dsh commands are client-dispatched (the runtime never parses slash text), so this is
// the set Cherry's composition mounts — dispatched over the bridge `command` frame.
const DSH_BUILTIN_COMMANDS = [
  { command: '/compact', description: 'Compact conversation history to free up context' },
  { command: '/goal', description: 'Set or manage the session goal: [<objective>|edit <objective>|pause|resume|clear]' }
] as const satisfies readonly SlashCommand[]

const dshCherryTools = () =>
  claudeUserFacingTools()
    .filter((tool) => tool.name.startsWith('mcp__'))
    .map((tool) => ({
      id: tool.name,
      labelKey: `agent.tools.builtin.${tool.key}.label`,
      descriptionKey: `agent.tools.builtin.${tool.key}.description`,
      labelFallback: tool.label,
      descriptionFallback: tool.description,
      category: tool.category
    }))

export const AGENT_RUNTIME_CAPABILITIES = {
  pi: {
    labelKey: 'library.config.agent.field.runtime.option.pi',
    labelFallback: 'Pi',
    // Pi has no plan mode. Its `auto` is Cherry's own rule-based gate in the pi approval extension,
    // not Claude's model-side classifier — same user-facing promise, different mechanism.
    permissionModes: ALL_PERMISSION_MODES.filter((mode) => mode !== 'plan'),
    modelTiers: false,
    heartbeat: true,
    knowledgeBases: true,
    // The complete session MCP set is bridged into approval-gated Pi custom tools.
    mcp: true,
    skills: true,
    slashCommands: PI_BUILTIN_COMMANDS,
    createDefaults: { permissionMode: 'auto' },
    // Orphan models are rejected (pre-descriptor behavior): pi needs the provider's endpoint
    // config to resolve a wire protocol, so no provider ⇒ not drivable. The managed CherryAI
    // free-quota default is barred too — like claude, pi must not drive it directly.
    isModelCompatible: (provider, model) =>
      !!provider &&
      isPiCompatibleModel(provider, model) &&
      !isManagedCherryAiDefaultModel(model.providerId, model.apiModelId ?? parseUniqueModelId(model.id).modelId),
    transport: 'pi-agent',
    builtinTools: () =>
      PI_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        labelKey: `agent.tools.builtin.${tool.name}.label`,
        descriptionKey: `agent.tools.builtin.${tool.name}.description`,
        category: tool.category
      }))
  },
  dsh: {
    labelKey: 'library.config.agent.field.runtime.option.dsh',
    labelFallback: 'DeepSeek Harness',
    // Plan mode is enforced by the bridge policy (dsh's own plan mode is guidance-only);
    // `auto` stays out — dsh has no model-side auto-approval classifier.
    permissionModes: ALL_PERMISSION_MODES.filter((mode) => mode !== 'auto'),
    modelTiers: false,
    heartbeat: false,
    knowledgeBases: true,
    // The complete session MCP set is bridged into approval-gated dsh native tools.
    mcp: true,
    // Enabled Cherry-managed skills mount as the composition's only skill roots (customSkillDirs).
    skills: true,
    slashCommands: DSH_BUILTIN_COMMANDS,
    createDefaults: { permissionMode: 'acceptEdits' },
    // Orphan models are rejected: dsh needs the provider's endpoint config to resolve a wire
    // protocol, so no provider ⇒ not drivable. The managed CherryAI default is barred like pi's.
    isModelCompatible: (provider, model) =>
      !!provider &&
      isDshCompatibleModel(provider, model) &&
      !isManagedCherryAiDefaultModel(model.providerId, model.apiModelId ?? parseUniqueModelId(model.id).modelId),
    transport: 'dsh-agent',
    builtinTools: () => [
      ...DSH_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        labelKey: `agent.tools.builtin.${tool.name}.label`,
        descriptionKey: `agent.tools.builtin.${tool.name}.description`,
        category: tool.category
      })),
      ...dshCherryTools()
    ]
  }
} as const satisfies Record<AgentType, AgentRuntimeCapabilities>
