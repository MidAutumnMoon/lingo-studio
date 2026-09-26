# Pi Unification Plan — one engine for chat and work

Status: executing — 2026-09-26. Phase 0 ladder **complete**: all rungs through 0.87.1
landed and verified; remaining Phase 0 item is the 0.6 manual smoke.
Phase 1 architecture decisions are **settled** (pre-implementation review, recorded
in the Phase 1 section); Phases 2–3 remain draft.

Decision context: pi (in-process, loop owned by us, `pi-ai` wire layer shared with dsh)
is the base for unification. dsh stays as an opt-in agent runtime behind the existing
driver registry (`src/main/ai/runtime/types.ts`, `docs/references/ai/adding-a-runtime.md`).
The plan below phases the work so the app is shippable after every step.

## Hard constraints

1. **Working app after every step.** Each step is PR-sized, merges green, and leaves
   both chat and work functional (a step may migrate only a slice, never break a slice).
2. **Chat must work after every step** — chat is the product's core; it is never the
   thing that's temporarily broken while "work" is being fixed, or vice versa after
   Phase 0.
3. **The trunk is engine-agnostic and stays untouched until Phase 2 decides otherwise.**
   Trunk = `AiStreamManager`, stream listeners (`ai.stream.*` events), persistence
   backends, renderer transport (`IpcChatTransport`, `useChatWithHistory`). It all
   speaks `UIMessageChunk`; the pi side already emits `UIMessageChunk` via
   `piStreamAdapter`. Migration swaps the engine, not the dialect.
4. **No user data resets.** pi session JSONL and SQLite must survive each phase
   forward; schema changes only via appended migrations.
5. Rollback is always "revert the PR" or "flip a flag" — never "repair the database".

## Current state snapshot (grounding)

| Fact | Value |
|---|---|
| Pinned pi versions | ladder complete at the target — `@earendil-works/pi-ai` 0.87.1, `@earendil-works/pi-coding-agent` 0.87.1; the pi line (including transitive `pi-agent-core`/`pi-ai`) is forced to the root pin via `pnpm-workspace.yaml` overrides (see upgrade-notes §2) |
| Upgrade target | 0.87.1 — all three packages align on one line |
| pi patches in `patches/` | `pi-ai` (keyed to the current pin): add `ultra` reasoning effort — the only surviving patch (fetch threading dropped at 0.83.0, #7540 backport dropped at 0.84.0, both native upstream) |
| dsh coupling to pi upgrade | None at runtime — dsh's `pi-ai ^0.84.x` (resolves 0.84.4) is inlined into the `packages/dsh-bridge` dist at build time and lives on its own lockfile lane, deliberately not forced to the root pin (see the override comment in `pnpm-workspace.yaml`). Zero code shared between `runtime/pi/` and `runtime/dsh/` — parallel `modelInjection`/stream-adapter implementations of the same problems (a Phase 3 consolidation candidate) |
| Engine seam | `src/main/ai/AiService.ts:555` `streamText()` — already branches on `request.runtime?.kind === 'agent-session'` (line 565) → `AgentSessionRuntimeService.openTurnStream()`; a chat-on-pi branch slots in identically |
| Chat engine today | `AiService.streamText` → `buildAgentParams` → `src/main/ai/runtime/aiSdk/Agent.ts` → `@cherrystudio/ai-core` `createAgent` → Vercel AI SDK `ToolLoopAgent` |
| Chat ↔ aiCore surface | One call site: `createAgent` (`runtime/aiSdk/Agent.ts:118`). Everything else chat touches is `ai`-package types; aiCore's remaining surface (embed/rerank/image/one-shot generate) serves auxiliary callers only |
| Gateway ↔ engine | The local API gateway subscribes to the trunk (`proxyStream.ts`, `SseListener`, `contextOwner: 'caller'`) — it rides whatever engine `streamText` selects, so the public SSE contract follows the flag from dogfood day |
| Work engine today | `AgentSessionRuntimeService` → driver registry → `PiRuntimeConnection` (in-process) or `DshRuntimeDriver` (Bun child) |
| Chat test surface | `runtime/pi/*.test.ts` (16 files, the upgrade safety net); chat suites in `streamManager/`, `tools/`, renderer chat tests |
| pi test provider | `pi-ai/providers/faux` — lets engine tests run without network |

Scale reminder from the earlier survey: 345 files / ~103K lines import the Vercel AI
SDK union — that is why full removal is Phase 2, not Phase 1. Phase 1 moves one thing:
the chat-turn engine.

---

## Phase 0 — Upgrade pi 0.80.x → 0.87.1, work stays green

Goal: ride the pinned pi line to current so Phase 1 builds on the canonical APIs
(0.84 replaced the session model; 0.87 made `SessionManager` canonical — building
Phase 1 on 0.80 would just defer this upgrade into the middle of the migration).

Non-goals: any behavioral change to chat (chat is untouched); any dsh change.

Ladder complete (2026-09-26): every rung 0.81.1 → 0.87.1 landed with per-rung
verification (typecheck, `runtime/pi` + `agentSession` suites, lint); both patch
halves dropped at their rungs (fetch threading 0.83.0, #7540 backport 0.84.0 — both
native upstream) and the 0.86 `TranscriptContext` rework needed zero production
edits. Full `pnpm build:check` at the tip: every project green except 6 pre-existing
`provider-registry` catalog-sync failures that predate the ladder (owner data
decision — upgrade-notes §6). Upgrade procedure and patch state for future bumps:
upgrade-notes §2–3.

### 0.6 Manual smoke (cherry-electron-dev) — the remaining Phase 0 gate

Work checklist: new agent session; plain text turn; MCP tool call; approval prompt
approve + deny; mid-turn steer; `/compact`; fork from message; edit-resend; quit +
relaunch + resume the same session (resume token); heartbeat/scheduled task fires;
one dsh agent session still runs; `pnpm smoke:dsh-runtime` green. Chat spot-check:
one normal chat message round-trips (chat was untouched, prove it).

**Data-compatibility gate:** session JSONL format verified stable across the range
(v3 at both 0.80.3 and 0.87.1; older versions migrated on read — notes doc §1). The
cold-sessions fallback is not expected to be needed; before shipping, still resume a
session created by the currently released app build as live confirmation.

Rollback: `jj abandon` the rung's change (or `jj restore` mid-rung) — pins + patches
are self-contained; no schema involved.

---

## Phase 1 — Chat engine on pi (Vercel AI SDK no longer powers chat turns)

Goal: normal chat topics execute on an in-process pi engine. The Vercel AI SDK
remains in the tree for auxiliary calls (Phase 2) but no longer executes chat turns.

Architecture decision (recorded, revisit in Phase 3): the chat engine is **not** a
driver-registry entry. The registry models long-lived session-ful connections
(resume tokens, reconcile, warm leases); a chat turn is stateless-per-execution.
Instead the engine mirrors today's shape — `AiService.streamText` gains a second
branch, exactly like the existing `agent-session` branch at `AiService.ts:565`:

- One in-memory pi `AgentSession` per `StreamExecution`
  (`SessionManager.inMemory` — no JSONL on disk for chat).
- Multi-model fan-out maps naturally: a topic dispatch already creates one
  `StreamExecution` per model → one engine per execution, no changes to
  `AiStreamManager` dispatch or overlays.
- Chunks flow through the existing `piStreamAdapter` (extended for chat part types)
  into the untouched trunk.

Settled in the pre-implementation review (2026-09-26, grounded against code):

- **Placement**: `src/main/ai/runtime/piChat/`, sibling of `aiSdk/`/`dsh/`/`pi/`,
  and **not** registered in `registerDrivers.ts` (that registry is
  agent-session-only). The pi-import confinement invariant widens to
  `runtime/pi*/` (upgrade-notes §1).
- **No new abstraction**: the seam signature — `streamText(request)` →
  `ReadableStream<UIMessageChunk>` — *is* the engine interface for the flag
  period; a `ChatEngine` interface in front of two implementations with different
  param surfaces buys nothing. `'chat-turn'` stays a reserved capability in
  `runtime/types.ts`; formalize only if chat grows session semantics (Phase 3).
- **`AgentSession`, not pi-agent-core `Agent`**: the in-memory `AgentSession` is
  what makes `piStreamAdapter` (it consumes `AgentSessionEvent`s — raw
  `streamSimple` or a pi-agent-core loop emits different vocabularies), the
  approval-extension pipeline, and the provider extension reusable as-is. The
  lighter pi-agent-core path (cherry-studio-pi's choice) needs a fresh adapter and
  loses the approval pipeline entirely. Cost of `AgentSession`: repeating pi's
  discovery-suppression ceremony (`noExtensions`/`noSkills`/`noPromptTemplates`/
  `noThemes` + `systemPromptOverride` — the list `PiRuntimeConnection.ts` already
  carries) so nothing disk-discovered leaks into chat turns.
- **Flag fallback resolves per-execution**: while the W3 matrix is incomplete, an
  execution runs "pi if the provider passes the matrix, else legacy (logged)".
  The matrix going fully green is the gate for default-on, so default users never
  see the mixed state. During dogfood the two engines may coexist within one
  multi-model topic — fan-out creates one execution per model.
- **The gateway rides the flag from day one**: dogfood turns already exercise the
  public SSE contract on the pi engine (see snapshot table) — gateway
  spot-checks belong in the W6 per-level checklist, not Phase 2.

What explicitly does NOT change in Phase 1: renderer (zero diff), IPC schemas,
SQLite schema, i18n, `AiService.generateText` and all auxiliary callers.

### Workstreams

**W1 — History converter: DB messages → pi context.**
Convert persisted `CherryUIMessage[]` into pi messages for each request (read-only
input; persistence stays on the accumulator, so the converter never writes).
Cover every persisted part type (`src/shared/data/types/uiParts.ts`): text,
reasoning, tool-call/result, file/image, translation, error. Produce a fidelity
matrix — where pi has no representation (citations metadata, custom data parts)
the mapping is lossy by design and documented.
Ship/verify: converter unit tests over the full part corpus + golden conversations;
property: converter output is a function of input only (no persistence side effects).

Landed. Post-landing review (2026-09-26) exercised the real path —
`toPiSessionEntries` → `SessionManager.inMemory` → `buildSessionContext` → captured
provider payloads — and fixed four mapping defects in place: MCP call results now
render through the summary the MCP tool declares instead of the raw response (which
put base64 media into the prompt, and `trimToolOutputs` cannot cover non-text
content), reasoning replays the persisted provider signature (anthropic), `usage.input`
carries the uncached count pi expects, and the wire-name policy has one home
(`messageRules.resolveReplayToolName`). Deferred findings are recorded as W2
deliverables below and in the W5 register; nothing here blocks W2.

Known debt, deliberately deferred: `timestampMs` yields NaN for a malformed
`metadata.createdAt` (in-memory entries only, inert); a terminal part whose output is
absent replays as the literal text `undefined`; the pi-emitted part vocabulary
(`providerExecuted`/`dynamic`) replays as local calls — correct for pi, but a topic
abandoned between flag levels needs the W6 spot-check.

**W2 — Pi chat engine module** (`src/main/ai/runtime/piChat/` — placement settled,
see architecture decisions).
Builds the in-memory session per execution: provider injection via the existing
`modelInjection.ts`, system prompt via the existing chat prompt assembly (not the
agent `buildAgentRuntimePrompt` — chat keeps its own prompt until Phase 3), tools
per W4, abort wired to `session.abort()`, usage → billing hook parity with the
current `createAiUsagePlugin` accounting, OTel spans in the existing shape.
Deliverable inside W2/W3: a **feature-plugin parity inventory** — every behavior in
`runtime/aiSdk/params/features/` (anthropic cache headers, DeepSeek DSML parsing,
qwen thinking toggles, OpenRouter reasoning params, tool-schema compatibility,
in-loop compaction, …) mapped to *native in pi-ai / needs port / deferred*, feeding
the W5 register. pi has no `AiPlugin` surface, so this inventory — not the
streaming plumbing — is where parity risk concentrates.
Ship/verify: engine-level streaming tests against `pi-ai` faux provider — text
turn, tool round-trip, abort mid-stream, usage events.

W2 also owns the **persisted part vocabulary** and the converter wiring (W1 review):

- Emit `start-step` per pi assistant message. The trunk's accumulator turns that
  chunk into a `step-start` part for every engine, and both the message-edit path and
  the legacy boundary restoration derive step boundaries from it — a turn persisted
  without it cannot be split back later (`piStreamAdapter` currently emits none).
- Pass the converter options (the engine does — see the W2 review record below):
  `isSameModelAsTurn` (the W6 seam answers whether a persisted message came from the live
  model; the ENGINE builds the descriptor, because pi's same-model comparison includes
  the per-execution provider name only the engine knows), `mediaCapabilities`,
  `declaredToolNames` (the pi tool names as declared).
- Round-trip test: captured `piStreamAdapter` parts → converter → only the documented
  matrix gaps. This is the mechanical guard for the irreversible class of findings —
  anything the engine fails to persist or the converter fails to read back.

Landed (2026-09-26): `runtime/piChat/chatEngine.ts` + faux-provider engine suite
(text/tool/abort/error/usage turns, prompt forcing, verbatim slash text, round-trip
guard); `piStreamAdapter` emits `start-step` on assistant `message_start`. Findings
the engine tests caught, for the record: pi's structured system-prompt path appends
a `<cwd>` block unconditionally — chat forces its prompt through a
`before_agent_start` extension (the opaque `forceSystemPrompt` path; empty prompt ⇒
no system message at all), NOT the loader override, which only feeds the structured
sections; `ThinkingLevel` unions disagree across pi packages (pi-ai carries the
patched `ultra`, pi-agent-core's copy lags) — cast at the session boundary. Deferred:
the feature-plugin parity inventory rides W3 (per-family plugins are where it lands);
request→engine-input preparation is the W6 seam wiring; the engine imports
`withPiInvocationCapture` from `PiRuntimeConnection.ts` — extract to a shared
`runtime/pi/` module when a third consumer appears.

W2 post-landing review (2026-09-26) — probes against the real pi runtime, then fixed:

- **Abort during setup was dropped.** `addEventListener('abort')` never fires for an
  already-aborted signal, so a stop landing while the session was built let the turn run
  to completion (probed: text streamed, provider response consumed, no `finish`). The
  engine now closes without prompting when `signal.aborted` at `start()`, and removes the
  listener on cleanup.
- **Same-model replay could never trigger.** pi compares
  `provider && api && model` (`transform-messages`), and the engine registers the provider
  as `${name}:${executionId}` — so a descriptor built from persisted Cherry data never
  matched (probed both directions: namespaced ⇒ `signature` preserved on the wire; bare
  ⇒ thinking degrades to text). The engine now owns the descriptor behind
  `isSameModelAsTurn`; W1's signature replay and the pending google/openai-responses
  signature rows depend on this.
- **Request environment was a hidden caller obligation.** `withPiRequestEnvironment`
  (Cherry proxy rules + Electron `customFetch`) was applied at the agent call site only;
  it now lives inside `materializePiProviderStream`, whose returned `streamSimple` (and
  config) is the complete transport for both engines. Its two tests moved to
  `modelInjection.test.ts` with it.
- **Dead teardown removed.** `unregisterApiProviders('provider:…')` is a no-op on pi 0.87
  (probed: registration goes to the per-runtime composer; the global api registry is
  untouched by register *and* unregister). The chat engine no longer calls it or dynamically
  imports `compat` per turn. `PiRuntimeConnection` still carries the same vestige — dead,
  low-risk, left for the unification pass (see the Phase 3 record).
- **Usage invocation re-declared a shared shape.** Chat now emits the canonical
  `AgentRuntimeUsageInvocation` (`runtime/types.ts`, extracted from the runtime-event union)
  with `messageAssociation: 'current-turn'`, so the seam can reuse the agent path's
  persistence/analytics sink instead of re-wrapping.
- **`length`/`error` verdict had two owners** (`turnFailure` + a dead `length` branch in
  `toFinishReason`): one `turnVerdict` now decides failure vs finish. The `length`-as-error
  policy itself is shared with the agent connection — see the register row.
- **A mis-sliced handoff is now a setup failure**: `prompt.messageId` must not appear in
  `history`, so a seam that forgets to remove the trailing user turn errors out instead of
  sending the question twice.
- Coverage added: history replay through the engine; the prompt-id guard; pre-aborted
  signal; `length` verdict; usage math as a relation (inclusive input = noCache + cache
  buckets); same-model signature at the wire (real anthropic serializer + recording fetch);
  two concurrent executions on isolated registrations.

**W3 — Provider coverage: agent whitelist → every chat-usable provider.**
`modelInjection`/`assertPiProviderUsable` currently serve agent-approved providers.
Chat must cover the full provider matrix (`provider/extensions.ts` + customs +
gateway). The engine reuses `runtime/pi/modelInjection.ts` wholesale — do not fork
a chat variant, so provider mapping stays at two implementations (aiSdk provider
config + pi); dsh's parallel `runtime/dsh/modelInjection.ts` remains the lone
outlier, a Phase 3 consolidation candidate.
Build a compatibility test keyed on `@cherrystudio/provider-registry`
endpoint types as the axis; every endpoint type gets a family-mapping case
(openai-completions, openai-responses, anthropic-messages, google-generative-ai,
bedrock, mistral, azure, codex — mirroring `loadPiApiStreamSimple`). Gateway
routing parity (`buildPiGatewayInjection`) for Cherry Cloud models.
Ship/verify: matrix test green; one live spot-check per family in dev.

**W4 — Tools: bridge first, re-home later.**
- W4a (phase exit requires): adapter from the existing chat tool registry to pi
  `ToolDefinition`s. MCP-backed tools: reuse `piMcpToolAdapter` unchanged (same
  InMemoryTransport bridge the agent side uses). Zod-defined builtin tools:
  convert via JSON Schema pivot into TypeBox (`Type.Unsafe` accepts raw JSON
  Schema — no hand-rolled schema rewrites).
  Approval design change (call it out): the ai-sdk path pauses and **re-dispatches**
  (`continue-conversation`); a pi engine holds the tool-call promise in-process.
  Chat approvals therefore route through the existing pi authorizer
  (`approvalExtension` pipeline) → `tool-approval-request` chunk → existing
  `ai.tool.respond_approval` IPC → authorizer resolution, engine stays resident
  while awaiting. Same renderer cards, different resume mechanics.
- W4b (optional, later): re-home chat-only tools as MCP servers alongside
  `cherry-tools` and delete their adapter entries. End-state direction; not a
  phase-exit requirement.
Ship/verify: per-builtin-tool round-trip tests; approval pause/resume/deny test;
MCP tool test reusing `piMcpToolAdapter` fixtures.

**W5 — Parity gap register** (each entry ships or is explicitly deferred):

| Gap | Plan |
|---|---|
| Multi-model fan-out + branch overlays | Trunk already models it; verify overlays render from pi-engine chunks |
| Retry/fallback model chains | Host-level `createRetryableWrap` is engine-agnostic — keeps working; disable pi-internal auto-retry for chat engines so retry has a single owner |
| Provider-native server-side web search | **Accepted delta**: pi-ai has no `providerOptions` plugin surface. Chat web search served via the MCP `web_search` tool on the pi path; provider-native search remains only on the legacy path until that path dies. Documented UX delta, not a blocker |
| Attachments | `attachmentRouting` produces AI-SDK shapes and its `NativeFileSupport` axis is resolved from **AI SDK converter** behavior, while pi-ai user content is text+image only. The W6 seam must run `prepareChatMessages` over the whole served list (legacy parity: old attachments are re-extracted every turn) with native support pinned to pi's expressive set — image per model vision, and pdf/audio/video **forced to extracted text**. Reused as-is, a "native" PDF stays a file part and the converter degrades it to a filename note: silent content loss. Cover image + PDF + non-vision-image (OCR) cases |
| Citations / sendSources | Agent side already resolves citations for pi tool outputs; port the resolution to chat rendering |
| Reasoning effort / service tier / fast mode | `modelInjection` thinking-level map extended to chat params; verify per family |
| Defer exposition (`tool_search`) | Port `piCodeMode` catalog for chat when tool counts demand it; v1 may ship without (chat tool sets are small) |
| Steering semantics | Chat steer = enqueue + yield + chained continuation (host-owned, engine-agnostic) — no change; pi-native steer is not used for chat in Phase 1 |
| Replayed step boundaries | One persisted message collapses to one assistant entry, so tool calls from different steps share one wire turn. W2 emits `start-step`; splitting the entries in `toAssistantTurn` at those boundaries is the follow-up (pi's own sessions keep one assistant message per step) |
| Replayed tool-result rendering (builtin outputs) | MCP call results render through `mcpResultToTextSummary` (`messages/toolResultRendering.ts`, the same summary the MCP tool declares); the knowledge / fs / web / painting `toModelOutput` views are unported, so those replayed results show raw JSON text. Port into the same shared module (it survives Phase 2 — the ai-sdk adapter dir does not) |
| Reasoning signature replay (non-anthropic families) | `providerMetadata.anthropic.signature` replays today; google (`thoughtSignature`) and openai-responses (`itemId` blob) keys are unmapped. The engine's `isSameModelAsTurn` identity is what makes any of this reach the wire — land them together in W3, and note that cross-model treatment also strips tool-call `thoughtSignature` and normalizes tool-call ids (`transform-messages`) |
| Stop-reason `length` policy | Both pi paths fail the turn with an actionable error (`turnVerdict` / `finishPromptRun`), while the legacy chat path finishes successfully at `finishReason: 'length'` and the gateway maps it to `max_tokens`. Decide once (keep pi's behavior ⇒ a UX delta users will see: truncation surfaces as an error row; partial text is still persisted). Legacy parity claim in the W6 checklist must match the decision |
| Resumed-session reasoning replay (agent path) | The agent connection names the provider `${providerId}:${sessionId}:${generation}` and rewrites the pi api per generation, and pi stores those names in session JSONL — so after a resume every replayed assistant message is cross-model and signed thinking degrades to text. Chat fixed this by owning the descriptor (`isSameModelAsTurn`); the agent path needs the same identity treatment (fits the unification, see Phase 3) |
| Tool timing in `runtimeTiming` (pi chat) | `MessageRuntimeTimingCollector` is fed by the legacy engine's `onToolExecutionStart/End` hooks only, so pi chat turns persist no tool spans and the perf panel's tool lane attributes tool time to the model. Either derive spans from chunks in the trunk (`withReasoningTimingMetadata` is the precedent transform) or feed the collector from the pi adapter |
| `timeThinkingMs` in usage metrics | The legacy billing middleware records thinking duration; `PiInvocationMetrics` has no such field, so both pi paths leave `timeThinkingMs` null in `aiUsageRecord`. Needs a pi-side thinking-duration measurement (the adapter already sees `thinking_start/end`) |

**W6 — Rollout flag.**
Preference flag (e.g. `AiChat.piEngine`), levels: off → dogfood (team topics) →
default on → remove the legacy path. Each level is its own merge. The flag
resolves **per-execution** with silent logged legacy fallback while the W3 matrix
is incomplete (see architecture decisions); default-on requires the matrix fully
green so the mixed state never ships to default users.
Per-level manual checklist: plain send; tool call + approval; image attachment;
multi-model topic; regenerate; branch/merge; abort mid-stream; kill the app
mid-stream and relaunch (attach + persistence); translate feature (rides the same
engine when flag on — verify or explicitly exclude in flag scope); API-gateway
round-trip (the public SSE contract rides the engine from day one); a topic written
with the flag on, then replayed after flipping the flag back off — the pi engine
stamps tool parts `providerExecuted`/`dynamic`, which the legacy conversion treats
differently.

**W6 seam — request→engine-input preparation** (the engine takes prepared input on
purpose; these are the obligations that used to be implicit, from the W2 review):

- Provider: `resolvePiProviderInjection` → `materializePiProviderStream` — the returned
  `streamSimple`/config is the complete transport (compat wrappers, Cherry proxy env,
  Electron fetch); hand `{name, config, apiKey, modelId}` to the engine and do not wrap.
- Prompt: assembled chat prompt string; the trailing user message's text verbatim
  (no template expansion) + its **images mapped to pi `ImageContent`** (pi resizes/omits
  unusable ones itself).
- History: served messages **excluding** the trailing user message, its id passed as
  `prompt.messageId` (the engine rejects double-inclusion); `isSameModelAsTurn` from the
  message's `metadata.modelId` vs the turn's `UniqueModelId`; `mediaCapabilities`;
  `declaredToolNames`.
- Attachments: `prepareChatMessages` over the full served list with pi-shaped native
  support (see the register's attachments row) — before slicing, so history keeps legacy
  fidelity.
- Accounting: `onInvocation` → the same attribution/analytics sink the agent path uses
  (`AgentRuntimeUsageInvocation`), with the chat `tokenUsageSource` and the execution's
  anchor message id.
- Tools: only after W4a's authorizer exists — the engine executes whatever it is handed,
  with no approval gate of its own.

### Phase 1 exit criteria

- Flag removed; legacy chat execution path (`runtime/aiSdk/Agent` +
  `buildAgentParams` chat consumption) deleted or reduced to what auxiliary calls
  still need.
- Every chat test suite green on the pi engine; W5 register has no unowned rows.
- Vercel AI SDK executes zero chat turns.

Rollback (until exit): flip the flag. After exit: revert the deletion PR.

---

## Phase 2 — Retire the Vercel AI SDK (staged, two open decisions)

**2.1 One-shot and stream-prompt calls → pi-ai.** `AiService` internals swap to
pi-ai stream/generate while the `AiService` facade stays identical — the ~24
caller sites (naming, translation, diagnosis, mini-app, …) don't change.
Special care: the local API gateway proxy (`proxyStream.ts`) is a public SSE
contract for external clients — its wire format must not move.

**2.2 Decision D2 — embeddings / rerank / image generation.** pi has no
equivalent; these cannot migrate to pi. Options: (a) keep a slimmed
`@cherrystudio/ai-core` as embed/rerank/image runner (ai-sdk remains a transitive
dep — "removal" becomes "confined to non-chat calls"), (b) direct HTTP per
provider family, (c) another library. Recommendation: (a) now, revisit after the
loop migration settles. Owner decides before this phase starts.

**2.3 Decision D3 — the `UIMessage` dialect.** The `ai` package's types are the
wire format of `ai.stream.*`, the DB column, and every renderer part renderer.
Options: (a) vendor the type definitions into `src/shared/` and keep the wire
format (removes the npm dependency; touches few files), (b) replace the dialect
(345 files / ~103K lines — its own program). Recommendation: (a).

**2.4 Renderer (only after D3):** replace `@ai-sdk/react` `useChat` with a thin
store consuming `ai.stream.*` events — the trunk already delivers everything;
`useChat` is convenience, not coupling.

Exit: `ai` / `@ai-sdk/*` absent from chat and agent paths; remaining presence only
per D2's choice.

---

## Phase 3 — Merge chat and work (sketch — design TBD)

Candidate directions, deliberately undecided:

- Unified topic model: chat topics as lightweight sessions (or sessions as topics
  with a runtime attached) — resume/steer/fork parity across both surfaces.
- Formalize the chat engine as a `chat-turn` capability in the driver registry
  (the reserved slots in `runtime/types.ts`) once it has session-ish semantics.
- Single tool home: everything MCP (`cherry-tools` et al.), adapter layers deleted.
  Alternative pattern worth evaluating (from the dormant `CherryHQ/cherry-studio-pi`
  fork, June–July 2026): internal app operations as an in-process, risk-typed
  capability registry with search-over-capabilities + call-by-id tools
  (`AppSearchCapabilities`/`AppCallCapability` — same exposition shape as
  `piCodeMode`'s tool search).
- Provider-mapping consolidation: fold `runtime/dsh/modelInjection.ts` behind the
  pi mapper — after Phase 1 there are otherwise three parallel implementations
  (aiSdk provider config, `runtime/pi/`, `runtime/dsh/`).
- Single prompt/permission model: converge `buildAgentRuntimePrompt` and the chat
  prompt assembly.

**Consolidation inputs (W2 review, 2026-09-26 — recorded, not fixed: chat and the agent
connection will merge here, so parallel copies are the target, not a bug to patch now).**
`runtime/piChat/chatEngine.ts` and `runtime/pi/PiRuntimeConnection.ts` now hold two copies
of four policies, and one copy has already drifted:

| Policy | Agent connection | Chat engine | Drift |
|---|---|---|---|
| Provider-invocation accounting | `recordProviderInvocation` | `buildInvocation` | shapes converge (`AgentRuntimeUsageInvocation`); `finiteTokenCount` exists 3× (dsh too) |
| Provider span mapping | `startProviderSpan` | `startProviderSpan` | agent marks `error`/`aborted` calls `ERROR`, chat always `OK` — provider failures arrive as resolved messages, so chat's spans never go red |
| Turn verdict (stop reason / error extraction) | `handlePiEvent` + `finishPromptRun` | session-event handler + `turnVerdict` | same `turn_end` cast, `willRetry` reset, `lastErrorMessage`, identical `length` text |
| Provider teardown | `unregisterApiProvider` | (removed in W2 review) | dead on pi 0.87: nothing registers under `provider:…` in the global api registry |

Also in this pass: the two engines each own a session lifecycle (build → seed → prompt →
verdict → dispose) with the same shape and the same failure modes. One owner for that
lifecycle is the single highest-value item here — it removes all four rows above at once.

Open questions: does chat ever want warm sessions and resume tokens; does work
ever want multi-model fan-out; where do overlay branches and session forks unify.

---

## Verification & rollback matrix

| Phase | Automated | Manual smoke | Rollback |
|---|---|---|---|
| 0 each step | typecheck + `runtime/pi`/`agentSession` suites; full gate at the end | work checklist (0.6) incl. pre-upgrade session resume | jj abandon the rung |
| 1 each workstream | converter corpus tests; faux-provider engine tests; provider matrix; tool round-trips; chat suites | per-flag-level chat checklist | flag off |
| 1 exit | full `pnpm build:check` | both checklists | revert deletion PR |
| 2 each step | per-site suites; gateway SSE contract test | aux features (naming, translate, knowledge indexing, paintings) | revert step |

## Appendix — load-bearing files

- Phase 0: `src/main/ai/runtime/pi/*` (esp. `PiRuntimeConnection.ts`, `piSdk.ts`, `piSessionFile.ts`, `piFork.ts`, `piTransportStream.ts`, `modelInjection.ts`), `patches/@earendil-works__*`, `src/main/ai/agentSession/` (resume-token hydration).
- Phase 1: `src/main/ai/AiService.ts` (seam), new `runtime/piChat/`, `piStreamAdapter.ts`, `messages/` (converter input), `src/main/ai/tools/adapters/aiSdk/registry.ts` (W4a source), `approvalExtension.ts` + `toolApproval/` (approval resume mechanics), `streamManager/` (unchanged — proof by diff).
- Phase 2: `packages/aiCore/src/core/runtime/executor.ts` (swap target), `src/main/features/apiGateway/proxyStream.ts` (contract freeze), `src/shared/data/types/` (D3), `src/renderer/hooks/useChatWithHistory.ts` (2.4).
