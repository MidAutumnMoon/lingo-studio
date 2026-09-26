# Pi Upgrade Notes — companion to the unification plan

Status: upgrade ladder complete (2026-09-26) — pins at `@earendil-works/pi-ai` 0.87.1 /
`pi-coding-agent` 0.87.1; the rung-by-rung history lives in git. This doc keeps only
what future work needs. Companion to [2026-09-pi-unification.md](./2026-09-pi-unification.md);
pi upstream clones locally at `~/Code/pi` with all `v0.8x` tags for diffing.

## 1. Facts that stay true

- One repo (`earendil-works/pi`), one version line: `packages/ai` → pi-ai,
  `packages/coding-agent` → pi-coding-agent, `packages/agent` → pi-agent-core.
- Cherry's pi import surface is entirely confined to `src/main/ai/runtime/pi/`; runtime
  (value) imports go only through dynamic `import()` in `piSdk.ts`, everything else is
  `import type`. Context types derive from pi signatures
  (`Parameters<PiStreamSimple>[1]`), so pi-side type changes flow in without edits —
  the 0.86 `TranscriptContext` rework needed zero production changes for exactly this
  reason.
- pi-ai test provider `pi-ai/providers/faux` runs engine tests without network.
- `pi-ai/compat` (`unregisterApiProviders`) still exists at 0.87.1 but is slated for
  removal upstream — re-check on every future bump.
- The lockfile intentionally holds two pi-ai resolutions: the root-pinned 0.87.1 line
  and `@deepseek-ai/dsh-llm-pi-ai`'s own `^0.84.x` (inlined into dsh-bridge at build
  time; isolated lane — see the override comment in `pnpm-workspace.yaml`).
- Session JSONL: `CURRENT_SESSION_VERSION` 3 across the whole completed range, filename
  convention `<timestamp>_<sessionId>.jsonl`. Pre-upgrade sessions resume as-is; the
  live resume smoke (unification §0.6) is the confirmation gate.

## 2. Upgrade procedure (next bump)

Bump both root pins and the three pi-line overrides in `pnpm-workspace.yaml` together,
then `pnpm install --no-frozen-lockfile` (a frozen install fails on override changes).
Regenerate the surviving patch: copy the installed package pristine, `git apply` the
old patch onto a second copy, `git diff --no-index` the two trees (exits 1 on
differences — don't chain with `&&`), round-trip the new patch onto a fresh copy, swap
the file plus the yaml key. Verify in separate foreground commands —
`pnpm typecheck:node`, `pnpm test:main` for `runtime/pi` + `agentSession`, `pnpm lint` —
before `jj describe`: a backgrounded chain ending in `jj describe` races with the next
edit set and snapshots it into the wrong change.

## 3. Patch state

One patch: `patches/@earendil-works__pi-ai@<pin>.patch` adds the `ultra` reasoning
effort (levels + guard in `dist/models.js`, unions in `types.d.ts` and the two
responses `.d.ts`). Upstream has no `ultra` through 0.87.1 — regenerate per bump until
it does. The fetch-threading half dropped at 0.83.0 and the #7540 backport at 0.84.0,
both native upstream; `pi-coding-agent` needs no patch.

## 4. Phase 1 API shelf (assessed during the ladder, deliberately not adopted)

Ordered by expected value:

- `SessionManager.inMemory(cwd, opts, entries)` — restore externally managed session
  entries; the designated entry point for the Phase 1 chat engine.
- `sessionManager.appendContextEdit(entryId, null)` — omit a message from future
  provider context without touching raw history; the fit for transcript editing.
- Deferred responses (`SimpleStreamOptions.deferred`, `StopReason: "deferred"`,
  `fetchDeferred()`/`cancelDeferred()`, `DeferredHandle`) — W5 defer-exposition should
  ride this machinery instead of host-side equivalents.
- `ToolDefinition.constrainedSampling` — strict JSON-schema sampling for MCP tools
  (cuts malformed tool-call JSON); evaluate with real providers.
- Mid-conversation system-prompt/tool changes (`before_agent_start`, transcript system
  messages) plus `context_with_system` — dynamic prompts that survive resume.
- `ctx.modelRegistry.stream()`/`streamSimple()` — extension-initiated model calls
  through configured providers with resolved auth.
- Turn boundaries: `emitBoundary`, `AgentBeforeSettleEvent`, `finishTurn` (replaced
  `shouldStopAfterTurn`).
- Compaction: per-model budgets (`compaction.modelOverrides`), retain-none
  (`appendCompaction(summary, null, tokensBefore)`), `session_compact_failed` events.
- Smaller: provider-neutral `toolChoice`, `AssistantMessageFrameEncoder`/
  `reduceAssistantMessageFrames()` (persistable frames), `RetryPolicy.maxAgentDelayMs`,
  prompt-cache warming + `Model.promptCache` tiers, `timeoutMs`/`maxRetries`/
  `maxRetryDelayMs` knobs, per-model image-resize profiles (`inputLimits.images.resize`),
  `compat.allowedFallbackModels`, `pi.on()` unsubscribe, full custom providers via
  `pi.registerProvider`.

## 5. Gotchas to carry into Phase 1

- `StopReason` includes `"pending"` (partials) and `"deferred"`;
  `PiRuntimeConnection` assigns `lastStopReason` only from `turn_end`, so partial stop
  reasons are structurally inert — keep it that way when touching stop-reason handling.
- pi retries assistant calls itself (DNS failures, 5xx, Cloudflare 520, Azure capacity,
  buffer-limit failures) and waits honor abort signals. Host retry wrapping is for
  chat, not work sessions — don't double-wrap.
- Bodyless 400/413 are no longer auto-classified as context overflow; z.ai
  `Prompt too long` is. Error messages chain underlying causes; unmapped terminal
  reasons surface as provider errors.
- 0.87: resumed transcripts omit abandoned error-retry attempts;
  `agent_settled`-requested runs defer until settled handlers finish;
  `ExtensionRunner.emit()` rejects `turn_end` (use `emitBoundary`).
- Built-in pi tools default to strict-prefer JSON sampling; strict tool schemas
  auto-convert for providers needing closed objects. `ToolCall.arguments` and
  `ToolResultMessage.details` are JSON-only by type now.
- Google adapters reject non-global `fetch` implementations — matters for the W3 chat
  provider matrix.
- Anthropic signed-thinking recovery (adaptive config + empty-signature history
  handling) does **not** synthesize thinking for tool-only messages —
  `normalizeCherryInThinkingReplay` keeps its job; don't delete it as "covered
  upstream".
- Custom providers receive branded `TranscriptContext`; system prompt and tool
  declarations live in transcript system messages (`getCurrentSystemPrompt()`/
  `getCurrentTools()`). Build contexts only via `normalizeContext()` — and Cherry
  never reads `context.systemPrompt`/`context.tools` directly; keep it that way.

## 6. Open items

- Owner: manual smoke checklist (unification plan §0.6) — the last Phase 0 gate.
- Owner: 6 pre-existing `provider-registry` catalog-sync test failures (predate the
  ladder; regeneration reads live upstream — a data decision, not a code fix).
- Owner: host a legend for the "plan D1…D8" vocabulary used across
  `src/main/ai/runtime/pi/` comments, or refresh the references.
