# Pi 0.80 → 0.87 Upgrade Notes — Phase 0 working record

Status: **ladder complete** (2026-09-26) — pins rode 0.80.3/0.80.6 → 0.80.10
(including the 0.80.8 auth-refactor rewrite onto `ModelRuntime`, now behind the
`createIsolatedPiModelRuntime()` helper in `piSdk.ts`) → 0.81.1 → 0.82.x → 0.83.0 →
0.84.0–0.84.4 → 0.85.0–0.85.1 → 0.86.0–0.86.1 → 0.87.1 (the target), with patch
regeneration at every rung; that history lives in git. Remaining Phase 0 item: the
manual smoke checklist (unification plan §0.6).
Companion to [2026-09-pi-unification.md](./2026-09-pi-unification.md); research verified
against a local clone of `earendil-works/pi` (all `v0.8x` tags available for diffing).

## 1. Grounding facts

| Fact | Value |
|---|---|
| Pins | **final** — `pi-ai` 0.87.1, `pi-coding-agent` 0.87.1 (ladder target reached). The whole pi line (including transitive `pi-agent-core` and its `pi-ai`) is forced to the root pin via `pnpm-workspace.yaml` overrides — see §8 |
| Package ↔ dir mapping | one repo (`earendil-works/pi`), one version line: `packages/ai` → pi-ai, `packages/coding-agent` → pi-coding-agent, `packages/agent` → pi-agent-core; `pi-coding-agent` depends on same-line `pi-ai`/`pi-agent-core`/`pi-tui` |
| Cherry import surface | **entirely confined to `src/main/ai/runtime/pi/`** — all runtime (value) imports go through dynamic `import()` in `piSdk.ts`; every other file is `import type` only |
| pi test provider | `pi-ai/providers/faux` (engine tests run without network) — unchanged across the range |

## 2. Breaks by release (0.81 → 0.87.1)

"None" means verified by symbol grep, not assumed from the changelog.

| Version | Breaking change | Cherry impact |
|---|---|---|
| 0.81.0 | pi-agent-core: harness `SessionStorage` reworked; `uuidv7` moved to pi-ai; `Agent.streamFn` fallback → required `streamFunction` (removes pi-ai/compat from selective-provider bundles) | Resolved at the 0.81.1 rung: harness unused; Cherry's `uuidv7` comes from npm `uuid`, not pi; the `piLengthRecovery.test.ts` override was renamed to `agent.streamFunction` (0.81.1 restored the `streamFn` *constructor option*, but the instance field is `streamFunction`). `pi-ai/compat` still exports `unregisterApiProviders` |
| 0.82.0 | pi-ai `getBuiltinModelDataUrl()` → `getBuiltinModelDataGeneratedAt()`; harness `AgentTool` → context-aware `AgentHarnessTool` | None — both unused |
| 0.83.0 | TypeBox 1.3.7 bundled aliases: `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, `Value.Mutate` removed | None in our code — no TypeBox imports under `src/main/ai` (pi validates our JSON-schema tool definitions internally) |
| 0.84.0 | pi-agent-core harness session model → v4 lane-based `Session`/`SessionStorage`/`SessionRepo`; legacy harness JSONL/in-memory repos removed; JSON/RPC `message_update` wire events delta-only; `ModelRegistry.getApiKeyAndHeaders()` returns nullable `ProviderHeaders`; `ModelsStreamTransforms` → `ModelsRequestTransforms` | **None on Cherry's path** — see §5 (harness ≠ `SessionManager`; wire ≠ SDK events; `getApiKeyAndHeaders` unused). #7540 lands natively here → coding-agent patch droppable |
| 0.84.3 | pi-ai `GoogleThinkingLevel` → `GoogleApiThinkingLevel` | None — symbol unused in `src/` |
| 0.84.4 | pi-agent-core `prepareNextTurn*` hooks run only before another turn; harness manual-drive APIs removed | None — hooks unused |
| 0.85.0 | pi-ai `createGatewayBindingFetch()` → `createAiBindingFetch()` | None — unused. **Upstream packaging bug #9132**: the coding-agent barrel re-exported CLI `main`, whose `experimental/server.js` imported the undeclared `@earendil-works/pi-server` — plain installs failed to import the SDK. Worked around for this rung with an explicit `pi-server@0.85.0` dep; 0.85.1 fixed the package (harness code excluded from dist, dep dev-only) and the workaround was dropped there. Additions matter later: `SessionManager.inMemory(cwd, opts, entries)` restores external entries — the Phase 1 chat engine's entry point; narrow `api`/`providers`/`utils` subpath exports |
| 0.86.0 | **pi-ai provider stream inputs `Context` → normalized `TranscriptContext`** — system prompt and tool declarations move into transcript system messages read via `getCurrentSystemPrompt()`/`getCurrentTools()`; `ToolCall.arguments`/`ToolResultMessage.details` restricted to JSON values; `ToolResultMessage` conditional type; `JsonValue` arrays readonly; coding-agent `user_bash` fails closed | **Resolved at the 0.86.0 rung** — production code needed zero edits (`ProviderConfig['streamSimple']` aliases picked up `TranscriptContext` automatically; we pass `model, context, options` through). All 11 type errors were test files hand-building `Context` literals; they now build branded contexts via pi's `normalizeContext()`. Adapters were verified JSON-safe by the suites. No `user_bash` handler exists in Cherry |
| 0.87.0 | pi-agent-core `shouldStopAfterTurn` removed → `finishTurn` returning `{action: "end"}`; coding-agent `ContextEditEntry` added to `SessionEntry` union; `SessionManager` canonical (assigning `session.agent.state.messages` no longer replaces request history); `TurnEndEvent` boundary fields + `AgentBeforeSettleEvent`; `ExtensionRunner.emit()` rejects `turn_end` | **Verified at the 0.87.1 rung** — none reach Cherry: no `shouldStopAfterTurn` use, no exhaustive `SessionEntry`/`ExtensionEvent` switches, no direct `agent.state.messages` assignment; typecheck + both suites green at the final pin |
| 0.87.1 | — (fixes only) | Verified — green at the final pin |

Minor releases not listed (0.81.1, 0.82.1, 0.84.1/2, 0.85.1, 0.86.1) are additive or
fix-only.

## 3. Break → touchpoint (all rungs resolved)

| Touchpoint | Breaks that reach it | Required action |
|---|---|---|
| `SessionManager` surface — `resolveSessionManager` (`open`/`create`), `piFork` (`getEntry`/`createBranchedSession`/`getSessionId`), `getLeafId()`, and `piSessionFile`'s direct `<timestamp>_<id>.jsonl` filename parsing | none — all signatures and the file convention verified identical at `v0.87.1` | None. The 0.85 fork fixes (compaction-boundary #8990, pre-settle #8937) landed upstream and passed `PiRuntimeConnection.sdkContract.test.ts` + the agentSession fork/publication tests unchanged at 0.85.0–0.86.1 |
| `PiRuntimeConnection` `loadPiAiCompat().unregisterApiProviders(sourceId)` | none — `pi-ai/compat` still exports `unregisterApiProviders` at 0.87.1 (verified at install; still slated for removal "eventually") | None |
| `piTransportStream.ts` + `modelInjection.ts` + `piThinkingReplay.ts` (`streamSimple` delegation, `onPayload` composition) | 0.86.0 `TranscriptContext` | **Resolved at 0.86.0** — zero production edits (context flows through untouched); test files build branded contexts via `normalizeContext()` |
| `piStreamAdapter.ts` (`session.subscribe` events) | none — SDK `MessageUpdateEvent` still carries `message` + `assistantMessageEvent`; the 0.84 delta-only change was the JSON/RPC wire layer, not SDK events. Behavioral drift only (§6) | None at upgrade; watch drift |
| `approvalExtension.ts`, `providerExtension.ts` (extension API) | none — `tool_call` handler shape and the `pi.registerProvider` extension form unchanged | None; 0.86 exported more event types than before, nothing removed |
| `piSdk.ts` dynamic imports (`.`, `pi-ai`, `pi-ai/compat`, `pi-ai/api/*`) | none — subpath exports intact through 0.87.1 | `piBundlingViability` green at 0.87.1 (library entry stayed modular through the 0.84.3 bundled-runtime move) |
| `piCodeMode.ts`, `piMcpToolAdapter.ts` (`ToolDefinition` JSON schemas) | 0.86.0 JSON-only `ToolCall.arguments`/`ToolResultMessage.details` | **Resolved at 0.86.0** — adapters already emit JSON-only values (MCP results are JSON by protocol); typecheck + suites green without edits |

## 4. Patch triage & regeneration recipe

| Patch | Verdict | Evidence |
|---|---|---|
| `pi-coding-agent` — #7540 backport (context-clamped length-stop recovery) | **Dropped at the 0.84.0 rung** — shipped natively there (`isRecoverableLength` in `agent-session`); `piLengthRecovery.test.ts` stayed green unchanged as the regression pin | 0.84.0 changelog + dist |
| `pi-ai` — fetch threading (openai-completions/responses clients accept `options.fetch`) | **Dropped at the 0.83.0 rung** — native per-request `fetch` injection arrived (`ProviderRequestOptions.fetch`); the `fetch: customFetch` call site in `PiRuntimeConnection` works unpatched, `piProviderFetch.test.ts` pins it end-to-end | 0.83.0 changelog + `pi-ai/src/types.ts` |
| `pi-ai` — `ultra` reasoning effort (`EXTENDED_THINKING_LEVELS` + level guard in `models.js`, `ThinkingLevel` union in `types.d.ts`, openai/codex `.d.ts` effort unions) | **Regenerate at every rung** — no `ultra` upstream at `v0.87.1` (levels end at `"max"`) | `packages/ai/src/models.ts` at `v0.87.1` |

The two pi-ai halves drop at different rungs, so that patch changes scope mid-ladder;
every rung regenerates whatever survives.

**Recipe** — `pnpm patch` refuses to *create* a new patch non-interactively (cancels
with `ERR_PNPM_PATCH_CANCELED`), so build the artifact manually. The repo is
jj-colocated and jj has no patch-apply/dir-diff equivalents: `git apply` and
`git diff --no-index` below are standalone plumbing over the `/tmp` copies (the git
CLI stays available), not VCS operations on the repo.

1. `cp -rL node_modules/@earendil-works/<pkg> /tmp/<pkg>-edit` and again as `/tmp/<pkg>-orig`.
2. `git apply <old patch>` in the edit copy (`--exclude=<file>` plus direct edits where
   context drifted; verify each hunk lands semantically).
3. `git diff --no-index --no-ext-diff` over dir copies named `a/`/`b/`, normalize the
   `1/a/`…`2/b/` prefixes newer git emits, round-trip check against a fresh pristine
   copy, drop into `patches/`, update `pnpm-workspace.yaml`, delete the old patch file.

## 5. Why the 0.84 "session model replaced" break doesn't hit Cherry

The 0.84.0 breaking change replaced **pi-agent-core's harness** session model (v4
lane-based `Session`/`SessionStorage`/`SessionRepo`, `JsonlSessionRepo`, `AgentHarness`
v2). Cherry never touches the harness — it uses coding-agent's `SessionManager` +
`createAgentSession` SDK. Diffed `session-manager.ts` between `v0.80.3` and `v0.87.1`:
~900 lines changed, but every method Cherry calls kept its exact signature. Similarly
the JSON/RPC `message_update` delta-only break applies to the wire protocol modes, not
the SDK subscription `piStreamAdapter` consumes.

## 6. Behavioral drift to watch in 0.5 (not breaking, but observable)

- **0.83.0 `"pending"` stop reason** for partial streaming messages, and `rawStopReason`
  now surfaced across Google/Anthropic/Bedrock/Mistral/OpenAI; unmapped terminal reasons
  become provider errors instead of silent successes — `piStreamAdapter`/`PiRuntimeConnection`
  stop-reason classification and `lastStopReason === 'length'` error paths should be
  re-tested, and retry classification shifted several times (0.86: bodyless 400/413 no
  longer auto-context-overflow; Cloudflare 520 / Azure capacity now retryable).
- **0.84.1 `Agent.reset()` rejects while a run is active** — only relevant if we ever reset.
- **0.85.0 fork fixes** (compaction-boundary retention #8990, pre-settle in-memory forks
  #8937) — landed upstream; our fork coverage (`PiRuntimeConnection.sdkContract.test.ts`
  + agentSession publication tests) passed unchanged at 0.85.0–0.86.1. No assertion
  updates were needed.
- **0.87.0** deferred `agent_settled`-triggered runs; error-retry attempts omitted from
  future provider context (was: abandoned attempts retained) — changes what resumed
  transcripts replay after a failed turn.
- **0.81.1 compaction/branch-summary retry** — transient summarization failures now
  follow the configured retry policy (pi default: enabled, 3 retries, 2s base; Cherry
  passes no retry override at `PiRuntimeConnection.ts:276`, so this is live for work
  sessions). `summarization_retry_*` lifecycle events are intentionally ignored by
  `piStreamAdapter` — retries are silent but bounded.
- **0.82.x retry/error behavior** — DNS failures (`getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`)
  now join pi's automatic assistant retries (#6946); retry waits honor abort signals and
  configured delay limits (#6980); `ModelsError` messages chain the underlying cause; write
  compaction and branch summaries are no longer cached and summarization requests are
  isolated. All flow through our suites unchanged — no host action, but expect slightly
  more retry persistence on flaky networks and richer provider-error text in streams.
- **0.84.x quiet improvements** — strict tool schemas auto-convert to provider-compatible
  closed objects (better MCP tool-call fidelity, free); upstream request buffer-limit
  failures auto-retry; Google/Vertex no longer misclassify output-limit stops as tool use;
  `Agent.reset()` rejects mid-run (we never reset); `session_compact_failed` events expose
  compaction failure reasons (ignored by `piStreamAdapter` like other unknown events).
  Suites unchanged across 0.84.0–0.84.4.
- **0.86.x quiet changes** — built-in tools (`read`/`bash`/`powershell`/`edit`/`write`)
  now default to strict-prefer JSON-schema sampling (better structured args, free);
  the extension compiler and bundled virtual modules load lazily (smaller baseline SDK
  import); mid-conversation system-prompt/tool changes survive resume via transcript
  system messages; z.ai `Prompt too long` and bodyless 400/413 classification, Cloudflare
  520 / Azure capacity retryability shifted (see 0.83 bullet). Suites unchanged across
  0.86.0–0.86.1.
- **Google adapters reject non-global `fetch` implementations** (0.83.0) — irrelevant for
  the agent-approved provider set, relevant for Phase 1 W3 chat provider matrix.

## 7. Data compatibility (0.6 gate)

- `CURRENT_SESSION_VERSION` is **3 at both ends** — 0.80.x already wrote v3; 0.87.1 still
  reads v3 (and migrates v1/v2 in memory on read). The JSONL format is stable across the
  entire range.
- Filename convention `<timestamp>_<sessionId>.jsonl` (what `piSessionFile.ts` parses)
  unchanged.
- Conclusion: pre-upgrade sessions should resume as-is. The live smoke (resume a session
  created by the released build) stays in the checklist as confirmation; the
  cold-sessions fallback is not expected to be needed.

## 8. Rung status & per-rung procedure

**Ladder complete — no rungs remain.** Final-gate status at the 0.87.1 tip:
`pnpm build:check` ran with lint, docs, and every test project green except 6
`provider-registry` catalog-sync failures that predate the ladder entirely (zero
`provider-registry` paths in `main..@`; regeneration reads live upstream, so fixing
them is an owner data decision, not an upgrade step). The one full-gate failure the
ladder *did* own — `chromiumFlags.test.ts` pinning the `wm-window-animations-disabled`
switch removed by `f3ec23a5e` — was deleted as its own change
(`test(preboot): drop assertions for removed window-animations switch`). Remaining
Phase 0 item: the manual smoke checklist (unification plan §0.6).

Per-rung procedure:

1. Bump both pins in `package.json` and the **three pi-line overrides** in
   `pnpm-workspace.yaml` to the same version. Non-negotiable: fresh `^range` resolutions
   otherwise drift to the newest 0.8x patch and split pi-ai into two instances that
   cannot typecheck (TypeScript nominal-checks private class members — hit in
   `piThinkingReplay.ts` / `piTransportStream.ts`).
2. Regenerate surviving patches (§4).
3. `pnpm install --no-frozen-lockfile` (bumping the overrides makes a frozen install
   fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`); `pnpm typecheck:node` +
   `pnpm test:main` for `runtime/pi` + `agentSession`; `pnpm lint`; manual smoke.
   Run these as separate foreground commands — a backgrounded verification chain
   that ends in `jj describe` races with the next rung's manifest edits and
   snapshots them into the wrong change (happened at 0.84.2; repaired via `jj edit`).
4. Record the rung with jj — no branch, no `git commit`: `jj describe -m
   "chore(deps): update pi line to vX.Y.Z"`, then `jj new` before the next rung.
   Undo mid-rung with `jj restore <paths>`; drop a finished rung with `jj abandon`.

New APIs now available (post-0.80.10) but deliberately not adopted — Phase 0 non-goal,
Phase 1 inputs:

- **Dynamic tool loading** (0.80.7 pi-ai: `ToolResultMessage.addedToolNames`, native
  deferred loading for Anthropic/OpenAI Responses; 0.80.9 Kimi `compat.deferredToolsMode`)
  — machinery for Phase 1 W5's defer-exposition row and `piCodeMode` evolution.
- **`toolChoice` for OpenAI/Codex Responses** (0.80.7) — chat-side control; the agent
  loop drives its own tool use today.
- **`agent_settled`** event (0.80.4) — revisit only if work wants pi-native settled
  hooks (the host owns idle semantics via `AsyncEventQueue`).
- **Deferred responses** (pi-ai 0.83-era surface, live through 0.86.1): `SimpleStreamOptions.deferred`
  (`boolean | { window }`), `StopReason: "deferred"`, `DeferredHandle`,
  `fetchDeferred()`/`cancelDeferred()` on provider streams — long-running provider
  requests return a durable handle and are polled/resumed later. Unreachable for us
  (we never set `deferred: true`), and the Phase 1 W5 defer-exposition row should
  evaluate this machinery before inventing host-side equivalents.
- **0.81 line** (assessed at the 0.81.1 rung, none adopted — Phase 0 non-goal):
  `contentText()` joins *message* content only — none of our three text-join sites
  (`piCodeMode`, `piMcpToolAdapter`, `piStreamAdapter` — all tool/MCP content) match
  its type; Phase 1 W1 history converter may fit. Tool/compaction usage metadata in
  session totals — billing reads assistant usage; Phase 1 parity input.
  `retryAssistantCall()` — retry ownership stays host `createRetryableWrap` (W5).
  `summarization_retry_*` events — ignored by design (§6). Full provider extensions
  via `pi.registerProvider` (auth/refresh/custom streaming) — Phase 1 W3 input.
- **0.82 line** (assessed at the 0.82.1 rung, none adopted — Phase 0 non-goal):
  `ToolDefinition.constrainedSampling` (`prefer`/`require` strict JSON-Schema
  sampling, OpenAI Lark/regex grammars; pi gates by model capability) sits directly
  on the type `piMcpToolAdapter` builds — a Phase 1 candidate for cutting malformed
  MCP tool-call JSON, to be evaluated with real providers. `ANTHROPIC_AUTH_TOKEN`
  gateway bearer auth, OpenRouter/Kimi OAuth login, and catalog ETag machinery —
  Cherry injects providers/models with explicit credentials via `modelInjection`,
  so all are unused by design. `getBuiltinModelDataUrl` → `getBuiltinModelDataGeneratedAt()`
  rename and the provider-verified effort-level pruning of built-in catalogs don't
  reach us (no builtin-catalog reads; injected models carry their own reasoning config).
- **0.87 line** (assessed at the 0.87.1 rung, none adopted — Phase 0 non-goal):
  append-only model-context edits (`sessionManager.appendContextEdit(entryId, null)`
  omits a message from future provider context without touching raw history — strong
  Phase 1 input for transcript editing), the `context_with_system` extension event,
  retain-none compaction (`appendCompaction(summary, null, tokensBefore)`),
  `emitBoundary` actionable turn boundaries + `AgentBeforeSettleEvent`, `finishTurn`
  (replaces `shouldStopAfterTurn`), and per-model image-resize profiles
  (`inputLimits.images.resize`).
- **0.85 line** (assessed at the 0.85.0/0.85.1 rungs, none adopted — Phase 0 non-goal):
  `AssistantMessageFrameEncoder`/`reduceAssistantMessageFrames()` (compact persistable
  assistant frames — Phase 1 session-persistence input), Anthropic per-turn effort
  persistence + signed-thinking mismatch recovery (server-side adaptive-thinking config
  plus empty-signature history handling — neither synthesizes thinking for tool-only
  messages, so our `normalizeCherryInThinkingReplay` shim keeps its job), `vllmPriority` /
  `supportsMaxOutputTokens` model settings (pass-through in `modelInjection` if ever
  needed), and `SessionManager.inMemory(cwd, opts, entries)` external-entry restore —
  the Phase 1 chat engine's designated entry point. The 0.85 narrow subpaths were
  assessed and rejected for `piSdk.ts`: `lazyStream` could move to `pi-ai/api/lazy`,
  but `InMemoryCredentialStore` is barrel-only (`auth/` sits under no exports wildcard),
  so the barrel loads either way — splitting one consumer saves nothing.
- **0.86 line** (assessed at the 0.86.0/0.86.1 rungs, none adopted — Phase 0 non-goal):
  transcript-backed mid-conversation system-prompt/tool changes (`before_agent_start`
  hook; survives resume — Phase 1 dynamic-prompt input), `ctx.modelRegistry.stream()`/
  `streamSimple()` for extension-initiated model calls (Phase 1 W3), per-model
  compaction budgets (`compaction.modelOverrides`), `compat.allowedFallbackModels`,
  cost-aware prompt-cache warming, `RetryPolicy.maxAgentDelayMs`, Meta/Muse provider,
  and `pi.on()` unsubscribe. Nothing removes a patch or existing maintenance.
- **0.84 line** (assessed across the 0.84.x rungs, none adopted — Phase 0 non-goal):
  provider-neutral `toolChoice` on simple streams (chat-side control; agent loop drives
  its own tool use — Phase 1 W3 input alongside the 0.80.7 OpenAI/Codex variant),
  `session_compact_failed` events (Phase 1 compaction-UX input), `AssistantMessage.endTurn`
  diagnostics, `createGatewayBindingFetch()` (Cloudflare Workers AI), OpenAI-compatible
  `thinking_token_budget` fields, and `supportsMidConvoEffort` — all Phase 1 parity
  inputs; none remove a patch or existing maintenance. 0.84.0's breaking custom-provider
  surface (`ModelsRequestTransforms` rename, abort-signal auth callbacks, `context.stored`
  / `context.publish()`) is untouched by our minimal `pi.registerProvider` extension.

Open item for the owner: the "plan D1…D8" vocabulary used across
`src/main/ai/runtime/pi/` comments has no doc in `docs/plans/` — host a legend or
refresh the references.
