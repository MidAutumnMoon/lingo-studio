---
description: resolveChatTurnPlan — the engine-agnostic chat-turn plan resolving selection, context budgets, web-tool routing, reasoning, and the custom-parameter split before the engine runs
sources:
  - src/main/ai/chatTurnPlan.ts
  - src/main/ai/runtime/piChat/chatTurnSeam.ts
  - src/main/ai/contextBuild/resolveOutputReservation.ts
---

# Chat Turn Plan

## What it is

`resolveChatTurnPlan` (`src/main/ai/chatTurnPlan.ts`) computes the
**engine-agnostic core** of one chat turn: retained context, context settings,
tool selection, web-tool routing, the reasoning invocation, the tool-call
limit, the output-token budget, and the custom-parameter split. The pi chat
seam (`tryStreamPiChatTurn`, `src/main/ai/runtime/piChat/chatTurnSeam.ts`)
consumes this one plan — pi is the only chat engine — so preparation decisions
live in a single place. The file sits at the `ai/` root next to its caller
`AiService` because it belongs to no engine's directory.

It is a standalone async orchestrator — no class or retained request state.
It is the **chat** pipeline: its input is an `AiChatRequest`, which carries
`conversation: ConversationRef { id, topicId? }` supplied by the caller — the
stream manager passes the topic (or the trusted agent session), topic naming
passes its topic, a health probe its own id. `AiStreamRequest` requires
`conversation.topicId` as its sole stream-topic field; `conversation.id` may
instead identify the longer-lived agent session, and non-streaming requests
such as probes may omit `topicId`. Embedding, rerank and image requests never
enter this pipeline; they use `resolveSdkConfig` directly.

## Input

```ts
interface ChatTurnPlanInput {
  request: AiChatRequest & {
    messageId?: string
    messages?: UIMessage[]
    retainedContext?: RetainedContext   // raw-path context from the chat provider
  }
  provider: Provider
  model: Model
  assistant?: Assistant
  runtimeProviderId: string             // the serving provider id (reasoning endpoint remap)
  preferredEndpoint?: EndpointType      // the endpoint the SERVING engine will actually use
}
```

`preferredEndpoint` matters because the plan's reasoning profile, effort
normalization, and output-cap resolution are endpoint-keyed. The seam passes
pi's preference (`piPreferredEndpointType` — dual-protocol models ride
anthropic-messages) so the plan describes the real wire instead of the
catalog's `endpointTypes[0]` view.

## Resolution order

```
resolveChatTurnPlan(input)
  ├─ resolveEffectiveEndpoint        → endpointType (input.preferredEndpoint wins)
  ├─ retained context                → request.retainedContext ?? collectRetainedContext(messages)
  ├─ resolveRequestContextSettings   → contextSettings + compressionModel
  ├─ resolveToolCallLimit            → the turn's tool-call bound
  ├─ canOffloadToolOutputs           → the four-part offload gate
  ├─ resolveRequestToolSignals       → mcpToolIds / mcpResourceServerIds / browser / KB-presence
  ├─ resolveWebToolRoutes            → webToolRoutes (client-or-none)
  ├─ selectRegistryTools             → registry.selectActive + lone-fs_read drop
  ├─ extractAiSdkStandardParams      → customParameters split (standard vs provider-scoped)
  │    + filterStandardParams        → capability-filter the standard half
  ├─ resolveRequestedMaxOutputTokens → the raw output cap
  └─ resolveReasoningProfile → normalize selection → resolveReasoningInvocation
```

Retained context prefers the request-carried value: the persistent chat
provider computes it from the RAW message path, so attachments and persisted
tool outputs folded away by durable compaction stay readable via `read_file` /
`fs_read`. Scanning `messages` only sees the served (post-fold) view — that
fallback exists for providers that never fold (temporary chat, agent).

## Tool selection and the tool-call limit

`resolveToolCallLimit` is one policy for every turn: without an assistant it
returns 20 (the historical AI SDK / `ToolLoopAgent` default step cap); with
one, the `enableMaxToolCalls` setting gates the bound and `maxToolCalls` is
clamped to 1..1000 (default 100).

`selectRegistryTools` reconciles the selected MCP tool ids against the
cache-only catalogs (`syncMcpToolsToRegistry` — no MCP network round trips),
then runs `registry.selectActive` with per-entry `applies` predicates (see
[Tool Registry](./tool-registry.md)). A lone `fs_read` selection is dropped:
with no other tool to produce an offloadable output mid-loop there is nothing
to read back. Models without function calling get no selection at all
(`canConsumeTools: false` ⇒ empty `selectedEntries`).

`canOffloadToolOutputs` is the four-part gate: context settings enabled, the
requester is not the context owner (`contextOwner !== 'caller'`), the turn has
an anchor row, and `toolCallLimit > 1` — a marker minted on the last permitted
tool step can never be read back, so admission refuses it up front.

## webToolRoutes

Web tools are client-or-none. Provider-native (server) web tools were removed
with the legacy engine, so `resolveWebToolRoutes`
(`src/shared/utils/provider.ts`) routes `webSearch` / `webFetch` to `'client'`
only when the assistant enables web search, the model supports function
calling, and a ready client backend resolves for that capability (search-key
and URL-fetch providers plus their fallback chains; permanent config errors
count as unavailable). Otherwise the route is `'none'`, with a reason code the
UI maps to copy. The plan's `webSearch !== 'none'` flag also feeds the system
prompt's date anchor.

## customParameters split

User-supplied `assistant.customParameters` may contain standard sampling
params (temperature, topP, …) **and** provider-scoped overrides.
`extractAiSdkStandardParams` (`utils/options.ts`) separates them, and the
plan capability-filters the standard half (`filterStandardParams`) at plan
time.

The seam consumes the standard half through `piStreamRequestOptions`:
temperature / topP go through the shared gates (`getTemperature` /
`getTopP` — model and reasoning gating), custom params override the
settings-derived values, and `topK` / `presencePenalty` / `frequencyPenalty` /
`stopSequences` / `seed` ride pi's `samplingParams` (applied by pi's
openai-compatible adapters only — a recorded residual). Provider-scoped custom
body params have no pi surface yet (also a recorded residual).

## Output-token budget

`resolveRequestedMaxOutputTokens` (`contextBuild/resolveOutputReservation.ts`)
resolves the raw cap before reasoning:

1. `request.callOverrides.maxOutputTokens`
2. `assistant.customParameters.maxOutputTokens`
3. the enabled assistant max-token setting
4. `model.maxOutputTokens`, only for an `anthropic-messages` endpoint
5. `undefined` — nothing is billed against the window; no `max_tokens` on the wire

The resolved cap is a required engine input: the seam patches it into the
materialized pi provider config (`patchRequestMaxOutputTokens` — a cap that
finds no model entry fails the turn rather than silently going inert), and it
feeds the reasoning invocation's budget fallback
(`requestedMaxOutputTokens ?? model.maxOutputTokens`) and the attachment
budget.

## Reasoning invocation

The requested selection is `request.reasoningEffort ??`
`assistant?.settings.reasoning_effort ?? 'default'`. The plan resolves the
provider registry's reasoning profile keyed by the serving endpoint (only the
`google-vertex-maas` reasoning remap reads `runtimeProviderId`), projects the
model's runtime reasoning from the profile, normalizes the selection against
that projected model, and resolves the `ResolvedReasoningInvocation` (kind +
selection + summary setting, with the output cap as the budget input).

The seam maps that invocation to pi's `ThinkingLevel` (`off` / tier by
identity, `auto` → explicit `medium`, `omit` handling per family — see
`resolvePiThinkingLevel` in `chatTurnSeam.ts`).

## Where to read more

- Code: `src/main/ai/chatTurnPlan.ts` (tests: `chatTurnPlan.test.ts`)
- Consumer: `src/main/ai/runtime/piChat/chatTurnSeam.ts`
- Tool defer: [Tool Registry](./tool-registry.md)
- Endpoint routing: [Adapter Family](./adapter-family.md)
