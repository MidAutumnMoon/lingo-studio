# Pi 0.80 → 0.87 Upgrade Notes — Phase 0 research record

Status: research complete — 2026-09-26. Companion to [2026-09-pi-unification.md](./2026-09-pi-unification.md);
everything below was verified against a local clone of `earendil-works/pi` at tag `v0.87.1`
(all `v0.8x` tags available locally for diffing). No code has been changed.

Covers plan steps 0.1 (changelog triage) and 0.2 (patch triage). Sections 4 and 5 are the
deliverables those steps call for.

## 1. Grounding facts

| Fact | Value |
|---|---|
| Cherry pins | `@earendil-works/pi-ai` 0.80.6, `@earendil-works/pi-coding-agent` 0.80.3 (`pi-agent-core` resolves 0.80.10 transitively) |
| Target | 0.87.1 — the monorepo tags all packages together; `pi-coding-agent@0.87.1` depends on `pi-ai ^0.87.1`, `pi-agent-core ^0.87.1`, `pi-tui ^0.87.1`, `chord ^0.87.1` |
| Package ↔ dir mapping | one repo, one version line: `packages/ai` → pi-ai, `packages/coding-agent` → pi-coding-agent, `packages/agent` → pi-agent-core |
| Cherry import surface | **entirely confined to `src/main/ai/runtime/pi/`** — 10 source files + tests. All runtime (value) imports go through dynamic `import()` in `piSdk.ts`; every other file is `import type` only. Grep-inventory-verified across `src/` and `packages/` |
| pi test provider | `pi-ai/providers/faux` (engine tests run without network) — unchanged across the range |

## 2. Release ladder — what breaks at each rung, and whether Cherry cares

"None" means no Cherry touch point uses the changed API (verified by symbol grep, not
assumed from the changelog).

| Version | Breaking change | Cherry impact |
|---|---|---|
| 0.80.7 | pi-ai: `OpenAIResponsesCompat.sendSessionIdHeader` flag removed → `compat.sessionAffinityFormat` | None — we don't write pi `models.json` |
| **0.80.8** | **pi-ai + coding-agent auth refactor**: `AuthStorage` and `ModelRegistry` no longer exported; `CreateAgentSessionOptions.authStorage`/`modelRegistry` → single async `modelRuntime`; `ModelRuntime.getAuth()` replaces `getApiKeyAndHeaders()`; `Models.refresh(options)` returns per-provider errors | **The one mandatory code change** — see §3 |
| 0.81.0 | pi-agent-core: `SessionStorage` harness API reworked; `uuidv7` moved to pi-ai; `Agent.streamFn` fallback → required `streamFunction` (removes pi-ai/compat from selective-provider bundles) | None — harness unused; `pi-ai/compat` still exists for our `unregisterApiProviders` |
| 0.82.0 | pi-ai: `getBuiltinModelDataUrl()` → `getBuiltinModelDataGeneratedAt()`; harness `AgentTool` → context-aware `AgentHarnessTool` | None — both unused |
| 0.83.0 | TypeBox 1.3.7 bundled aliases: `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, `Value.Mutate` removed | None in our code — no TypeBox imports under `src/main/ai` (pi validates our JSON-schema tool definitions internally) |
| 0.84.0 | pi-agent-core harness session model → v4 lane-based `Session`/`SessionStorage`/`SessionRepo`; legacy JSONL/in-memory harness repos removed; JSON/RPC `message_update` wire events delta-only; `ModelRegistry.getApiKeyAndHeaders()` returns nullable `ProviderHeaders`; `ModelsRequestTransforms` rename | **None on Cherry's path** — see §6 (harness ≠ `SessionManager`; wire ≠ SDK events; we don't call `getApiKeyAndHeaders`). #7540 lands natively here → coding-agent patch droppable |
| 0.84.3 | pi-ai: `GoogleThinkingLevel` → `GoogleApiThinkingLevel` (+ `ResolvedGoogleThinkingLevel`) | None — symbol unused in `src/` (grep-verified); `piThinkingReplay` types come via `ProviderConfig` |
| 0.84.4 | pi-agent-core: `prepareNextTurn*` hooks no longer run after final turns; harness manual-drive APIs removed | None — hooks unused |
| 0.85.0 | pi-ai: `createGatewayBindingFetch()` → `createAiBindingFetch()` | None — unused. (Additions here matter: `SessionManager.inMemory(cwd, opts, entries)` for restoring external entries; narrow `api`/`providers`/`utils` subpath exports) |
| **0.86.0** | **pi-ai: provider stream inputs `Context` → normalized `TranscriptContext`** — system prompt / tool declarations move into transcript system messages, read via `getCurrentSystemPrompt()`/`getCurrentTools()`; `ToolCall.arguments`/`ToolResultMessage.details` restricted to JSON values; `ToolResultMessage` conditional type; `JsonValue` arrays readonly; coding-agent `user_bash` fails closed | **Second real change** — type-level for `piTransportStream.ts` / `modelInjection.ts` (our `ProviderConfig['streamSimple']` alias picks up the new shape automatically; the `onPayload` composition and any non-JSON tool-result details need review). No `user_bash` handler exists in Cherry |
| **0.87.0** | pi-agent-core: `shouldStopAfterTurn` removed → `finishTurn` returning `{action: "end"}`; coding-agent: `ContextEditEntry` added to `SessionEntry` union (exhaustive switches break); `SessionManager` canonical — assigning `session.agent.state.messages` no longer replaces future request history; `TurnEndEvent` boundary fields + `AgentBeforeSettleEvent`; `ExtensionRunner.emit()` rejects `turn_end` | None found — no `shouldStopAfterTurn` use, no exhaustive `SessionEntry`/`ExtensionEvent` switches, no direct `agent.state.messages` assignment in Cherry code. `getLeafId()`/`navigateTree()` still available |
| 0.87.1 | — (fixes only) | None |

Minor releases not listed (0.80.9/10, 0.81.1, 0.82.1, 0.84.1/2, 0.85.1, 0.86.1) are additive
or fix-only; none touch a Cherry API.

## 3. The one mandatory code change (lands at 0.80.8)

`PiRuntimeConnection.ts:264–267 + 397–412`:

```ts
const authStorage = pi.AuthStorage.inMemory()          // gone
authStorage.setRuntimeApiKey(runtimeProviderName, ...)
const modelRegistry = pi.ModelRegistry.inMemory(authStorage)  // gone
modelRegistry.registerProvider(runtimeProviderName, isolatedProviderConfig)
const model = modelRegistry.find(runtimeProviderName, injection.modelId)
...
await pi.createAgentSession({ authStorage, modelRegistry, ... })  // options gone
```

At 0.87.1 `CreateAgentSessionOptions` takes `modelRuntime?: ModelRuntime`, and
`ModelRuntime.create({ credentials })` accepts any pi-ai `CredentialStore` — an in-memory
store preserves Cherry's isolation (no `auth.json`/`models.json` on disk). Provider
registration and model lookup move to the pi-ai `Models` surface
(`registerProvider`/`getModel` equivalents; `setRuntimeApiKey` exists on `ModelRuntime`
too). Everything else `createAgentSession` receives today (`settingsManager`,
`sessionManager`, `resourceLoader`, `model`, `tools`, `customTools`, `excludeTools`)
kept its name and shape.

This is the only place in `src/main` that touches a removed API — verified by grepping
every removed symbol (`shouldStopAfterTurn`, `sendSessionIdHeader`, `getApiKeyAndHeaders`,
TypeBox names, `user_bash`, `hookMessage`, `AuthStorage`, `ModelRegistry`).

## 4. Break → touchpoint table (0.1 deliverable)

| Touchpoint | Breaks that reach it | Required action |
|---|---|---|
| `PiRuntimeConnection.ts` session bootstrap (264–412) | 0.80.8 auth refactor | Rewrite onto `ModelRuntime` (§3) |
| `PiRuntimeConnection.ts:431–440` `resolveSessionManager` (`SessionManager.open/create`) | none — signatures identical at 0.87.1 | None |
| `PiRuntimeConnection.ts:678` `session.sessionManager.getLeafId()` | none | None |
| `PiRuntimeConnection.ts:692–698` `loadPiAiCompat().unregisterApiProviders(sourceId)` | none yet — `pi-ai/compat` survives through 0.87.1 (0.80.0 slated it for removal "eventually"; still exported) | None; re-check each upgrade rung |
| `piFork.ts:32–45` `SessionManager.open` + `createBranchedSession` + `getEntry` + `getSessionId` | none — all survived with same signatures | None (0.85 fork fixes land upstream and are *desirable*: compaction-boundary + pre-settle fork bugs) |
| `piSessionFile.ts` (direct filename parsing `<timestamp>_<id>.jsonl`) | none — convention unchanged | None |
| `piTransportStream.ts` + `modelInjection.ts` (`streamSimple` delegation, `onPayload` composition) | 0.86.0 `TranscriptContext` | Type-level rework; runtime logic likely unchanged (we pass `model, context, options` through) |
| `piStreamAdapter.ts` (`session.subscribe` events) | none — SDK `MessageUpdateEvent` still carries `message: AgentMessage` + `assistantMessageEvent`; the 0.84 delta-only change was the JSON/RPC wire layer, not SDK events. Behavioral drift only (§7) | None at upgrade; watch drift |
| `approvalExtension.ts`, `providerExtension.ts` (extension API) | none — `tool_call` handler shape, `pi.registerProvider` extension form unchanged | None; 0.86 exported more event types than before, nothing removed |
| `piSdk.ts` dynamic imports (`.`, `pi-ai`, `pi-ai/compat`, `pi-ai/api/*`) | none — subpath exports intact (0.85 *added* narrow subpaths) | None; re-run `piBundlingViability` (0.84.3 changed CLI/RPC entrypoints to a bundled runtime — the library entry is documented to stay modular, verify) |
| `piCodeMode.ts`, `piMcpToolAdapter.ts` (`ToolDefinition` JSON schemas) | 0.86.0 JSON-only `ToolCall.arguments`/`ToolResultMessage.details` | Check adapters emit JSON-safe details (they wrap MCP results; likely already JSON) |
| `piThinkingReplay.ts` (anthropic-messages `streamSimple` wrap) | 0.86.0 `TranscriptContext` (same as transport stream) | Type-level |

## 5. Patch triage (0.2 deliverable)

| Patch | Verdict | Evidence |
|---|---|---|
| `@earendil-works__pi-coding-agent@0.80.3.patch` (#7540 length-stop recovery backport) | **Drop** | 0.84.0 changelog + `git log`: "Fixed responses truncated below their intended output limit ending the run instead of compacting and retrying once (#7540)" shipped natively. Keep `piLengthRecovery.test.ts` as the regression pin |
| `@earendil-works__pi-ai@0.80.6.patch` — fetch threading half (openai-completions/responses clients accept `options.fetch`) | **Drop** | 0.83.0 added native per-request `fetch` injection (`ProviderRequestOptions.fetch` in `pi-ai/src/types.ts`). Cherry already passes `fetch: customFetch` in `withPiRequestEnvironment` (`PiRuntimeConnection.ts:961`); that call site starts working unpatched |
| `@earendil-works__pi-ai@0.80.6.patch` — `ultra` reasoning-effort half (extends `EXTENDED_THINKING_LEVELS`, openai/codex `.d.ts` unions, `simple-options` mapping) | **Regenerate** | Upstream at `v0.87.1` still ends `EXTENDED_THINKING_LEVELS` at `"max"`; no `ultra` anywhere in `packages/ai/src`. Fresh `pnpm patch` against 0.87.1 needed |

Gotcha: dropping the fetch half and the coding-agent patch at *different rungs* means the
pi-ai patch file must be split or regenerated twice if we step gradually — the patch is one
file for one package version. Since patch files are keyed to exact versions, every rung
change regenerates whatever patches survive; only the `ultra` half should survive to 0.87.1.

**Patch regeneration recipe** (proven on the 0.80.7 rung; `pnpm patch` refuses to *create*
a new patch non-interactively — it cancels with `ERR_PNPM_PATCH_CANCELED` — so build the
artifact manually):

1. `cp -rL node_modules/@earendil-works/<pkg> /tmp/<pkg>-edit` and again as `/tmp/<pkg>-orig`.
2. `cd /tmp/<pkg>-edit && git apply <old patch>` (add `--exclude=<file>` for hunks whose
   context drifted, then edit those files directly; verify each hunk lands semantically).
3. `git diff --no-index --no-ext-diff a b` over dir copies named `a/`/`b/`, normalize the
   `1/a/`…`2/b/` prefixes newer git emits, round-trip check against a fresh pristine copy,
   drop into `patches/`, update `pnpm-workspace.yaml`, delete the old patch file.

## 6. Why the scary 0.84 "session model replaced" break doesn't hit us

The 0.84.0 breaking change replaced **pi-agent-core's harness** session model (v4 lane-based
`Session`/`SessionStorage`/`SessionRepo`, `JsonlSessionRepo`, `AgentHarness` v2). Cherry
never touches the harness — it uses coding-agent's `SessionManager` + `createAgentSession`
SDK. Diffed `session-manager.ts` between `v0.80.3` and `v0.87.1`: ~900 lines changed, but
every method Cherry calls kept its exact signature (`open`, `create`, `getSessionId`,
`getEntry`, `getLeafId`, `createBranchedSession`). Similarly the JSON/RPC `message_update`
delta-only break applies to the wire protocol modes, not the SDK subscription
`piStreamAdapter` consumes (verified: SDK `MessageUpdateEvent` unchanged).

## 7. Behavioral drift to watch in 0.5 (not breaking, but observable)

- **0.83.0 `"pending"` stop reason** for partial streaming messages, and `rawStopReason`
  now surfaced across Google/Anthropic/Bedrock/Mistral/OpenAI; unmapped terminal reasons
  become provider errors instead of silent successes — `piStreamAdapter`/`PiRuntimeConnection`
  stop-reason classification and `lastStopReason === 'length'` error paths should be
  re-tested, and retry classification shifted several times (0.86: bodyless 400/413 no
  longer auto-context-overflow; Cloudflare 520 / Azure capacity now retryable).
- **0.84.1 `Agent.reset()` rejects while a run is active** — only relevant if we ever reset.
- **0.85.0 fork fixes** (compaction-boundary retention #8990, pre-settle in-memory forks
  #8937) — behavior our `piFork.test.ts` pins; assertions may legitimately need updating.
- **0.87.0** deferred `agent_settled`-triggered runs; error-retry attempts omitted from
  future provider context (was: abandoned attempts retained) — changes what resumed
  transcripts replay after a failed turn.
- **Google adapters reject non-global `fetch` implementations** (0.83.0) — irrelevant for
  the agent-approved provider set, relevant for Phase 1 W3 chat provider matrix.

## 8. Data compatibility (0.6 gate)

- `CURRENT_SESSION_VERSION` is **3 at both ends** — 0.80.3 already wrote v3; 0.87.1 still
  reads v3 (and migrates v1/v2 in memory on read via `migrateToCurrentVersion`). The JSONL
  format is stable across the entire range.
- Filename convention `<timestamp>_<sessionId>.jsonl` (what `piSessionFile.ts` parses)
  unchanged.
- Conclusion: pre-upgrade sessions should resume as-is. The live smoke (resume a session
  created by the released build) stays in the checklist as confirmation, but the
  cold-sessions fallback is not expected to be needed.

## 9. Step ladder for 0.3 — progress log

Rungs chosen where breaks cluster (intermediate versions are fix-only; skipping them
loses nothing). **0.80.x series ✅ (2026-09-26: 0.80.7 → 0.80.8 → 0.80.10)** — see §11.

1. ~~**0.80.7**~~ — done: pins + both patches regenerated + pi-line overrides added (§11);
   no API change for Cherry, proved the rung procedure end-to-end.
2. ~~**0.80.8**~~ — done: auth refactor rewrite (§3) landed across `PiRuntimeConnection.ts`
   + five test files; details and the new-`hasConfiguredAuth` gotcha in §11.
3. ~~**0.80.10**~~ — done: series-closing fix-only hop (0.80.9/0.80.10: Kimi K3 support,
   deferred tool loading, catalog fixes). Pins + overrides + both patches regenerated;
   zero code change. First rung where pi-agent-core's overridden version (0.80.10) equals
   what an unforced resolution would pick.
4. **0.83.0** — drop the fetch half of the pi-ai patch; `piProviderFetch.test.ts` proves
   native injection end-to-end.
5. **0.84.4** — drop the coding-agent patch; `piLengthRecovery.test.ts` pins native #7540.
6. **0.86.1** — `TranscriptContext` type rework (transport stream, thinking replay).
7. **0.87.1** — final rung; regenerate the `ultra` patch here once, run full gate + smoke.

Per-rung procedure (mechanized on the 0.80.7 rung):

1. Bump both pins in `package.json`; bump the **three pi-line overrides** in
   `pnpm-workspace.yaml` to the same version (see §11 for why — non-negotiable, fresh
   resolutions otherwise drift to the newest 0.8x patch and split pi-ai into two
   instances that cannot typecheck).
2. Regenerate surviving patches (recipe in §5).
3. `pnpm install`; then `pnpm typecheck:node` + `pnpm test:main` for `runtime/pi` +
   `agentSession`; `pnpm lint` before handing over for the manual check.

## 10. Open items — verified how far, and what 0.3 must still check

Verified by reading 0.87.1 source and grepping Cherry: everything in §2–§8.
Spot-checked rather than exhaustively diffed (each is small; re-check during 0.3 type-fixing):

- `DefaultResourceLoader` options (`noExtensions`, `additionalSkillPaths`,
  `systemPromptOverride`, `extensionFactories`, …) — believed unchanged; confirm types.
- `createBashToolDefinition(workspacePath, { commandPrefix, shellPath, spawnHook })`.
- `SettingsManager.inMemory(settings, { projectTrusted })` + `setShellCommandPrefix`.
- Full `AgentSessionEvent` variant list vs `piStreamAdapter`'s switch (spot-checked
  `message_update`/`message_end`; new variants added since 0.80 are additive).
- `piBundlingViability` — green at 0.80.7 (16 files / 267 tests). Re-check at 0.87.1:
  0.84.3 moved CLI/RPC entrypoints to a bundled runtime; the library entrypoint is
  documented to stay on the modular runtime (changelog: "keeping the public library and
  legacy module paths on the modular runtime for normal dependency identity").

## 11. Rung log

### 0.80.7 — landed 2026-09-26 on `pi-upgrade-0.80.7`

Changes: pins 0.80.6/0.80.3 → 0.80.7/0.80.7; both patches regenerated (recipe §5; only
adaptation: 0.80.7's new `toolChoice` field broke the `openai-responses.d.ts` hunk's
trailing context — union edited directly); old patch files deleted; three
`parent>child` overrides added in `pnpm-workspace.yaml`.

**The dual-instance trap (new gotcha, affects every rung):** TypeScript nominal-checks
private class members, so two pi-ai copies can never typecheck where pi-ai and
pi-coding-agent types meet (`AssistantMessageEventStream`'s `private queue`, hit in
`piThinkingReplay.ts:42` and `piTransportStream.ts:72`). The pre-0.80.7 tree only worked
because the lockfile happened to resolve coding-agent 0.80.3's `^0.80.3` to root's
0.80.6 instance; a fresh resolution picks the *newest* matching 0.8x (0.80.10 at the
time), splitting the instances. Fix (now in `pnpm-workspace.yaml`):
`pi-coding-agent>pi-ai`, `pi-coding-agent>pi-agent-core`, `pi-agent-core>pi-ai` pinned
to the root pin's exact version — same-release siblings are what upstream ships and
tests together. dsh's pi-ai 0.84.4 is untouched (scoped selectors, no global override).
These three lines move with the pins at every rung.

Residuals (benign, no action): `pi-tui` still resolves 0.80.10 via coding-agent's
`^0.80.7` — it has no pi-ai dependency and never loads in embedded usage; orphaned
0.80.x store dirs under `.pnpm` are unreferenced by the lockfile. `pnpm peers check`
warnings are all pre-existing (sentry/otel, eslint-plugin-import-x, react-spinners) —
none from the pi line.

Verification: `pnpm typecheck:node` clean; `runtime/pi` 16 files / 267 tests green
(incl. `piLengthRecovery`, `piProviderFetch`, `piBundlingViability`); `agentSession`
8 files / 307 tests green; `pnpm lint` full gate green.

New APIs now available but deliberately **not** adopted (Phase 0 non-goal: no behavior
change; recorded as Phase 1 inputs):

- **Dynamic tool loading** (0.80.7 pi-ai: `ToolResultMessage.addedToolNames`, native
  deferred loading for Anthropic/OpenAI Responses) — machinery for Phase 1 W5's
  defer-exposition row and `piCodeMode` evolution.
- **`toolChoice` for OpenAI/Codex Responses** (0.80.7) — chat-side control; agent loop
  drives its own tool use today.
- **`agent_settled`** event (0.80.4) — host owns idle semantics via `AsyncEventQueue`;
  revisit only if work wants pi-native settled hooks.
- **`max` thinking level** (0.80.6, already native below our patch) — our `ultra`
  patch still extends beyond it; nothing to do.

### 0.80.8 — landed 2026-09-26 on `pi-upgrade-0.80.8`

The auth-refactor rung: `AuthStorage`/`ModelRegistry` are gone; `CreateAgentSessionOptions`
takes a single async `modelRuntime`. Rewrite map (six files, all grepped clean of the old
symbols afterward):

- `PiRuntimeConnection.ts` — bootstrap becomes
  `ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  allowModelNetwork: false })` → `setRuntimeApiKey` → `registerProvider` → `getModel`,
  and `createAgentSession({ modelRuntime, ... })`. `RuntimeCredentials` (inside
  ModelRuntime) is the same in-memory overlay `AuthStorage` had, so the D1 isolation
  contract is unchanged. **`allowModelNetwork: false` is mandatory** — it otherwise
  defaults to `PI_OFFLINE === undefined` (true in Cherry) and create() would run a
  network catalog refresh with a 15 s timeout at session bootstrap.
- `piLengthRecovery.test.ts`, `PiRuntimeConnection.sdkContract.test.ts`,
  `piBundlingViability.test.ts`, `modelInjection.test.ts` ×2 sites — same migration;
  `getApiKeyAndHeaders(find(...))` → `getAuth(getModel(...)!)` and the `{ok, headers}`
  assertion shape becomes `auth?.auth.headers`.
- `PiRuntimeConnection.test.ts` — fake SDK surface: `ModelRuntime.create` mock replacing
  the `AuthStorage`/`ModelRegistry` pair, plus `loadPiAi` mock for
  `InMemoryCredentialStore`.

Two behavioral notes discovered by the suite:

- **`ModelRuntime.setRuntimeApiKey` is async** (sync on `AuthStorage` before) — five
  call sites needed `await`; oxlint `no-floating-promises` caught them.
- **`session.prompt()` now gates on `hasConfiguredAuth(provider)`**: a runtime API key
  overlay alone is not "configured" — the provider must also be registered with the
  placeholder-key config (exactly what production's D1 flow does). `piLengthRecovery`
  needed the registration added; production was unaffected.

Verification: `pnpm typecheck:node` clean; `runtime/pi` + `agentSession` 24 files /
574 tests green; `pnpm lint` clean (0 errors). Patches regenerated against 0.80.8 with
no hunk adaptations needed (models.js drifted +185 lines, hunks offset-adapted).

### 0.80.10 — landed 2026-09-26 on `pi-upgrade-0.80.10`

Series-closing hop over the fix-only 0.80.9/0.80.10 (Kimi K3 + deferred tool loading,
catalog and xAI-OAuth fixes). Pins + the three pi-line overrides → 0.80.10; both patches
regenerated (applied with zero offsets — no adaptation); zero code change, zero test
change. `pnpm typecheck:node` clean; `runtime/pi` + `agentSession` 24 files / 574 tests
green; `pnpm lint` 0 errors. **0.80.x series complete.**
