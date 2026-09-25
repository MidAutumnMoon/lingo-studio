# Pi Unification Plan — one engine for chat and work

Status: executing — 2026-09-26. Phase 0 under way: triage done (upgrade-notes doc),
upgrade ladder climbing (0.80.7 rung landed on `pi-upgrade-0.80.7`; progress log in the
notes doc §9/§11). Phases 1–3 remain draft.

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
| Pinned pi versions | `@earendil-works/pi-ai` 0.80.7, `@earendil-works/pi-coding-agent` 0.80.7 (upgrading rung-by-rung to 0.87.1; the pi line — `pi-ai`, `pi-agent-core` inside `pi-coding-agent` — is also pinned via `pnpm-workspace.yaml` overrides so all instances share one pi-ai; see upgrade-notes §11) |
| Upgrade target | 0.87.1 — all three packages align on one line |
| pi patches in `patches/` | `pi-ai` (keyed to the current pin): thread custom `fetch` through openai-completions/responses clients (Electron proxy; drops at 0.83.0) + add `ultra` reasoning effort. `pi-coding-agent`: backport of upstream earendil-works/pi#7540 (context-clamped length-stop recovery; drops at 0.84.0) |
| dsh coupling to pi upgrade | None at runtime — dsh's `pi-ai ^0.84.2` is inlined into the `packages/dsh-bridge` dist at build time |
| Engine seam | `src/main/ai/AiService.ts:555` `streamText()` — already branches on `request.runtime?.kind === 'agent-session'` (line 565) → `AgentSessionRuntimeService.openTurnStream()`; a chat-on-pi branch slots in identically |
| Chat engine today | `AiService.streamText` → `buildAgentParams` → `src/main/ai/runtime/aiSdk/Agent.ts` → `@cherrystudio/ai-core` `createAgent` → Vercel AI SDK `ToolLoopAgent` |
| Work engine today | `AgentSessionRuntimeService` → driver registry → `PiRuntimeConnection` (in-process) or `DshRuntimeDriver` (Bun child) |
| Chat test surface | `runtime/pi/*.test.ts` (14 files, the upgrade safety net); chat suites in `streamManager/`, `tools/`, renderer chat tests |
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

Phase 0 research is complete and recorded in [2026-09-pi-upgrade-notes.md](./2026-09-pi-upgrade-notes.md)
(release-by-release break→touchpoint table, patch verdicts with evidence, data-compatibility
findings, recommended step ladder). Headlines, verified against a local clone at `v0.87.1`:

- The upgrade is narrower than feared: the 0.84 "session model replacement" hits
  pi-agent-core's harness — unused by Cherry — not our `SessionManager` path, whose
  signatures are identical at 0.87.1. Session JSONL format is unchanged (v3 at both ends).
- The only mandatory code change is the 0.80.8 auth refactor: `AuthStorage`/`ModelRegistry`
  → `ModelRuntime` in `PiRuntimeConnection.ts` (264–412). No other removed API is used
  anywhere in `src/main`.
- 0.86's `TranscriptContext` is the second (type-level) change: `piTransportStream`,
  `modelInjection`, `piThinkingReplay`.

### 0.1 Changelog triage — DONE

Break→touchpoint table: notes doc §4, cross-checked against a grep inventory of every
`@earendil-works/*` import in `src/main/` (all confined to `src/main/ai/runtime/pi/`).
Ship: doc update only (this doc + the notes doc).

### 0.2 Patch triage — DONE

Verdicts with evidence in notes doc §5:

- `pi-coding-agent` patch (#7540 backport) → **drop** — shipped natively in 0.84.0;
  `piLengthRecovery.test.ts` stays as the regression pin.
- `pi-ai` fetch threading → **drop** — native per-request `fetch` injection since 0.83.0;
  the existing `fetch: customFetch` call site (`PiRuntimeConnection.ts:961`) works unpatched.
- `pi-ai` `ultra` reasoning effort → **regenerate** — no `ultra` upstream at `v0.87.1`.

Ship: nothing (findings recorded in the notes doc).

### 0.3 Upgrade on a branch

Main work: rewrite the `PiRuntimeConnection` session bootstrap onto
`ModelRuntime.create({ credentials })` + pi-ai `Models` provider registration/lookup
(notes doc §3). Then `TranscriptContext` type fixes and the spot-checks in notes §10.
Step ladder with manual-check rungs (notes §9): **0.80.8 → 0.83.0 → 0.84.4 → 0.86.1 →
0.87.1** — the first rung carries the auth rewrite; each later rung drops one patch half
or lands one type change; skipped intermediates are fix-only.

Ship: behind no flag — pi is an implementation detail of "work"; the upgrade ships
when its own verification passes.
Verify: `pnpm typecheck:node`; `pnpm test:main` for `runtime/pi` + `agentSession` suites.

### 0.4 Contract tests to current API

Update `piBundlingViability`, `PiRuntimeConnection.sdkContract`, `piFork`,
`piStreamAdapter`, `piCompactionBudget`, `piThinkingReplay` to the 0.87 API shapes.
These tests are the ones that caught merge-lost registration and fork semantics
before — keep their assertions, update their calls.

Ship: with 0.3 or as its own PR.
Verify: the named suites green.

### 0.5 Behavior fixes + full gate

Run the full main suite and fix adapter drift (event shapes, compaction semantics,
retry classification — candidate drift list in notes doc §7). Then `pnpm build:check`.

Ship: combined with 0.3/0.4 as one merge or a short series — app must work at each merge.
Verify: `pnpm build:check` green.

### 0.6 Manual smoke (cherry-electron-dev)

Work checklist: new agent session; plain text turn; MCP tool call; approval prompt
approve + deny; mid-turn steer; `/compact`; fork from message; edit-resend; quit +
relaunch + resume the same session (resume token); heartbeat/scheduled task fires;
one dsh agent session still runs; `pnpm smoke:dsh-runtime` green. Chat spot-check:
one normal chat message round-trips (chat was untouched, prove it).

**Data-compatibility gate:** session JSONL format verified stable across the range
(v3 at both 0.80.3 and 0.87.1; older versions migrated on read — notes doc §8). The
cold-sessions fallback is not expected to be needed; before shipping, still resume a
session created by the currently released app build as live confirmation.

Rollback: revert the branch — pins + patches are self-contained; no schema involved.

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

**W2 — Pi chat engine module** (`src/main/ai/runtime/pi-chat/` or sibling).
Builds the in-memory session per execution: provider injection via the existing
`modelInjection.ts`, system prompt via the existing chat prompt assembly (not the
agent `buildAgentRuntimePrompt` — chat keeps its own prompt until Phase 3), tools
per W4, abort wired to `session.abort()`, usage → billing hook parity with the
current `createAiUsagePlugin` accounting, OTel spans in the existing shape.
Ship/verify: engine-level streaming tests against `pi-ai` faux provider — text
turn, tool round-trip, abort mid-stream, usage events.

**W3 — Provider coverage: agent whitelist → every chat-usable provider.**
`modelInjection`/`assertPiProviderUsable` currently serve agent-approved providers.
Chat must cover the full provider matrix (`provider/extensions.ts` + customs +
gateway). Build a compatibility test keyed on `@cherrystudio/provider-registry`
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
| Attachments | `attachmentRouting` produces AI-SDK shapes; add pi content-block mapping (inline images supported by pi-ai). Cover image + PDF cases |
| Citations / sendSources | Agent side already resolves citations for pi tool outputs; port the resolution to chat rendering |
| Reasoning effort / service tier / fast mode | `modelInjection` thinking-level map extended to chat params; verify per family |
| Defer exposition (`tool_search`) | Port `piCodeMode` catalog for chat when tool counts demand it; v1 may ship without (chat tool sets are small) |
| Steering semantics | Chat steer = enqueue + yield + chained continuation (host-owned, engine-agnostic) — no change; pi-native steer is not used for chat in Phase 1 |

**W6 — Rollout flag.**
Preference flag (e.g. `AiChat.piEngine`), levels: off → dogfood (team topics) →
default on → remove the legacy path. Each level is its own merge.
Per-level manual checklist: plain send; tool call + approval; image attachment;
multi-model topic; regenerate; branch/merge; abort mid-stream; kill the app
mid-stream and relaunch (attach + persistence); translate feature (rides the same
engine when flag on — verify or explicitly exclude in flag scope).

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
- Single prompt/permission model: converge `buildAgentRuntimePrompt` and the chat
  prompt assembly.

Open questions: does chat ever want warm sessions and resume tokens; does work
ever want multi-model fan-out; where do overlay branches and session forks unify.

---

## Verification & rollback matrix

| Phase | Automated | Manual smoke | Rollback |
|---|---|---|---|
| 0 each step | typecheck + `runtime/pi`/`agentSession` suites; full gate at 0.5 | work checklist (0.6) incl. pre-upgrade session resume | revert branch |
| 1 each workstream | converter corpus tests; faux-provider engine tests; provider matrix; tool round-trips; chat suites | per-flag-level chat checklist | flag off |
| 1 exit | full `pnpm build:check` | both checklists | revert deletion PR |
| 2 each step | per-site suites; gateway SSE contract test | aux features (naming, translate, knowledge indexing, paintings) | revert step |

## Appendix — load-bearing files

- Phase 0: `src/main/ai/runtime/pi/*` (esp. `PiRuntimeConnection.ts`, `piSdk.ts`, `piSessionFile.ts`, `piFork.ts`, `piTransportStream.ts`, `modelInjection.ts`), `patches/@earendil-works__*`, `src/main/ai/agentSession/` (resume-token hydration).
- Phase 1: `src/main/ai/AiService.ts` (seam), new `runtime/pi-chat/`, `piStreamAdapter.ts`, `messages/` (converter input), `src/main/ai/tools/adapters/aiSdk/registry.ts` (W4a source), `approvalExtension.ts` + `toolApproval/` (approval resume mechanics), `streamManager/` (unchanged — proof by diff).
- Phase 2: `packages/aiCore/src/core/runtime/executor.ts` (swap target), `src/main/features/apiGateway/proxyStream.ts` (contract freeze), `src/shared/data/types/` (D3), `src/renderer/hooks/useChatWithHistory.ts` (2.4).
