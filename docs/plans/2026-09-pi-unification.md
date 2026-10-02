# Pi Unification Plan — one engine for chat and work

Status (2026-09-28): **Phase 1 code complete, flag off, dogfood underway.**
Phase 0 done (0.6 manual smoke still pending). W1–W6 landed, group-reviewed, and
first-dogfood-fixed; chat turns CAN run on the in-process pi engine behind the
default-off `chat.pi_engine.enabled` preference (Settings → General → Developer).
Next: the rollout ladder below — dogfood → default-on (blockers named there) →
remove the legacy path. Phases 2–3 remain draft.

Decision context: pi (in-process, loop owned by us, `pi-ai` wire layer shared with
dsh) is the base for unification. dsh stays as an opt-in agent runtime behind the
existing driver registry (`src/main/ai/runtime/types.ts`,
`docs/references/ai/adding-a-runtime.md`).

Condensed 2026-09-28 from the per-workstream landing/review records; the
current architecture is documented in `docs/references/ai/*` (refreshed with the
engine gate). This file keeps what those cannot: the disposition register, the
roadmap, and the probe-derived facts that live nowhere else.

## Hard constraints

1. **Working app after every step.** Each step is PR-sized, merges green, and leaves
   both chat and work functional (a step may migrate only a slice, never break a slice).
2. **Chat must work after every step** — chat is the product's core; it is never the
   thing that's temporarily broken while "work" is being fixed, or vice versa after
   Phase 0.
3. **The trunk is engine-agnostic.** Trunk = `AiStreamManager`, stream listeners
   (`ai.stream.*` events), persistence backends, renderer transport. It all speaks
   `UIMessageChunk`; the pi side emits the same dialect via `piStreamAdapter`.
   Migration swaps the engine, not the dialect. One recorded exception: the W5
   citations widening (`extractToolMetadataFromPart`, shared reader) — the single
   Phase-1 renderer diff, justified by its register row; Phase 2 renderer work is
   measured against that precedent.
4. **No user data resets.** pi session JSONL and SQLite must survive each phase
   forward; schema changes only via appended migrations.
5. Rollback is always "revert the PR" or "flip the flag" — never "repair the database".

## Current state snapshot

| Fact | Value |
|---|---|
| Pinned pi versions | `@earendil-works/pi-ai` + `pi-coding-agent` 0.87.1, forced to the root pin via `pnpm-workspace.yaml` overrides |
| pi patches in `patches/` | `pi-ai` (keyed to the pin): add `ultra` reasoning effort — the only survivor; fetch-threading dropped at 0.83.0, #7540 backport dropped at 0.84.0 (both native upstream) |
| dsh coupling to pi upgrades | None at runtime — dsh's `pi-ai ^0.84.x` is inlined into `packages/dsh-bridge` dist at build time on its own lockfile lane. Zero code shared between `runtime/pi/` and `runtime/dsh/` |
| Chat engine | `AiService.streamText` → per-execution engine gate → legacy Vercel AI SDK engine (default) or pi chat engine (`runtime/piChat/`); see `docs/references/ai/core-architecture.md` |
| Work engine | `AgentSessionRuntimeService` → driver registry → `PiRuntimeConnection` (in-process) or `DshRuntimeDriver` (Bun child) |
| Family classification | Three compile-enforced homes: `ENDPOINT_PI_API` (endpoint→family), `loadPiApiStreamSimple` (family→loader), `PI_API_SUPPORTS_CUSTOM_FETCH` (family→transport) — a new member in any dimension is a typecheck failure |
| Test surface | `runtime/pi/*.test.ts` + `runtime/piChat/` (faux-provider engine suite), chat suites in `streamManager/`, `tools/`, renderer chat tests |

Scale reminder: 345 files / ~103K lines import the Vercel AI SDK union — that is
why full removal is Phase 2, not Phase 1. Phase 1 moved one thing: the chat-turn
engine.

---

## Phase 0 — Upgrade pi 0.80.x → 0.87.1 — COMPLETE

Every rung 0.81.1 → 0.87.1 landed with per-rung verification; full
`pnpm build:check` green at the tip (except six pre-existing provider-registry
catalog-sync failures, owner-decided). Session JSONL format verified stable
across the range (v3 at both ends; older versions migrated on read). Upgrade
procedure and patch state for future bumps: `docs/plans/2026-09-pi-upgrade-notes.md`.

**Still pending: the 0.6 manual smoke (cherry-electron-dev)** — the remaining
Phase 0 gate. Work checklist: new agent session; plain text turn; MCP tool call;
approval approve + deny; mid-turn steer; `/compact`; fork from message;
edit-resend; quit + relaunch + resume the same session; heartbeat/scheduled
task fires; one dsh session still runs; `pnpm smoke:dsh-runtime` green; one
normal chat message round-trips. Data-compat live confirmation: resume a
session created by the currently released app build. Rollback per rung: `jj
abandon`.

---

## Phase 1 — Chat engine on pi

Goal: normal chat topics execute on an in-process pi engine; the Vercel AI SDK
remains for auxiliary calls until Phase 2. **Code complete** — landed
workstreams, oldest first:

- **W1 — history converter** (`runtime/piChat/historyConverter.ts`): persisted
  `CherryUIMessage[]` → pi session entries, full part corpus, fidelity-matrix
  lossy-by-design where pi has no representation.
- **W2 — chat engine** (`runtime/piChat/chatEngine.ts`): in-memory `AgentSession`
  per execution (`SessionManager.inMemory` — no JSONL for chat), forced chat
  prompt, abort latched through `session.abort()`, usage → billing parity,
  Cherry-owned `pi.generate_content` spans under the trunk's root context.
- **W3 — provider coverage**: the compile-enforced family homes (snapshot
  table) + `runtime/pi/providerMatrix.test.ts` (registry sweep, builtin-stream
  loads, gateway parity). **The live spot-check per family in dev remains the
  manual half** — a ladder rung-2 requirement. The matrix's auto-detection
  case asserts only that our injection adds nothing for hosts pi detects
  (asserting pi's detection needs a `detectCompat` export pi-ai does not
  provide).
- **W4a — tool surface** (`runtime/piChat/chatToolAdapter.ts` +
  `chatToolApproval.ts`): one registry bridge (raw JSON Schema; `content` =
  the entry's model view, `details` = the raw execute output projected onto the
  part), MCP entries route through their REGISTRY execute, approvals held
  in-process through the engine-neutral `toolApprovalRegistry`. Known-benign:
  a denial can reach the trunk twice (the trunk's `onApprovalResolved` write
  and the engine's blocked-call translation) — both writes are idempotent.
- **W5 — parity ports**: terminal-failure + cap machinery re-homed to
  `tools/toolLoopTerminal.ts`; `contextBuild/inFlightTruncate.ts`;
  `messages/builtinToolResultViews.ts`; `thinkExtraction.ts`;
  `userThinkingSuffix.ts`; renderer citations widening (constraint-3 exception).
- **W6 — seam + flag** (`runtime/piChat/chatTurnSeam.ts` +
  `src/main/ai/chatTurnPlan.ts` + the `streamText` branch): the engine gate
  (flag → exclusions → provider-injection try; `null` ⇒ legacy, logged), the
  engine-agnostic `resolveChatTurnPlan` both engines consume, the Developer
  toggle. First dogfood run fixed two immediate bugs (pi session-id charset —
  sanitized for the session key only; a pre-existing ErrorBlock missing-key
  log on custom provider ids).

A six-perspective group review (2026-09-27) passed over the whole changeset;
its fixes are in the code, its register rows are merged below.

### Architecture decisions (settled, still governing)

- The chat engine is **not** a driver-registry entry — the registry models
  long-lived session-ful connections; a chat turn is stateless per execution.
  `'chat-turn'` stays a reserved capability in `runtime/types.ts`; formalize
  only if chat grows session semantics (Phase 3).
- The engine is built on pi's `AgentSession`, not pi-agent-core's `Agent`:
  `piStreamAdapter` consumes `AgentSessionEvent`s, and the approval-extension
  pipeline + provider extension reuse as-is.
- No `ChatEngine` interface for the flag period — the seam signature
  (`streamText(request) → ReadableStream<UIMessageChunk>`) IS the interface.
- Fan-out stays trunk-owned: one `StreamExecution` per model → one engine per
  execution; the two engines may coexist in one multi-model topic during
  dogfood.
- The gateway rides the flag from day one (its SSE contract follows the
  engine); gateway spot-checks belong to the per-level checklist, not Phase 2.
- Provider mapping stays at two implementations (aiSdk config + pi); dsh's
  parallel `modelInjection` is the Phase 3 outlier.

### Disposition register

One row per feature/gap; statuses are `landed / accepted-delta / deferred /
pre-default-on / dogfood-verify / excluded-at-gate`, plus compound variants
(`landed + residuals`, `no gap`, `native`, …). Probe-derived facts that
live nowhere else are stated in the row. Code-covered mechanics point at their
homes.

| Feature / gap | Status | Disposition |
|---|---|---|
| Stop-reason `length` | landed (decision) | Chat finishes `finishReason:'length'` (legacy parity; gateway maps per family — pi's error row broke the public contract). **Agent path keeps erroring — deliberate divergence** (drift table) |
| Trusted terminal failure | landed | Engine-level `ToolLoopTerminalError` (localized row, `i18nKey` via serializeError), ANY-occurrence, verdict-before-mapping. pi stops only when EVERY batch result terminates (legacy: ANY) → the engine aborts at the following `turn_end`; residual cost is the phantom-request row |
| Tool-call cap | landed | Engine-owned (pi has no native cap; hooks can't end runs), `toolCallLimit` required (assistant `maxToolCalls`=100 / assistant-less=20 — two policies, no silent default). Count is per-TURN; legacy re-dispatched per approval and could exceed the cap across resumes |
| pi auto-retry / auto-compaction | landed | Both disabled engine-side (`SettingsManager.inMemory`); retry's single owner is the host wrap (which does not yet wrap pi — see retry row). Compaction OFF for chat only: pi's default-on summarizer inside a chat turn would be an invisible context rewrite; the agent path keeps it |
| `timeThinkingMs` / tool timing | landed | Both pi paths fill legacy-billing `timeThinkingMs`; the trunk sink is fed from `tool_execution_*` events with the approval wait subtracted |
| Inline `<think>` extraction | landed | Chunk-level twin of the SDK middleware (openai-completions-gated, model-derived tag). The settled-message rewrite landed with it (owner decision 2026-10-02): a `message_end` extension rewrites pi's settled `AssistantMessage` into thinking blocks, so within-turn continuation re-sends structured reasoning, never raw tags |
| Replayed step boundaries | landed + deltas | Per-step entries + shared boundary restoration. Deltas: a content-free step is DROPPED (legacy emitted `'...'`); a string tool output replays verbatim before the declared view; `finish-step` is deliberately un-emitted (no consumer reads step-finish parts, gateway SSE ignores both step chunks — revisit only if a consumer ever keys on step ends) |
| Replayed builtin tool views | landed + deltas | Declared-gated dispatcher (`messages/builtinToolResultViews.ts`). Lossy by design: `browser_*` → screenshot placeholders; `mcp_resource_read` → JSON text |
| Prompt-suffix dialects | landed | `resolveUserThinkingSuffix` (qwen `/think`·`/no_think` every-text-part; ovms `/no_think` final-block, MCP-tools-gated — count MCP tools ONLY) |
| Mid-loop tool-output truncation | landed + deferred | Joined-text unit (aiCore `extractText` semantics), image blocks survive, Offloader byte-identity, knob present only when context-build is on; `persistedOutputPaths` unconditional (fs_read allow-list ≠ offload gate). Deferred: per-entity codec lane (code notes in `inFlightTruncate.ts`); re-truncation of oversized HISTORY results never persist-trimmed — they ride full via the converter |
| Citations | landed | Renderer widening = the one Phase-1 renderer diff (constraint 3). `tool_invoke` replay maps to the inner citable tool; provider-native `source-*` has no pi surface (accepted delta) |
| Reasoning signature replay | landed | google (`thoughtSignature` on reasoning/text/tool parts) + openai-responses (`itemId`+`reasoningEncryptedContent`) + pi-written round-trip via `providerMetadata.pi`; wire-probed same-model vs cross-model per family. Residual: the skip-gemini-thought-signature sentinel needs a port only for gemini-via-openai-compat (pi's openai-completions injects none) |
| Redacted thinking replay | landed | Both writers resolved to a signature-only block (anthropic `redacted_thinking`). Legacy replaying a pi-written redacted turn still drops the block (logged, no error) — flag-flip-back clause |
| Converter known debts | deferred (visible-if-triggered) | `timestampMs` yields NaN for a malformed `metadata.createdAt` (in-memory entries only, inert); a terminal part whose output is absent replays as the literal text `undefined` |
| Flag flip-back (pi-written → legacy) | accepted-delta | `providerExecuted`/`dynamic` stamps and `providerMetadata.pi` are unread by legacy providers; reasoning drops with a logged warning. Accepted for the flag period; the Phase 1 exit closes it |
| `outputSchema` validation | no gap | `ai@6` NEVER validated outputSchema on the execute path (only `safeValidateUIMessages`, unused). Legacy baseline = unvalidated — a pi-side validator would be stricter than legacy, not parity. Don't "fix" |
| tool_invoke unwrap | landed | `tool_invoke`/`tool_search`/`tool_inspect` are wire-legal (`WIRE_TOOL_NAME`); legacy replayed them verbatim as undeclared calls. The pi unwrap keeps the call paired to a declarable name and restores the legacy argument shape |
| anthropic cache | native + optional port | pi places `cache_control` itself (system + last tool + trailing message), `cacheRetention` option (`none\|short\|long`, default short). Cherry's threshold/last-N/budget knobs are inert; optional seam port maps the ttl setting → `cacheRetention` |
| anthropic headers / gateway usage / tool-schema / devtools | native / N/A | pi sends interleaved-thinking + merges beta headers; usage normalized by pi-ai; google rides full `parametersJsonSchema` (no strict mode); AI-SDK devtools is middleware-shaped — dropped on pi turns |
| Google custom fetch / proxy | accepted-delta | pi-ai's google adapter rejects custom fetch (`PI_API_SUPPORTS_CUSTOM_FETCH`); proxy env still passed, requests ride the Node dispatcher — no Electron session sharing there. Fix, if proxy users break, is a pi-ai change |
| Same-model replay descriptor | landed | Engine-owned (`isSameModelAsTurn`) because the per-execution provider name is engine-internal; suppressed on thinking-off anthropic turns (signed thinking on a disabled request is rejected) |
| Engine gate (W6) | landed | Flag → exclusions → provider-injection try, in the seam. Excluded: `streamOutput=false`; continue-conversation and any assistant-terminated list; gateway client tools; `apiKeyOverride`; huggingface (router 400s reasoning input on both protocols) until its port; gateway-routed (cherryin) providers; server-routed web search (provider-native search has no pi surface; legacy keeps serving); unsupported/missing-key at injection. NOT excluded: ovms (suffix landed), DeepSeek responses (live probe), DSML (dogfood-tolerable). Excluding fallback-configured/multi-key requests was rejected — it would shrink dogfood to near-zero. Seam-preparation errors (plan resolution, materialization, surface building) FAIL the turn rather than falling back — deliberate, so silent fallback cannot mask engine bugs during dogfood; a scoped try/catch-with-warn is the pre-default-on softening |
| Provider-native server-side web search | accepted-delta | pi-ai has no `providerOptions` surface; chat web search on pi is the MCP `web_search` tool only. Provider-native search survives on the legacy path — and becomes permanently absent when the legacy path dies at Phase 1 exit |
| Translate / prompt streams | in scope (verify) | Same `streamText` callsite, so translate/naming/gateway ride the gate; assistant-less turns take the 20 cap and reason from `request.reasoningEffort`. Per-level checklist owns the live verify |
| Attachments | landed + deltas | Native support pinned to `{image: vision, pdf/audio/video: false}` (pi user content is text+image; a "native" PDF would degrade to a filename note); budget fed from the plan's registry selection — the UNCOLLAPSED set, so a defer-mode assistant reserves more schema space on pi — with the request's output cap |
| Request-level output cap + sampling | landed + residuals | Output cap patched into the materialized provider config (kept: the StreamOptions `maxTokens` half duplicates it for anthropic's total-cap math — do not delete one half). Sampling rides `StreamOptions` (`temperature`, `samplingParams` by alias, legacy precedence via the shared gates — `samplingParams` is applied by pi's openai-compatible adapters only); residuals: `topP` inert on anthropic/google (port = family mapping or pi-ai ask), provider-scoped custom body params dropped, adjust-for-reasoning not ported, service tier / fast mode have no pi surface (port with a request-options pass) |
| Reasoning `omit`/`default` | dogfood-verify | pi seeds an absent `thinkingLevel` to its own `medium` (probed; clamps UP on tiered vocabularies) — there is no "provider decides" sentinel. Amended mapping: tiers identity, `auto`→explicit `medium` (auto means thinking-ON in Cherry), `none`→`off`, `omit`→`off` on anthropic only (expressible + faithful). google (dynamic default), qwen (deployment default), openai tiered ride pi's medium — verify per host at dogfood. A tiered model without `none` in its vocabulary cannot express off — the level stays absent on purpose |
| Thinking-off × signed replay | dogfood-verify | Anthropic fixed engine-side (descriptor suppressed). Google keeps same-model signed replay with thinking disabled — unprobed; if it 400s, widen the guard (one-line condition) |
| qwen `enable_thinking` | landed + residuals (dogfood-verify per host) | Native `thinkingFormat:'qwen'` gated by the shared `isQwenModel` + deny-list predicate. Residuals: hosts pi detects keep pi's dialect (verify per host at default-on); pi always sends the parameter (legacy omitted it for `omit`); preset-id + mirror-host + qwen skips our override while pi detects nothing (fix needs a `detectCompat` export) |
| Retry / fallback | pre-default-on | The host wrap is `LanguageModelV3`-shaped and does NOT wrap pi turns — no key failover, transient retry, cross-model fallback, or `data-retry` parts; a transient failure is an error row the user retries manually. A turn-level host wrap (re-invoke before first content) is the port |
| Steering | accepted residual (owner 2026-10-02) | Host-owned enqueue + yield + chain. pi has no clean "end turn now" lever (abort persists as `paused`, which is worse) — a steer waits for the turn's natural end. Correct eventual content, later latency; pi-native steer is the tracked follow-up |
| Phantom request after cap/terminal abort | accepted residual (owner 2026-10-02) | pi's loop has no abort check before its next `streamAssistantResponse` — one more provider request issues and self-aborts pre-flight (phantom step boundary + span, nothing billed by a signal-honouring provider). `finishTurn {action:'end'}` would end the run cleanly but is not extension-reachable in 0.87.1 — an SDK surface request, not a Cherry workaround |
| Provider-reported cost | landed | pi's `Usage.cost` (computed from pi's per-million USD rates, cache buckets + tiers) maps into `providerCost` on all pi lanes via `runtime/pi/piCost.ts`; a zero total means "no pricing known" and keeps the app-side computed fallback. Note: the raw provider-reported figure the ai-sdk lane surfaced for some providers is gone — the label now means "serving-runtime-computed". Usage-record rows themselves cover error/aborted turns (deliberate billing parity); analytics events fire per invocation where legacy merged per turn |
| DeepSeek DSML tool calls | deferred (owner 2026-10-02) | Some deployments emit tool calls as DSML markup in text; pi has no parser — they stream as visible markup and never execute. Owner chose matrix-exclude at default-on, but the legacy engine's deletion in the same series leaves that exclusion no fallback target — post-deletion these deployments stream markup as text (documented divergence, dogfood-tolerable); the parser + settled-message port remain deferred |
| DeepSeek responses replay (#18150) | deferred (live probe) | pi drops UNSIGNED thinking on responses replay; DeepSeek's responses dialect requires reasoning passed back. Synthesize a raw reasoning item from persisted text, or matrix-exclude — the synthesized item's acceptance is unverifiable offline |
| OpenRouter `[REDACTED]` strip | deferred (cosmetic) | Wrapper port; display-only |
| HF signed reasoning replay | excluded-at-gate | Hard 400 (row above); lift the exclusion when the port lands |
| Defer exposition (`tool_search`) | deferred | Port the `piCodeMode` catalog when chat tool counts demand it; v1 ships without. Legacy defer-mode turns replay via the `tool_invoke` mapping |
| In-loop compaction | accepted-gap | Cherry's `prepareStep` compaction cannot run inside pi's loop; turn-start durable compaction is upstream and unaffected. Bounded by the cap + in-flight threshold |
| Multi-model fan-out + overlays | verified by analysis | Trunk-generic (overlays render from accumulated parts, engine-agnostic); the per-level checklist owns the live verify |
| pi lenient tool-input coercion | default-on checklist | pi's JSON-Schema path runs `Value.Convert` semantics — coerces primitives, drops optional nulls; a call legacy zod would reject can execute coerced. `Type.Unsafe` would not be stricter (both paths coerce) |
| `TOOL_INVOKE_TOOL_NAME` import | Phase 2 | The pi tree still imports one string constant from `tools/adapters/aiSdk/meta/toolInvoke` — re-home when Phase 2 deletes that dir |

### Rollout ladder

Landed rung: **flag exists, default OFF** — `chat.pi_engine.enabled` +
Developer-group toggle; a flag-off process pays nothing and the legacy path is
byte-identical (one recorded type cleanup: `sourceSnapshotForAssistant` emits
`icon: emoji ?? null`).

Remaining rungs, each its own merge:

1. **Dogfood** (now): the owner flips the flag; the gate logs every exclusion.
   Dogfood = manual flipping here — this fork has no team-topic concept.
2. **Default on.** Requires: the W3 live spot-check per family; the matrix fully
   green; the 0.6 smoke; and the pre-default-on register rows resolved —
   retry/fallback turn-level wrap, steer early-yield, DSML port-or-exclude, HF
   port, DeepSeek responses probe, think settled-message rewrite,
   provider-reported cost mapping, phantom-request SDK ask, seam-error scoped
   fallback softening — plus the dogfood-verify rows signed off per host.
3. **Remove the legacy path** (Phase 1 exit).

**Per-level manual checklist** (run at dogfood and again at default-on): plain
send; tool call + approval; image attachment; multi-model topic; regenerate;
branch/merge; abort mid-stream; kill the app mid-stream and relaunch (attach +
persistence); translate (in flag scope — verify); API-gateway round-trip
(tool-carrying gateway requests gate-exclude); pi lenient coercion behaviors;
a topic written with the flag ON, then replayed after flipping it back OFF
(the flip-back clause above); steer latency (answers after turn end — expected
until the port).

### Phase 1 exit criteria

- Flag removed; legacy chat execution path (`runtime/aiSdk/Agent` +
  `buildAgentParams` chat consumption) deleted or reduced to what auxiliary
  calls still need.
- Every chat test suite green on the pi engine; the disposition register has
  no `deferred` row without an owner and no open `pre-default-on` row.
- Vercel AI SDK executes zero chat turns.

Rollback (until exit): flip the flag. After exit: revert the deletion PR.

---

## Phase 2 — Retire the Vercel AI SDK (staged, two open decisions)

**2.1 One-shot and stream-prompt calls → pi-ai.** `AiService` internals swap to
pi-ai stream/generate while the `AiService` facade stays identical — the ~24
caller sites (naming, translation, diagnosis, mini-app, …) don't change.
Special care: the local API gateway proxy (`proxyStream.ts`) is a public SSE
contract for external clients — its wire format must not move. Also re-home
`TOOL_INVOKE_TOOL_NAME` (register row).

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
- Single tool home: everything MCP (`cherry-tools` et al.), adapter layers
  deleted. Alternative pattern worth evaluating (from the dormant
  `CherryHQ/cherry-studio-pi` fork, June–July 2026): internal app operations as
  an in-process, risk-typed capability registry with search-over-capabilities +
  call-by-id tools (`AppSearchCapabilities`/`AppCallCapability` — same
  exposition shape as `piCodeMode`'s tool search).
- Provider-mapping consolidation: fold `runtime/dsh/modelInjection.ts` behind
  the pi mapper — after Phase 1 there are otherwise three parallel
  implementations (aiSdk provider config, `runtime/pi/`, `runtime/dsh/`).
- Single prompt/permission model: converge `buildAgentRuntimePrompt` and the
  chat prompt assembly.

**Consolidation drift table** — parallel copies between the chat engine
(`runtime/piChat/chatEngine.ts`) and the agent connection
(`runtime/pi/PiRuntimeConnection.ts`) that merge here. These are targets, not
bugs to patch now; consolidate knowingly, not by reflex:

| Policy | Agent connection | Chat engine | Drift to carry |
|---|---|---|---|
| Provider-invocation accounting | `recordProviderInvocation` | `buildInvocation` | shapes converge (`AgentRuntimeUsageInvocation`); `finiteTokenCount` exists 3× (dsh too); the responseId-less fallback id (`${timestamp}:${model}`) is shared — same-ms invocations dedup-collide and drop a record |
| Provider span mapping | `startProviderSpan` | `startProviderSpan` | agent marks `error`/`aborted` calls `ERROR`, chat always `OK` — chat's spans never go red |
| Turn verdict | `handlePiEvent` + `finishPromptRun` | session handler + `turnVerdict` | **`length` deliberately diverges** — chat finishes (legacy parity, gateway contract), agent errors; same for compaction (chat off) and the tool-call cap (chat has one, agent loops unbounded — its `turn_end` handler already tracks turns) |
| Provider teardown | `unregisterApiProvider` (vestige) | removed | dead on pi 0.87 — nothing registers under `provider:…` in the global api registry; low-risk, delete on touch |
| `tool_call` gate wrapper | `createPiApprovalExtension` | `createToolAuthorizationExtension` | near-identical shapes and emit ordering; chat adds gate-wait timing, denial translation, abort-cancellation drop — the piece most likely to be missed |
| Agent resumed-session replay | — | — | the agent connection names providers `${providerId}:${sessionId}:${generation}`, so replays are cross-model and signed thinking degrades to text; chat fixed this with the engine-owned descriptor — the agent path needs the same identity treatment |

One owner for the session lifecycle (build → seed → prompt → verdict → dispose)
is the single highest-value item — it removes the first four rows at once.

Open questions: does chat ever want warm sessions and resume tokens; does work
ever want multi-model fan-out; where do overlay branches and session forks unify.

---

## Verification & rollback matrix

| Phase | Automated | Manual smoke | Rollback |
|---|---|---|---|
| 0 (done) | per-rung suites + full gate at tip | 0.6 checklist (pending) | jj abandon the rung |
| 1 (code done) | converter corpus; faux-provider engine suite; provider matrix; tool round-trips; chat suites | per-level checklist | flag off |
| 1 exit | full `pnpm build:check` | both checklists | revert deletion PR |
| 2 each step | per-site suites; gateway SSE contract test | aux features (naming, translate, knowledge indexing, paintings) | revert step |

## Appendix — load-bearing files

- Phase 0 / upgrades: `src/main/ai/runtime/pi/*` (`PiRuntimeConnection.ts`,
  `piSdk.ts`, `piSessionFile.ts`, `piFork.ts`, `piTransportStream.ts`,
  `modelInjection.ts`), `patches/@earendil-works__*`,
  `src/main/ai/agentSession/` (resume-token hydration);
  `docs/plans/2026-09-pi-upgrade-notes.md` for procedure.
- Phase 1: `src/main/ai/AiService.ts` (gate branch),
  `src/main/ai/chatTurnPlan.ts` (engine-agnostic plan),
  `runtime/piChat/` (engine, seam, converter, tool surface/approval,
  `thinkExtraction`, `userThinkingSuffix`), `piStreamAdapter.ts`,
  `messages/builtinToolResultViews.ts`, `contextBuild/inFlightTruncate.ts`,
  `tools/toolLoopTerminal.ts`, `src/shared/ai/` (`piModelCompatibility`,
  `toolPartMetadata`), `toolApproval/`, `streamManager/` (unchanged — proof by
  diff).
- Phase 2: `packages/aiCore/src/core/runtime/executor.ts` (swap target),
  `src/main/features/apiGateway/proxyStream.ts` (contract freeze),
  `src/shared/data/types/` (D3), `src/renderer/hooks/useChatWithHistory.ts` (2.4).
