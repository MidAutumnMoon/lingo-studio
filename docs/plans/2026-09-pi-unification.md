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

W2 finish-up review (2026-09-26) — fresh-eyes pass over both W2 changesets; the four pi
suites verified green (159 tests) with typecheck and oxlint clean, all seven fixes above
present in the code. One code change and one recorded decision came out of it:

- **A pi-side `aborted` stop reason no longer masquerades as `finish: stop`.**
  `turnVerdict` special-cased only `error`/`length`, so an abort reaching the verdict
  with a live signal — reader cancel today, the W4a approval pipeline later — would
  surface as a successful turn with partial content. `aborted` now closes the stream
  cleanly, exactly like a signal abort (tested via the faux provider's aborted stop).
- **`finish-step` stays un-emitted, deliberately.** The legacy engine emits
  start/finish step pairs; no consumer reads `step-finish` parts and the gateway SSE
  adapters ignore both step chunks, so the pi adapter emits `start-step` only. Verified
  benign end to end (the accumulator settles tool parts regardless); revisit only if a
  consumer ever keys on step ends.

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

Landed (2026-09-26), mechanical half: `runtime/pi/providerMatrix.test.ts` —
adapter-family refinements (azure-responses → the azure family; azure
chat-completions, bedrock, both vertex families → unsupported;
mistral/openrouter/deepseek/groq ride openai-completions), a sweep over the
registry's own `data/providers.json` (every chat endpoint of all 63 preset
providers resolves a family except the explicit unsupported list; login-based
providers pass through their transport adapters), the
builtin-stream load for all five families, and gateway parity for every family
(`buildPiGatewayInjection` preserves each wire protocol and the `provider:model`
gateway id). **The live spot-check per family in dev remains the manual half.**
Endpoint-type classification is compile-enforced, not test-enforced:
`ENDPOINT_PI_API` in `@shared/ai/piModelCompatibility` is a total
`Record<EndpointType, PiApi | undefined>`, so a new registry endpoint member is a
typecheck failure until it is classified — the same guarantee
`loadPiApiStreamSimple`'s family switch gives (see the W3 review record below for
why the test-local version of this gate was removed).

Also landed with it, three family findings the probes caught:

- **pi-ai's Google adapter rejects a custom `fetch` outright** ("Custom fetch is
  not supported" — it drives `@google/genai`'s own client). `withPiRequestEnvironment`
  stamped `customFetch` on every family, so ANY google-family turn through the
  prepared stream would have died at request time — including agent sessions since
  the W2 review moved the wrapper into `materializePiProviderStream`. The google
  family is now exempt (pinned in the matrix suite) via
  `PI_API_SUPPORTS_CUSTOM_FETCH`, an exhaustive per-family table next to the family
  loader; consequence recorded in the register: that family rides the Node
  dispatcher directly, so Electron `net.fetch` session sharing does not apply to it.
- **Signature replay covers the reasoning families.** The converter maps
  `providerMetadata.google.thoughtSignature` (reasoning, text, AND tool-call parts —
  pi strips tool-call signatures cross-model itself, and Gemini 3 400s without
  them) and reconstructs the openai-responses reasoning item from
  `providerMetadata.openai.{itemId, reasoningEncryptedContent}` (`{type:'reasoning',
  id, summary, encrypted_content}` — the shape pi stores and replays verbatim).
  pi-WRITTEN turns round-trip: `piStreamAdapter` persists pi's opaque
  `thinkingSignature`/`textSignature`/tool `thoughtSignature` from the finished
  blocks (`event.partial`) under `providerMetadata.pi`, which the converter replays
  without family translation. Wire probes (real serializers + recording fetch; the
  google one captures through pi's `onPayload` hook because of the fetch rejection)
  pin same-model replay and cross-model degradation for all three families. Google
  validates signatures as base64 and drops anything else; a signature-bearing EMPTY
  text part survives the converter (Gemini signs empty parts; dropping breaks the
  reasoning chain). The one hole this pass left — redacted thinking, which is
  signature-only — is fixed in the review record below.
- **Reasoning dialects are mostly native.** pi-ai auto-detects deepseek (thinking
  `{type}` + reasoning-content echo on replay), zai (bigmodel.cn), together,
  openrouter, and moonshot from the provider baseUrl, and carries native
  `thinkingFormat` compat for qwen (`enable_thinking`), qwen-chat-template, baseten,
  string-thinking, and ant-ling. DashScope's compatible-mode host is not detected —
  `piDialectCompat` marks qwen models there (`thinkingFormat: 'qwen'`), model-gated
  like the legacy `qwenEnableThinking` plugin (DashScope also serves deepseek et al.,
  which ride the detected openai dialect). The gate was broadened to that plugin's
  real reach in the review record below.

**W3 post-landing review (2026-09-26)** — probes against the real pi runtime and the
trunk accumulator, then fixed. The review's raw findings are recorded, so a later
reader can tell deliberate decisions from oversights:

- **Redacted thinking was not replayable** (probed end to end). pi represents an
  Anthropic `redacted_thinking` block as `{thinking: '[Reasoning redacted]',
  thinkingSignature: <opaque payload>, redacted: true}`, and its serializer emits
  `redacted_thinking` *only* for a flagged block — otherwise the payload ships as a
  normal thinking block's `signature`, which Anthropic rejects. The adapter dropped
  the flag and the converter rebuilt the block without it. The legacy writer has the
  mirror-image shape (`{text: ''}` + `anthropic.redactedData`, drop-by-the-empty-text
  guard). Fixed: the adapter persists `redacted: true` under `providerMetadata.pi`,
  the converter resolves **signature + redacted flag** per family (including
  `anthropic.redactedData`) and keeps a signature-only block. Regression tests: an
  adapter/accumulator case, two converter cases, and one engine wire test asserting
  `{type:'redacted_thinking', data}` for both writers.
- **The matrix's endpoint axis gated nothing.** The two "exhaustive classification"
  assertions were tautologies — adding a fake `ENDPOINT_TYPE` member kept the suite
  green (probed). Fixed by moving the classification to the total `ENDPOINT_PI_API`
  record (compile-enforced) and deleting the hollow assertions; the chat-protocol
  table in the test is now derived from production instead of restated.
- **The qwen dialect gate was DashScope-only** while the legacy plugin's gate is
  `isQwenModel` on every provider outside `NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS`
  (i.e. also self-hosted and custom openai-compatible endpoints serving Qwen). Fixed:
  the shared predicate now gates `piDialectCompat`, minus hosts where pi-ai detects a
  *different* reasoning dialect (deepseek/zai/together/ant-ling/openrouter — an
  explicit override there would replace pi's detection). Tests cover both directions.
- **A stale comment contradicted the code** in `buildPiModelConfig` ("thinkingLevelMap
  intentionally omitted") after the map was wired; removed.

The family/endpoint facts now have three compile-enforced homes — endpoint → family
(`ENDPOINT_PI_API`), family → loader (`loadPiApiStreamSimple`), family → transport
(`PI_API_SUPPORTS_CUSTOM_FETCH`) — so a new family or endpoint member is a typecheck
failure in each dimension; the deliberate unsupported-provider list stays in the matrix
test where it is checked against the registry data. Left as-is, recorded: the
auto-detection case asserts only that our injection adds nothing for hosts pi detects
(asserting pi's detection itself needs a `detectCompat` export pi-ai does not provide).

**W3 feature-plugin parity inventory** (the deliverable deferred from W2; every
`runtime/aiSdk/params/features/` behavior mapped — new rows landed in the W5
register below, dispositions recorded here):

| aiSdk feature | pi disposition |
|---|---|
| anthropic-cache | native, different policy — pi places `cache_control` itself (system + last tool + trailing message; `cacheRetention` option); Cherry's threshold/last-N/budget knobs and provider ttl setting are inert. Optional seam port: map the ttl setting → `cacheRetention` |
| anthropic-headers | native — pi sends `interleaved-thinking-2025-05-14` itself and merges caller beta headers; the remaining flag (Vertex web search) is on an unsupported family |
| context-build (in-flight truncate/offload) | needs port — register row; served history is sliced upstream, but tool results generated INSIDE pi's loop get no Cherry truncation |
| deepseek-dsml-parser | needs port (stream wrapper) if DSML-emitting deployments must run on pi |
| deepseek-responses-reasoning-replay | needs port — pi drops UNSIGNED thinking on responses replay, and DeepSeek's responses dialect requires reasoning passed back (#18150); the completions dialect is auto-covered (`requiresReasoningContentOnAssistantMessages`) |
| devtools (ai-sdk) | N/A on pi (AI SDK devtools is middleware-shaped); drop for pi turns |
| gateway-usage-normalize | native — pi-ai normalizes usage itself; the flat shape was an ai-sdk adapter artifact |
| in-loop-compaction | needs decision — turn-start durable compaction is upstream of the seam (keeps working); compaction inside pi's tool loop is a register row |
| no-think (ovms) | needs port (prompt suffix) or keep ovms on legacy; the matrix cannot key it (provider-id gate at the seam) |
| openrouter-reasoning | needs port (strip `[REDACTED]`) — cosmetic; register row |
| provider-url-context / provider-web-search | accepted delta (existing rows) |
| qwen-enable-thinking | native via `thinkingFormat: 'qwen'`, gated by the shared `isQwenModel` + `isSupportEnableThinkingProvider` predicate (W3 review) — i.e. every provider outside the `NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS` deny list whose host pi-ai does not detect. Remaining deltas: (a) providers whose host pi-ai *does* detect keep pi's dialect (openrouter/deepseek/zai/together/ant-ling — deliberate, our override would replace their reasoning protocol; legacy injected `enable_thinking` for openrouter-class hosts, so verify per host when the flag goes default-on); (b) pi always sends `enable_thinking` (`!!reasoningEffort`), while legacy skipped the parameter entirely for `reasoning.kind === 'omit'` — decide when the W6 seam maps reasoning modes to `thinkingLevel`; (c) qwen on nvidia/gpustack rides the `/think`-suffix row below |
| qwen-thinking (/think suffix) | needs port only for qwen on nvidia/gpustack via pi (the other suffix providers — ollama/lmstudio — are not pi families) |
| reasoning-extraction (<think> tags) | needs port — pi-ai reads `reasoning_content`/`reasoning`/`reasoning_text` fields but does not extract inline tag markup |
| simulate-streaming | matrix exclusion — `streamSimple` is SSE-only; `streamOutput === false` providers must fail the matrix gate to legacy (W6 seam note) |
| skip-gemini-thought-signature | native on the google family (signature replay, W3); needs port only for gemini-via-openai-compat (pi's openai-completions injects no skip sentinel) |
| steer-yield | host-owned, engine-agnostic (existing row) |
| strip-reasoning-replay (HF) | mostly native (pi drops unsigned thinking on responses replay); signed same-model replay on HF needs a port if that combo matters |
| terminal-tool-failure | **Landed in W4a**: the branded trusted-local output maps onto pi's native per-result `terminate` hint in `chatToolAdapter` — the loop stops after the batch, the failure still reaches model + card |
| tool-schema-compatibility | native — google rides `parametersJsonSchema` (full JSON Schema; the enum/keyword/propertyNames drops don't arise), and we don't enable strict-mode compilation; W4a hands pi plain JSON Schema |

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

W4a landed (2026-09-26): `runtime/piChat/chatToolAdapter.ts` +
`chatToolApproval.ts` + the engine's authorizer hook. Deviations from the plan
text above, both grounded:

- **One uniform registry bridge, not a TypeBox pipeline.** Every entry — zod
  builtin, MCP, meta — converts through `asSchema(inputSchema).jsonSchema`:
  pi validates RAW JSON Schema natively (`validateToolArguments` carries a
  JSON-Schema path for schemas without TypeBox kind symbols — the same contract
  `piMcpToolAdapter` already relies on), so `Type.Unsafe` buys nothing. The
  result split is `content` = the entry's `toModelOutput` view (else raw JSON
  text — legacy parity) while `details` = the raw execute output, which the
  stream adapter now projects onto the tool part for chat tools
  (`payloadToolNames`) — as landed it did NOT (the projection unwrapped
  `details` for pi's own code-mode tools only), so cards and replay saw pi's
  `{content, details}` envelope; see the review record below. MCP entries route through
  their REGISTRY execute (`McpRuntimeService.callTool`: per-topic abort scope,
  catalog routing) — NOT the plan's InMemoryTransport bridge, which assembles
  its own server instances per session and would double-connect every server
  per chat turn while bypassing chat-side selection semantics. The trusted
  terminal-failure stop condition ports natively: the branded output maps onto
  pi's per-result `terminate` hint (`AgentToolResult.terminate`).
- **Approval resume mechanics, as designed.** `createChatToolAuthorizer` gates
  on the registry's `needsApproval` (`isApprovalGated` — chat's gate, not agent
  permission modes), registers in the NEUTRAL `toolApprovalRegistry`, and emits
  the AI SDK `tool-approval-request` chunk into the engine's stream; the
  existing `ai.tool.respond_approval` IPC resolves it — the responder peeks the
  neutral registry by approval id, so chat entries dispatch exactly like agent
  ones, and the engine stays resident while the promise pends. Two wrinkles,
  recorded: (a) the responder's follow-up `resolveToolApproval` call targets an
  agent-session topic id and no-ops for chat scopes — the seam's
  `onApprovalResolved` callback is the correct lever (wire it to
  `AiStreamManager.resolveToolApproval(topicId, …)` so the card advances
  immediately on approve instead of waiting for the tool's output); (b) pi
  reports a BLOCKED call as an error result, so the engine translates the
  denied call's chunk to `tool-output-denied` (the state the renderer card and
  the history converter treat as a denial) — the translation lives in the
  engine because that is where the adapter's chunk flows.
- Coverage: a per-builtin sweep (every registered builtin converts — a new or
  changed tool fails the suite on schema shape), execute bridges (context
  threading, model view vs raw details), an MCP-shaped entry (raw JSON Schema
  parameters + summary view + legacy-identical part output), terminal-failure
  terminate, and engine-level approval flows: pause→approve (edited input
  executes; `finish` lands), deny (no execution, `tool-output-denied`, no
  error), ungated (no card), plus authorizer-level edge cases (out-of-registry
  call, synchronous-resolution abort).

W4a post-landing review (2026-09-26) — probes against the real pi runtime, pi's
own argument validator and the trunk accumulator, then fixed:

- **Chat tool parts carried pi's result envelope, not the Cherry payload.** The stream
  adapter's projection unwraps `details` only for pi's own code-mode tools, so every chat
  tool part persisted `{content, details}` where the renderer
  (`extractOutputMetadata`), the deferred-output lookups and the history converter read
  the raw output — and an errored call carried the whole error envelope as JSON instead
  of its message (probed through the engine: the accumulated part output was the
  envelope, not the execute output the landed block above claimed was byte-identical to
  legacy). Fixed: the engine passes its registry tool names to `PiStreamAdapter`
  (`payloadToolNames`), which projects `details` as the part output and the result's
  text as the error text for exactly those tools — pi's own tools keep the envelope
  their cards are built on, and the agent path passes no set. Tests: an adapter-level
  projection case plus engine assertions on the accumulated part payload.
- **The approval gate never saw the request context.** `isApprovalGated` was called with
  `{input, toolCallId}` only, so a gate reading `getToolCallContext(options)` (the MCP
  resource-read policy) failed closed and prompted on *every* call — a spurious card that
  holds the tool-call promise until the user answers (probed: the authorizer never
  settles without a decision). Fixed at the root: tools and gate now come from one call,
  `toPiChatToolSurface(entries, context, {approvalScope, onApprovalResolved})` →
  `{tools, authorizer}` — one selection, one context, and the authorizer derives its
  entry map from the same array it converts (two independent inputs is what let the
  contexts diverge; a mismatched map would also silently leave tools ungated). The gate
  still receives an empty `messages` — no registry gate reads it today, and the pi path
  has no `ModelMessage[]` to give.
- **Multimodal `content` views lost their images.** `toPiContent` kept only the first
  text block, so `McpResourceReadTool` (resource images) and `BrowserTools` (screenshots)
  sent no image to the model. pi tool results carry text *and* images
  (`AgentToolResult.content`), and pi's OpenAI-family adapters hoist tool-result images
  into a following user message themselves — the hoisting legacy's `routeToolResultMedia`
  does — so the block-by-block mapping is the whole fix: text, `image-data` (and the
  deprecated `media`) map; anything else becomes a note instead of a silent drop. The
  hand-rolled `ToolResultOutput` mirror is gone — `@ai-sdk/provider-utils` (a direct
  dependency) exports the real type, so block narrowing is compiler-checked.
- **The schema pivot is verified against pi's own validator.** New sweep: every
  registered builtin's pivoted JSON Schema compiles (`TypeBox Compile`) and validates
  under `validateToolArguments`; the guarded failure is an unsupported keyword or shape,
  which surfaces as a TypeBox error rather than the validator's own message. Recorded
  with it: pi's JSON-Schema path is *lenient* (`Value.Convert` plus
  `coerceWithJsonSchema` coerce primitives and drop optional nulls), so a call the legacy
  zod validation would have rejected can execute with coerced arguments; `Type.Unsafe`
  would not be stricter (both paths run `Value.Convert`), so the deviation stands.
- **A denial can reach the trunk twice — benign, but the seam should know.** Wiring
  `onApprovalResolved` to `AiStreamManager.resolveToolApproval` makes the trunk emit its
  own `tool-output-denied` on deny, and the engine translates pi's blocked-call error
  too. Both writes are idempotent (the trunk keys pending approvals by toolCallId, the
  accumulator sets one state), so the recorded wiring is safe for approve and deny
  alike — approve is the half the card actually needs (the buffered-input replay).

**W5 — Parity gap register** (each entry ships or is explicitly deferred):

W5 landed (2026-09-27) — the register below carries each row's final disposition
(`**Landed**` / corrected / deferred-with-owner). Shipped, with tests at every layer:

- **Stop-reason `length` = legacy parity** (decision, recorded): truncation finishes the
  turn with `finishReason: 'length'` instead of erroring. Nothing in-app persists or
  renders finishReason, and every gateway SSE adapter maps `length` onto its family's
  max-tokens vocabulary — pi's error row + error frame was both a UX regression and a
  public-contract break. The AGENT path keeps erroring (deliberate divergence — the
  Phase 3 drift table is annotated so the consolidation doesn't "fix" it back).
- **Trusted terminal-failure surface = engine-level turn error**: the engine watches
  `tool_execution_end`, re-derives the brand from `details` (object identity survives),
  records ANY occurrence, and fails the turn with the shared `ToolLoopTerminalError`
  (`serializeError` carries `i18nKey` → the localized error row). The check runs BEFORE
  stop-reason mapping (a terminal stop reads as `toolUse`), survives pi retries (a retry
  re-runs the model, never tools), and loses only to a user abort. Known wrinkle, kept:
  pi stops only when EVERY result in a batch terminates (legacy: ANY), which is why the
  engine ABORTS at the `turn_end` following the batch (W5 review) — a mixed batch would
  otherwise keep the loop alive. Two costs the W5 review probed and accepted: the abort
  lands at the next loop iteration, and pi's loop has no abort check before
  `streamAssistantResponse`, so one MORE provider request is issued and self-aborts
  pre-flight (probe: 2 `start-step` + 2 `message-metadata` chunks, the queued faux
  response consumed) — an extra phantom step boundary and provider span, no content and
  nothing billed by a signal-honouring provider; and this divergence is per-TURN where
  legacy's cap was per-DISPATCH (an approval resume re-dispatched with a fresh step
  count, so legacy could exceed `maxToolCalls` across approvals while pi counts the
  whole turn).
- **Tool-call cap**: pi has no native loop cap and its extension hooks cannot end a run,
  so the ENGINE owns the bound — counting tool-bearing `turn_end`s (pi's loop is
  content-driven; stopReason is unreliable), aborting at the limit, and failing with the
  same `ToolLoopTerminalError(TOOL_CALL_LIMIT_MESSAGE, 'tool_call_limit_reached')` legacy
  produces. `toolCallLimit` is REQUIRED on the engine request (W5 review): the resolved
  value has two policies behind it (`resolveToolCallLimit(assistant)` = the assistant's
  `maxToolCalls`, 100 by default; assistant-less = 20), so an engine-side default would
  silently pick one — the seam always passes `resolveToolCallLimit(assistant)`.
- **pi-internal auto-retry AND auto-compaction disabled** for chat
  (`SettingsManager.inMemory({retry:{enabled:false}, compaction:{enabled:false}})`) — retry
  has the single owner the register asked for (the host retryable/fallback wrap); the wire
  layer already defaults to 0. Compaction was ENABLED by default (`compaction?.enabled ??
  true`, W5 review) and fires before an assistant response when the projected context crosses
  `contextWindow - reserveTokens` — inside a chat turn that is pi's summarizer running as an
  extra provider invocation and rewriting the model's view with no chunk the trunk can
  render, i.e. a policy conflict with Cherry's context shaping. The agent path keeps it.
- **`timeThinkingMs`**: measured in `withPiInvocationCapture` (first thinking frame →
  first content frame — the legacy billing semantics), so BOTH pi paths now fill
  `AgentRuntimeUsageInvocation.metrics.timeThinkingMs`.
- **Tool timing**: the engine feeds the trunk's `MessageRuntimeTimingSink` from the
  session's tool-execution events (wall-clocked; events carry no timestamps), so the
  perf panel's tool lane attributes tool time correctly. The approval WAIT is excluded
  (W5 review): pi emits `tool_execution_start` before the `tool_call` gate runs, so the
  engine times its authorizer call and subtracts it — the collector's contract (and
  legacy's execute hooks) never charged approval latency to the tool.
- **Inline `<think>` extraction**: chunk-level twin of the SDK's
  `extractReasoningMiddleware` on the engine's enqueue path (semantics verbatim: delayed
  `text-start`, unclosed tag streams reasoning with no synthetic end, `\n` separator
  between alternating segments, trailing prefixes of the NEXT tag held back; one
  deviation — synthetic reasoning ids are namespaced off the source text id because pi
  messages are genuinely multi-block). Gated on `model.api === 'openai-completions'`
  like legacy's endpoint gate; the tag derives from the model id.
- **Replayed step boundaries**: one persisted message now splits into one assistant
  entry per step; messages written without markers get the same boundaries via the
  shared `restoreLegacyToolStepBoundaries` (newly exported from `messageRules`).
- **Replayed builtin tool-result views**: `messages/builtinToolResultViews.ts` dispatches
  by name (web/kb/painting views from their engine-neutral homes; `read_file` and
  `fs_read` views RE-HOMED out of the ai-sdk adapter dir so they survive Phase 2),
  declared-gated like legacy's `convertToModelMessages({tools})`. A legacy defer-mode
  `tool_invoke` part replays as the INNER tool it dispatched (name + params unwrapped,
  result rendered through the inner view) instead of digest-renaming to an undeclared
  function. MCP results keep the shape-detected summary; browser/`mcp_resource_read`
  outputs stay lossy rows (below).
- **Prompt-suffix dialects**: `resolveUserThinkingSuffix` (one resolver + one text
  application) feeds both the trailing prompt and the converter's replayed user
  messages. Faithful to legacy's two scopes: qwen `/think`·`/no_think` on EVERY user
  text part for thinking-token qwen models on suffix-only providers; ovms `/no_think`
  on the FINAL content block only-when-text, gated on MCP tools being declared. The
  seam resolves it (it holds the Model the predicates need) and passes `userTextSuffix`.
- **Mid-loop tool-output truncation**: the opaque lane of legacy's per-model-call
  truncate runs at the W4a tool-result boundary (`contextBuild/inFlightTruncate.ts`,
  the single source for the threshold resolver + head/tail constants + the truncation
  semantics, reusing aiCore's `Offloader` so marker bytes stay identical). It reshapes
  only the model-facing `content`; `details` (card/persist/brand) keeps the full output;
  `truncatable: false` entries are exempt. `RequestContext.toolResultTruncation` carries
  the threshold + offload eligibility; the seam fills it (obligation recorded in W6).
- **Citations**: the renderer's citable-name resolution accepts the chat-pi builtin
  shape (`dynamic-tool` + `cherry.tool {type:'builtin'}` stamp) — the ONE Phase-1
  renderer diff, justified by this register row; ids are already minted in-main by the
  same tools, so nothing else moves. MCP-named chat tools were already citable via the
  cherry-tools evidence path.
- **Terminal-failure machinery re-homed**: `ToolLoopTerminalError` + the trusted-local
  brand moved to `tools/toolLoopTerminal.ts` (both engines + the web tools import from
  there) — with the two re-homed views above, the pi tree no longer depends on the
  ai-sdk runtime dir for anything Phase 2 deletes.

W5-review correction (defer row): the defer row's "digest-renamed" premise is wrong — `tool_invoke`, `tool_search` and `tool_inspect` are all wire-legal names (`WIRE_TOOL_NAME`), so legacy's converter replayed them VERBATIM as undeclared calls; the pi unwrap is still right (it keeps the call paired to a name the request can declare and restores the legacy argument shape). Also (W5 review): the pi tree still imports `TOOL_INVOKE_TOOL_NAME` from `tools/adapters/aiSdk/meta/toolInvoke` — one string constant the Phase 2 deletion must re-home.

Corrections the survey forced (register rows rewritten below): the `outputSchema` row's
premise was FALSE — `ai@6`'s `executeToolCall` never validates a tool's outputSchema on
the execute path (the only validation lives in `safeValidateUIMessages`, which Cherry
never calls; `knowledgeLookup.ts`'s "this is the ONLY enforcement" comment is ground
truth). Legacy baseline = unvalidated; no port (a pi-side validator would be stricter
than legacy, not parity). The defer-exposition row was also mis-scoped: `shouldDefer`
engages on MCP-heavy assistants TODAY on legacy; the ported `tool_invoke` replay mapping
(below) is what keeps those turns replayable on pi.

W5 post-landing review (2026-09-27) — probes against the real pi runtime (0.87.1), the
trunk accumulator, aiCore's own truncator and legacy's suffix/truncation sources; the
findings that are not fixes are recorded in the rows above (each with its evidence).

Fixed, with the probe that proved each one:

- **pi-chat lookup citations were silently dropped.** The W5 renderer widening read
  `providerMetadata`, but a tool chunk's metadata is filed by the AI SDK accumulator under
  `callProviderMetadata` (input chunks) / `resultProviderMetadata` (terminal), and no tool
  part ever carries plain `providerMetadata`. Probed end to end: the adapter's
  `tool-input-*`/`tool-output-*` chunks accumulate into exactly those two fields, so
  `resolveCitableToolName` never saw the builtin stamp and `mapCitationMarksToTags` deleted
  the model's `[cite:…]` markers. The part-level read now lives once
  (`extractToolMetadataFromPart`, shared with the tool renderer, which already knew the
  field order) and the test fixture uses the runtime shape — the old fixture passed
  `providerMetadata` and certified the bug (it fails against the pre-fix reader; verified).
- **The in-flight truncation could not fire on a multi-block view.** The lane truncated
  each text block independently, while legacy thresholds the JOINED text of a `content`
  view (`aiCore truncator.extractText`): 2×1200 chars against a 2000 threshold rode
  through untouched on the pi path and was truncated on legacy (probed both lanes on the
  same input). Now the joined text is the unit and image blocks survive (legacy replaced
  the whole output with the truncated text, dropping them); `truncatable: false` still
  exempts. The excerpt sizes are the persist lane's constants (one source, both lanes'
  byte-identity requirement enforced by construction rather than by a comment).
- **pi auto-compaction was enabled on chat turns.** pi defaults `compaction.enabled` to
  true and compacts before an assistant response once the projected context crosses
  `contextWindow - reserveTokens` — inside a chat turn that is pi's summarizer as an extra
  provider invocation plus an invisible rewrite of the model's view (the adapter ignores
  `compaction_*` events). Disabled next to retry; chat's context shaping is Cherry's.
- **The tool span swallowed the approval wait.** pi emits `tool_execution_start` before the
  `tool_call` gate runs (`agent-loop.js` `executeToolCallsParallel`), so the wall-clock
  span included the user's thinking time — while the collector's contract and legacy's
  execute hooks exclude approval latency (and the trunk records approval spans separately).
  The engine now times its authorizer call and subtracts it; probed with a controlled
  `performance.now` (5200 ms wall clock − 5000 ms approval = 200 ms reported; the
  unsubtracted code reports 5200).
- **`toolCallLimit` became required** on the engine request (see the landed block): the
  silent default was 100 where legacy's assistant-less policy is 20.
- Two leftovers removed: the dead `ToolLoopTerminalError`/`TerminalToolFailure` re-exports
  in the legacy loop file, and the pre-W5 description of the terminal mechanism in
  `tools/toolLoopTerminal.ts`'s header.

Recorded, not fixed (owners in the rows above): the post-cap/terminal abort costs one extra
aborted provider request plus a phantom step boundary and span; the cap counts per turn
where legacy counted per dispatch; the agent connection has no cap at all; a string tool
output replays before the declared view; a content-free step is dropped rather than
placeholdered; the defer row's "digest-rename" premise was wrong; and the pi tree still
imports one string constant from the ai-sdk meta dir.

**W6 — landed (2026-09-27), first merge of the ladder: the flag exists (default OFF) and the
seam is wired end to end.**

- **Flag**: preference `chat.pi_engine.enabled` (boolean, default false — the plan's
  `AiChat.piEngine` was illustrative; repo keys are lowercase dotted and ESLint-enforced),
  added through `target-key-definitions.json` + the data-classify generator. The renderer
  toggle lives in Settings → General → the Developer group, visible only with developer
  mode on (dogfood-only visibility). The ladder's later levels are default changes in
  their own merges (dogfood = the owner flipping it; this fork has no team-topic concept).
- **Gate placement**: `AiService.streamText` checks `piChatEngineEnabled()` BEFORE any
  provider/model resolution — a flag-off process pays nothing and the legacy path is
  byte-identical (the AiService retry suites that mock `buildAgentParamsFor` still pass
  unchanged). Flag on: resolve once, `tryStreamPiChatTurn(...)`, `null` ⇒ silent logged
  legacy fallback.
- **Per-execution exclusions** (all logged with a reason): `streamOutput === false`
  (simulate-streaming is SSE-less on pi); `trigger === 'continue-conversation'` AND
  structurally any served list not ending in a user message (approval-resume lists end
  with the assistant anchor — no prompt to slice, and pi holds approvals in-process so
  every resume is a legacy pause by construction); non-empty `callOverrides.tools`
  (gateway client tools carry no `execute`; the pi surface converts registry entries
  only); `apiKeyOverride` (an AI-SDK serving concern the pi injection would silently
  ignore); huggingface WHOLESALE (the router 400s reasoning input items on both of HF's
  protocols, not just responses — W6 review widened the seam's original endpoint-scoped
  exclusion); `usesPiGateway` providers (the session-shaped gateway injection is not wired
  for chat); and the provider-injection try itself (`PiUnsupportedProviderError` /
  `PiMissingApiKeyError` ⇒ legacy — missing keys render legacy's own error UX). NOT
  excluded: ovms (suffix landed W5), DeepSeek responses (#18150 stays a live-probe item),
  DSML (dogfood-tolerable per its row).
- **The engine-agnostic core was extracted, not duplicated**: `src/main/ai/chatTurnPlan.ts`
  (`resolveChatTurnPlan`) computes retained context, context settings + compression model,
  tool-call limit, the offload gate, tool signals, web routing + finalize, registry
  selection (incl. the lone-fs_read drop), the reasoning invocation + profile, custom
  params, and requested output tokens; `buildAgentParams` CONSUMES it and keeps only the
  AI-SDK tail (sdk config, capabilities, features, options, ToolSet + defer). Equivalence
  is enforced by the legacy suites passing unchanged. `resolveToolCallLimit` moved there
  (re-exported from `buildAgentParams` for existing importers); `hasAnchorRow` re-homed to
  `contextBuild/anchorRow.ts`; `createRequestCaptureContext`/`sourceSnapshotForAssistant`
  re-homed to `utils/usageCapture.ts` (the seam and the billing plugin share one field
  mapping).
- **Landing details**: `executionId = ${messageId}:${model.id}` (unique per fan-out
  execution; prompt streams get a uuid); prompt = trailing user message's text parts
  joined verbatim + base64 file parts as `ImageContent` (the history converter's shared
  `filePartContent`); history = the prepared list minus the trailing message;
  `prepareChatMessages` runs over the FULL served list with native support pinned to
  `{image: isVisionModel, pdf/audio/video: false}`; the attachment budget IS fed (the
  plan's entries are a valid `ToolSet` — `ToolEntry.tool` is an SDK tool) using the
  pi-effective output cap; `toolResultTruncation` is present ONLY when
  `contextSettings.enabled && contextOwner !== 'caller'` with the legacy reservation
  formula, `canOffload` from the plan's four-part gate, while
  `requestContext.persistedOutputPaths` is seeded UNCONDITIONALLY (fs_read's allow-list
  is not the offload gate); the request-level output cap is patched into the materialized
  provider config's model entry (legacy's adjust-for-reasoning is not ported — pi manages
  its own reasoning budget); accounting mirrors the legacy pair's SHAPE
  (`aiUsageRecordService.recordInvocation` with the shared capture context +
  `AnalyticsService.trackTokenUsage` with `tokenUsageSource ?? 'chat'`) — with two deltas
  the W6 fresh-eyes review caught: provider-reported COST is dropped (pi's `Usage.cost`
  never maps into `providerCost`; the capture context carries
  `trustProviderReportedCost`/`reportedCostCurrency` but the value never arrives — the
  agent path has the identical drop), and analytics fires PER PROVIDER INVOCATION where
  legacy's hook merges per-step usage into one per-turn event flushed even on error turns
  (token sums equal; event counts and error-turn telemetry differ);
  `thinkingLevel`: `omit`→absent, `default`/`auto`→absent (pi's model-side default =
  closest to "provider decides"), `none`→`off` (the engine request type widened to pi's
  `ModelThinkingLevel`), tiers map by identity; approvals wire
  `onApprovalResolved` → `AiStreamManager.resolveToolApproval(topicId, …)`.
  Seam-preparation errors (plan resolution, materialization, surface building) FAIL the
  turn rather than falling back — deliberate: everything thrown before
  `streamPiChatTurn` is pre-provider-request, and silent fallback would mask engine
  bugs during dogfood; a scoped try/catch-with-warn is the pre-default-on softening.
- **Deliberate gaps recorded in the register** (new/updated rows below): no retry/
  fallback on pi turns yet; no steer early-yield; translate/prompt streams are INCLUDED
  in flag scope (same callsite — the checklist's "verify or exclude" resolved as verify).


| Gap | Plan |
|---|---|
| Multi-model fan-out + branch overlays | Verified trunk-generic by analysis (dispatch = one execution per model; overlays render from accumulated parts via `canReuseSettledPart`, which is engine-agnostic; the engine-specific residue — dynamic/providerExecuted stamping, part payloads — is what W4a's projection and the citations widening handle). The W6 per-level checklist owns the live verify (multi-model topic, branch/merge are already items) |
| Retry/fallback model chains | pi-internal session auto-retry disabled for chat (single-owner rule holds engine-side). **W6 gap recorded**: the host `createRetryableWrap` is `LanguageModelV3`-shaped and does NOT wrap pi turns — a pi-routed request has no same-key failover, no transient retry, no cross-model fallback, and emits no `data-retry` parts; a transient 429/5xx ends as an error row the user retries manually. Excluding fallback-configured/multi-key requests at the gate was rejected (it would shrink dogfood to near-zero). A turn-level host wrap (re-invoke the engine before first content) is the port needed before default-on |
| Provider-native server-side web search | **Accepted delta**: pi-ai has no `providerOptions` plugin surface. Chat web search served via the MCP `web_search` tool on the pi path; provider-native search remains only on the legacy path until that path dies. Documented UX delta, not a blocker |
| Attachments | **Landed in W6**: the seam runs `prepareChatMessages` over the whole served list with native support pinned to pi's expressive set — image per model vision, pdf/audio/video forced to extracted text — and feeds `resolveAttachmentBudget` from the plan's selection (`ToolEntry.tool` is a valid `ToolSet` member) with the pi-effective output cap. Budget deltas (W6 review): the tools input is the UNCOLLAPSED registry selection, where legacy feeds the defer-exposed set — a defer-mode assistant reserves more schema space on pi (consistent with defer-mode not shipping on pi); the output-cap input is the raw requested value, not legacy's adjust-for-reasoning. Image + PDF + non-vision-image (OCR) live checks belong to the per-level checklist |
| Citations / sendSources | **Landed**: renderer resolution widened to the chat-pi builtin part shape; `tool_invoke` replay maps to the inner citable tool. Provider-native `source-*` has no pi equivalent (accepted delta row above). W5 review fix: the widener read `providerMetadata`, where the AI SDK accumulator NEVER puts a tool chunk's stamp (tools get `callProviderMetadata`/`resultProviderMetadata`) — the branch could not fire for the engine it was written for and pi-chat lookup citations resolved to nothing; the part-level read is now shared with the tool renderer (`extractToolMetadataFromPart`) and the test fixture uses the runtime shape |
| Reasoning effort / service tier / fast mode | **Landed in W6**: the seam maps chat reasoning to pi's `ThinkingLevel` — `omit` and `default`/`auto` send nothing (pi's model-side default), `none` → `off` (request type widened to `ModelThinkingLevel`), tiers by identity. Recorded qwen delta: pi's qwen dialect emits `enable_thinking: !!thinkingLevel`, so an omit-kind turn sends `enable_thinking: false` where legacy sent no parameter — verify per host at dogfood. Budget-dialect models map by tier and let pi translate; spot-check item. Service tier / fast mode have no pi surface — accepted delta until a request-options port |
| Defer exposition (`tool_search`) | Port `piCodeMode` catalog for chat when tool counts demand it; v1 ships without (chat tool sets are small). Legacy defer-mode turns replay correctly via the `tool_invoke` mapping; `tool_search`/`tool_inspect` parts replay as digest-renamed undeclared calls (cosmetic — their outputs are text) |
| Steering semantics | Chat steer = enqueue + yield + chained continuation (host-owned, engine-agnostic). **W6 recorded mechanical gap**: legacy yields EARLY via the `steerYield` stop condition; pi has no clean "end turn now" lever (abort persists as `paused`, which is worse), so a steer waits for the turn's natural end before the continuation dispatches — correct eventual content, later steer latency. A pi-native steer port (or an engine lever) is pre-default-on material |
| Per-execution matrix gate | **Landed in W6** (`runtime/piChat/chatTurnSeam.ts`): flag → exclusions (see the W6 record) → provider-injection try; every exclusion falls back to legacy with an info log. The gate covers translate/prompt streams and the gateway's SSE requests too (same `streamText` callsite — "rides the flag from day one"); gateway requests carrying client tools are excluded until pi has client-tool semantics |
| Request-level output cap | **Landed in W6**: the seam patches `requestedMaxOutputTokens` into the materialized provider config's model entry (the injection carries only the model-level cap; without the patch the assistant/callOverrides setting was inert on pi). Legacy's `adjustMaxOutputTokensForReasoning` is NOT ported — pi derives its own reasoning budget — so budget-dialect models are a spot-check item |
| Translate / prompt streams | **In flag scope (W6 decision)**: same `streamText` callsite, so translate, naming probes and the gateway ride the gate; assistant-less turns take `resolveToolCallLimit(undefined)` = 20 and reason from `request.reasoningEffort`; sampling via `callOverrides` (temperature/topP) remains the accepted no-pi-surface delta. Live verify belongs to the per-level checklist |
| Replayed step boundaries | **Landed**: per-step assistant entries + shared inferable-boundary restoration. Accepted delta (W5 review): a step that converts to no content is DROPPED, where legacy emitted an `'...'` placeholder assistant turn (`messageRules.ensureNonEmptyAssistantContent`) — the safer shape, but not byte-equivalent |
| Replayed tool-result rendering (builtin outputs) | **Landed** for web/kb/painting/read_file/fs_read (declared-gated dispatcher in `messages/builtinToolResultViews.ts`). Remaining lossy rows, by design: `browser_*` outputs are MCP-shaped → screenshot placeholders (same acceptance as the W1 MCP row); `mcp_resource_read`'s view is async disk-reading → JSON text. Accepted delta (W5 review): a STRING output replays verbatim before the declared view runs, where legacy called the view with a string (for `read_file`/`web_fetch` that yields a `value: undefined` text block) — pi's short-circuit is the safer shape |
| Reasoning signature replay (non-anthropic families) | **Landed in W3**: google (`thoughtSignature` on reasoning/text/tool parts) and openai-responses (`itemId`+`reasoningEncryptedContent` → reconstructed reasoning item) replay via the converter; pi-written turns round-trip through `providerMetadata.pi` signatures persisted by `piStreamAdapter`. Wire-probed same-model vs cross-model per family. Cross-model treatment (pi strips tool-call `thoughtSignature`, normalizes tool-call ids) is pi's own |
| Redacted thinking replay | **Fixed in the W3 review**: pi persists `redacted: true` beside `pi.thinkingSignature`, the converter resolves the flag for both writers (`anthropic.redactedData` for legacy turns) and keeps a signature-only block, so Anthropic receives `redacted_thinking` instead of an invalid signature. The legacy engine replaying a pi-written redacted turn still drops the block (its `reasoningMetadata` has no `signature`/`redactedData` key — a logged warning, not an error): see the W6 flip-back clause |
| Flag flip-back reasoning replay | **Decision: accept for the flag period** (the Phase 1 exit closes it). Dual-writing family keys from the pi adapter would need family knowledge in an engine-agnostic module and risks conflicting with pi's own semantics; the loss — signed-thinking continuity for a turn after flipping back — is a dogfood-only artifact |
| Google family proxy transport | pi-ai's google adapter rejects custom fetch (drives `@google/genai`'s client), so `PI_API_SUPPORTS_CUSTOM_FETCH['google-generative-ai'] = false` — no Electron session sharing and no `net.fetch` there; the Cherry proxy **env is still passed** (only the Node dispatcher could read it, and the google client uses the plain Node fetch). Requests ride the Node dispatcher directly; if that breaks proxy users, the port is a pi-ai change (fetch support in the google adapter), not a Cherry workaround |
| Anthropic cache user knobs | pi places `cache_control` natively (system + last tool + trailing message), `cacheRetention` a per-request stream option (`"none"\|"short"\|"long"`, default `short`). Optional seam port maps the ttl setting → `cacheRetention` (injectable at the materialized `streamSimple` wrapper); Cherry's threshold/last-N knobs stay inert |
| Mid-loop tool-output truncation | **Landed (W6 wired the knob)**: opaque lane at the tool-result boundary, Offloader-composed (byte-identical markers), `truncatable:false` exempt. The unit is the result's TEXT — the text blocks of a `content` view joined by `\n`, exactly aiCore's `extractText` input (W5 review fix: per-block truncation silently skipped a multi-block view whose blocks were each under the threshold) — and image blocks survive, which legacy did not (it replaced the whole output with the truncated text). Excerpt sizes are single-sourced (`TOOL_OUTPUT_EXCERPT_{HEAD,TAIL}_CHARS`, shared with the persist lane, W5 review). The seam fills `RequestContext.toolResultTruncation` ONLY when `contextSettings.enabled && contextOwner !== 'caller'` (a present knob with the context-build layer off would truncate-and-discard where legacy sends the full output), `canOffload` rides the plan's four-part gate, and `persistedOutputPaths` is seeded unconditionally (fs_read's allow-list). Deferred deltas: the per-entity codec lane (an oversized web_fetch page truncates as broken-JSON head/tail), and re-truncation of oversized HISTORY results that were never persist-trimmed (they ride full via the converter) |
| In-loop compaction inside pi's loop | Cherry's `prepareStep` compaction cannot run inside pi's tool loop; turn-start durable compaction is upstream and unaffected. **Accepted gap** — now bounded: the tool-call cap + the in-flight threshold landed above are the loop's hard limits, and pi's OWN auto-compaction is disabled for chat (W5 review: it defaulted ON and would have run pi's summarizer inside a chat turn — an extra provider invocation and an invisible context rewrite; the agent path keeps it) |
| DeepSeek DSML tool calls | some DeepSeek deployments emit tool calls as DSML markup in text; pi has no parser, so those tool calls stream as visible markup and never execute. **Deferred with that failure signature**: dogfood tolerable, but default-on needs either the stream-wrapper port in `materializePiProviderStream` (it must also rewrite the settled AssistantMessage, unlike the legacy chunk-level plugin) or a matrix exclusion keyed on the affected models |
| Inline `<think>` reasoning extraction | **Landed** (chunk-level twin, openai-completions-gated, model-derived tag) — with one recorded delta (W5 review): the sink rewrites the UI dialect only; pi's settled `AssistantMessage` keeps the RAW tags, so a within-turn continuation re-sends them as visible assistant text (legacy's provider-level middleware never had this — its next model call sent tag-free steps). Closing it needs a settled-message rewrite, the same class of port as the DSML row; needed when multi-step tool loops on tag-emitting servers matter |
| DeepSeek Responses reasoning replay (#18150) | pi drops UNSIGNED thinking on responses replay; DeepSeek's responses dialect requires reasoning passed back. Synthesize a raw reasoning item from persisted text for that dialect, or matrix-exclude it. **Deferred — needs a live probe** against the deployment (the synthesized item's acceptance is unverifiable offline); W6 spot-check item |
| Non-streaming providers | `streamSimple` is SSE-only: `capabilities.streamOutput === false` providers must FAIL the matrix gate to legacy (the W6 seam checks this — it is not keyed on endpoint type) |
| Qwen on nvidia/gpustack (pi path) | **Landed**: the `/think` suffix dialect rides `resolveUserThinkingSuffix` |
| OpenRouter `[REDACTED]` blocks / HF signed replay | Split disposition. OpenRouter's `[REDACTED]` strip is cosmetic → deferred wrapper. HF's strip-reasoning-replay is a **hard 400** (the router rejects any reasoning input item): a pi-written signed same-model turn replayed on HF fails the request outright — the seam must matrix-exclude that combo until the port lands |
| ovms `/no_think` | **Landed**: the suffix dialect rides `resolveUserThinkingSuffix` (final-text-block scope, MCP-tools gate) |
| Stop-reason `length` policy | **Decided + landed**: chat finishes successfully at `finishReason: 'length'` (legacy parity; gateway maps it per family). The agent path keeps failing the turn — a deliberate divergence annotated in the Phase 3 drift table |
| Trusted terminal-failure surface | **Landed**: engine-level `ToolLoopTerminalError` (localized error row, `i18nKey` carried), ANY-occurrence semantics, verdict-before-mapping; the tool-call cap shares the machinery. On detection the engine ABORTS at the `turn_end` following the batch (W5 review fix — pi's every-result `terminate` rule alone would keep a mixed batch's loop alive and burn further model calls): the batch's results settle on the card, the verdict then fails the turn. All-terminate batches never reach the model at all (pi stops the loop itself). Two probed costs (W5 review): pi's loop has no abort check before its next `streamAssistantResponse`, so ONE more provider request is issued and self-aborts pre-flight (an extra phantom step boundary + provider span, nothing rendered or billed by a signal-honouring provider); and the count is per-turn where legacy re-dispatched per approval, so legacy could exceed the cap across resumes |
| Tool `outputSchema` validation | **Row corrected — no gap**: the AI SDK never validated `outputSchema` on the execute path (`ai@6` `executeToolCall` returns output raw; the only validation, `safeValidateUIMessages`, is unused by Cherry). Legacy baseline is unvalidated; porting a validator would make pi stricter than legacy. Contract enforcement stays where it is (ad hoc, e.g. knowledgeLookup's score clamp) |
| Resumed-session reasoning replay (agent path) | The agent connection names the provider `${providerId}:${sessionId}:${generation}` and rewrites the pi api per generation, and pi stores those names in session JSONL — so after a resume every replayed assistant message is cross-model and signed thinking degrades to text. Chat fixed this by owning the descriptor (`isSameModelAsTurn`); the agent path needs the same identity treatment (fits the unification, see Phase 3) |
| Tool-call cap (agent path) | W5 gave CHAT the loop bound (`ToolLoopTerminalError` + the engine's counter); `PiRuntimeConnection` has none, and pi has no native cap — an agent session can loop unbounded. The machinery is now shared (`tools/toolLoopTerminal.ts`); the agent path needs the same counter (its `turn_end` handler already tracks turns) — Phase 3 consolidation item |
| Tool timing in `runtimeTiming` (pi chat) | **Landed**: the engine feeds the trunk sink from `tool_execution_start/end` (wall-clocked); approval spans were already trunk-side. The approval WAIT is subtracted back out (W5 review — pi starts the span before the gate runs, the collector's contract excludes approval latency) |
| `timeThinkingMs` in usage metrics | **Landed**: measured in `withPiInvocationCapture` (legacy billing semantics), both pi paths |
| Provider-reported cost on pi turns | **Dropped (W6 review finding)**: pi's `Usage.cost` is never mapped into `recordInvocation`'s `providerCost`, so `reportsActualCost` providers lose cost attribution on pi (the agent path drops it identically). The capture context already carries `trustProviderReportedCost`/`reportedCostCurrency` — map `usage.cost` → `providerCost` at the engine/seam before default-on |

**W6 — Rollout flag.** First merge LANDED (2026-09-27 — see the W6 record above the
register): `chat.pi_engine.enabled` (default OFF), the per-execution gate + seam, and the
Developer-group toggle. Remaining ladder, each level its own merge: dogfood (flip it on;
this fork has no team-topic concept) → default on (requires the matrix fully green AND the
register's pre-default-on owners resolved: retry/fallback turn-level wrap, steer
early-yield, DSML port-or-exclude, HF port, DeepSeek responses probe, think settled-message
rewrite) → remove the legacy path. The flag resolves **per-execution** with silent logged
legacy fallback while the matrix is incomplete (see architecture decisions).
Per-level manual checklist: plain send; tool call + approval; image attachment;
multi-model topic; regenerate; branch/merge; abort mid-stream; kill the app
mid-stream and relaunch (attach + persistence); translate feature (INCLUDED in flag
scope — verify at each level); API-gateway round-trip (the public SSE contract rides the
engine from day one; tool-carrying gateway requests gate-exclude); a topic written
with the flag on, then replayed after flipping the flag back off — the pi engine
stamps tool parts `providerExecuted`/`dynamic`, which the legacy conversion treats
differently, and its reasoning replay lives under `providerMetadata.pi`, which the
legacy providers cannot read (they look for their own keys, so the reasoning part is
dropped with a logged warning — no error, but signed-thinking continuity is lost for
that turn; see the register's redacted-thinking row).

**W6 seam — request→engine-input preparation — LANDED** (`runtime/piChat/chatTurnSeam.ts`;
the engine takes prepared input on purpose; these were the obligations that used to be
implicit, from the W2 review):

- Provider: `resolvePiProviderInjectionFromSnapshot` → `materializePiProviderStream` — the
  returned `streamSimple`/config is the complete transport (compat wrappers, Cherry proxy
  env, Electron fetch); hand `{name, config, apiKey, modelId}` to the engine and do not
  wrap (the seam additionally patches the request-level output cap into the model entry).
  The per-execution matrix gate resolves IN the seam (flag → exclusion rows → the
  injection try itself); the ovms keep from the original sketch is obsolete — the suffix
  port landed in W5.
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
- Tools: `toPiChatToolSurface(registry.selectActive(scope), context, { approvalScope:
  'pi-chat:<executionId>', onApprovalResolved })` → `{ tools, authorizer }` — one call so
  the gate and the definitions share one selection and one context (the W4a review's
  context bug). Wire `onApprovalResolved` to `AiStreamManager.resolveToolApproval(topicId,
  …)`: the shared responder's own call targets an agent topic and no-ops for chat (see
  the W4a record). The engine projects raw `details` as the part payload for every handed
  tool name — hand it registry entries only.
- The W5 engine knobs, which the seam resolves from the request's settings:
  `toolCallLimit` (REQUIRED — pass `resolveToolCallLimit(assistant)`; the engine has no
  default because the value hides two policies, the assistant's `maxToolCalls` (100) or
  assistant-less 20, and the count is per TURN, spanning approval pauses, where legacy
  re-dispatched per approval), `toolResultTruncation`
  (`{ thresholdChars: resolveInFlightTruncateThreshold(settings.truncateThreshold,
  model.contextWindow, outputReservation), canOffload: contextSettings.enabled &&
  contextOwner !== 'caller' && hasAnchorRow(request.messageId) && toolCallLimit > 1 }`,
  with `persistedOutputPaths` seeded from `RetainedContext` exactly as
  `buildAgentParams` does — and OMIT THE FIELD when `!contextSettings.enabled ||
  contextOwner === 'caller'`: legacy's whole context-build layer is off then and sends the
  full output, while a present knob makes the pi lane take the plain head/tail branch and
  DISCARD the oversized original. Same hazard inside the knob: `canOffload: true` without
  `persistedOutputPaths` skips the offload and discards silently — seed both or neither),
  and `userTextSuffix`
  (`resolveUserThinkingSuffix({ provider, model, reasoningKind, hasAssistant,
  hasExplicitReasoningEffort, mcpToolCount })` — absent when reasoning is `omit`;
  `mcpToolCount` must count MCP tools ONLY: legacy's ovms gate is `mcpToolIds.size > 0`,
  and a whole-tool-set count would inject ` /no_think` into every replayed user message of
  every ovms turn with any tool).

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
| Provider-invocation accounting | `recordProviderInvocation` | `buildInvocation` | shapes converge (`AgentRuntimeUsageInvocation`); `finiteTokenCount` exists 3× (dsh too); the responseId-less fallback id (`${timestamp}:${model}`) is shared too — same-ms invocations dedup-collide and drop a record |
| Provider span mapping | `startProviderSpan` | `startProviderSpan` | agent marks `error`/`aborted` calls `ERROR`, chat always `OK` — provider failures arrive as resolved messages, so chat's spans never go red |
| Turn verdict (stop reason / error extraction) | `handlePiEvent` + `finishPromptRun` | session-event handler + `turnVerdict` | same `turn_end` cast, `willRetry` reset, `lastErrorMessage`, identical `error` text; **`length` deliberately diverges (W5)** — chat finishes `finishReason: 'length'` (legacy parity, gateway contract), the agent path keeps failing the turn; consolidate knowingly, not by reflex |
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
- Phase 1: `src/main/ai/AiService.ts` (seam), new `runtime/piChat/` (engine + history
  converter + tool surface/approval + W5's `thinkExtraction`/`userThinkingSuffix`),
  `piStreamAdapter.ts`, `messages/` (converter input + W5's `builtinToolResultViews`),
  `contextBuild/inFlightTruncate.ts` (W5), `tools/toolLoopTerminal.ts` (W5 re-home),
  `src/main/ai/tools/adapters/aiSdk/registry.ts` (W4a source),
  `approvalExtension.ts` + `toolApproval/` (approval resume mechanics),
  `streamManager/` (unchanged — proof by diff).
- Phase 2: `packages/aiCore/src/core/runtime/executor.ts` (swap target), `src/main/features/apiGateway/proxyStream.ts` (contract freeze), `src/shared/data/types/` (D3), `src/renderer/hooks/useChatWithHistory.ts` (2.4).
