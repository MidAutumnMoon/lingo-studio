---
description: End-to-end chat turn flow from renderer IPC transport through AiStreamManager and the pi chat-turn seam to persistence
sources:
  - src/main/ai/streamManager
  - src/main/ai/AiService.ts
  - src/main/ai/chatTurnPlan.ts
  - src/main/ai/runtime/piChat/chatTurnSeam.ts
  - src/main/ipc/handlers/ai.ts
  - src/renderer/services/aiTransport
---

# Core Architecture

End-to-end view of how a Cherry chat turn moves from user input to LLM
response and back to UI, with pointers to the focused references for
each subsystem.

## Layered view

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Renderer                                  │
│                                                                      │
│  ChatStreamStore({ id: topicId, transport: IpcChatTransport })       │
│    ├─ sendMessages      → ipcApi.request('ai.stream.open')            │
│    ├─ reconnectToStream → ipcApi.request('ai.stream.attach')          │
│    ├─ abort signal      → ipcApi.request('ai.stream.abort')           │
│    └─ stop()            → store abort + await ai.stream.abort         │
│                                                                      │
│  History:           useQuery('/topics/:topicId/messages') → DataApi   │
│  Topic-level state: useTopicStreamStatus → shared cache              │
│  Approval bridge:   useToolApprovalBridge → ai.tool.respond_approval │
└──────────────────────────────────────────────────────────────────────┘
                                 ↕ IPC (keyed by topicId)
┌──────────────────────────────────────────────────────────────────────┐
│                              Main                                    │
│                                                                      │
│  src/main/ipc/handlers/ai.ts — thin IpcApi transport adapters:       │
│    ├─ ai.stream.open   → AiStreamManager.dispatch                    │
│    ├─ ai.stream.attach → AiStreamManager.attach                      │
│    ├─ ai.stream.detach → AiStreamManager.detach                      │
│    ├─ ai.stream.abort  → await AiStreamManager.abortAndDrain         │
│    └─ ai.tool.respond_approval → AiService.respondToolApproval       │
│                                                                      │
│  dispatch (src/main/ai/streamManager/context/dispatch.ts)            │
│    pick ChatContextProvider → prepareDispatch → manager.send(...)     │
│                                                                      │
│  AiStreamManager                                                     │
│    activeStreams: Map<topicId, ActiveStream>                          │
│      listeners + executions                                          │
│    runs N StreamExecution loops, fan-out per chunk to listeners       │
│                                                                      │
│  runExecutionLoop (AiStreamManager) → AiService.streamText(req,signal)│
│    agent-session runtime → AgentSessionRuntimeService.openTurnStream  │
│    chat: tryStreamPiChatTurn (runtime/piChat/chatTurnSeam.ts) —       │
│      pi is the ONLY chat engine: a stream or an explicit error turn   │
│      (no legacy fallback; localized chat.errors.* streams /           │
│      i18n-keyed missing-key throw)                                    │
│      resolveChatTurnPlan (chatTurnPlan.ts) → assembleSystemPrompt     │
│      → prepareChatMessages → pi session stream (UIMessageChunk)       │
│    pipeStreamLoop tees:                                              │
│      • broadcast → WebContents / SSE / channel-adapter / persistence │
│      • readUIMessageStream → CherryUIMessage snapshot                │
│                                                                      │
│  Terminal listeners:                                                 │
│    PersistenceListener → MessageService / TemporaryChat backends     │
│    WebContentsListener  → ai.stream.done directed event              │
│    ChannelAdapterListener → adapter.onStreamComplete                 │
│    SseListener          → res.write('[DONE]')                        │
└──────────────────────────────────────────────────────────────────────┘
                                 ↓
                @earendil-works/pi-ai (pi chat engine)
                                 ↓
                          LLM provider API
```

## Sequence: a fresh chat turn

1. User hits send. `ChatStreamStore.sendMessage` (driven by
   `useChatWithHistory`) calls `IpcChatTransport.sendMessages`.
2. Transport packages `AiStreamOpenRequest`, dispatches via
   `streamDispatchService` over IpcApi `ai.stream.open`.
3. The `ai.stream.open` handler in `src/main/ipc/handlers/ai.ts` resolves the
   managed sender window, wraps it in a `WebContentsListener`, and calls
   `AiStreamManager.dispatch`.
4. `dispatchStreamRequest` picks the first `ChatContextProvider` whose
   `canHandle(topicId)` matches and asks it to `prepareDispatch`.
5. The provider resolves models, persists the user message for persistent chat
   or skips it for temporary chat, creates `PersistenceListener` per
   execution, returns `PreparedDispatch`.
6. `dispatch` reconciles any live stream, then calls `manager.send(input)`:
   - **chat resubmit** (topic already streaming): the provider persists the
     steer user row and `dispatch` calls `manager.enqueuePendingSteer(topicId)`;
     `send()` **injects** (just upserts the subscriber). The running turn yields
     cleanly (persisting as `success`) and `onExecutionDone` chains a
     `steer-continuation` — steering is enqueue + yield + chain, not
     abort-and-restart and not mid-turn injection.
   - **agent-session follow-up**: the stream is left running and `send()`
     **injects** — it upserts `listeners` onto the running stream, `models`
     ignored (the message was already enqueued on the session's `pendingTurns`).
   - **no live stream**: `send()` **starts** — evict any grace-period stream,
     create an `ActiveStream`, launch one `StreamExecution` per model.
7. For each `StreamExecution`, `AiStreamManager`'s private `runExecutionLoop`
   calls `AiService.streamText(request, signal)`. What happens next:
   - **Agent-session runtime requests** bypass the generic path:
     `streamText` calls `AgentSessionRuntimeService.openTurnStream()` so the
     registered driver can own the concrete agent runtime.
   - **Everything else** runs on the pi chat engine:
     `tryStreamPiChatTurn` (`runtime/piChat/chatTurnSeam.ts`) resolves the
     engine-agnostic turn plan (`resolveChatTurnPlan`, `chatTurnPlan.ts` —
     retained context, context settings, tool selection, web routing,
     reasoning, the tool-call limit), assembles the system prompt, prepares
     messages and attachments, and streams the turn on an in-memory pi
     session. There is no legacy fallback: a request the seam cannot serve
     fails explicitly — tool-carrying gateway requests, unsupported provider
     families, approval-resume-after-crash dispatches, and served lists not
     ending with a user message become one-chunk localized error streams
     (`chat.errors.*`), and a provider with no credential throws an
     i18n-keyed error the renderer renders as the localized missing-key UX.
   The engine emits the `UIMessageChunk` dialect through the unchanged
   trunk, and is deliberately not a driver-registry entry — a chat turn is
   stateless per execution.
8. `pipeStreamLoop` reads the chunk stream once, tees: broadcast to
   listeners, accumulate via `readUIMessageStream`.
9. On terminal (`done` / `error` / `aborted` / `awaiting-approval`):
   - `PersistenceListener` writes the final assistant message.
   - `WebContentsListener` sends `ai.stream.done` to subscribed windows.
   - Shared-cache `topic.stream.statuses.<topicId>` flips to the terminal status.
10. Renderer's `useQuery('/topics/:topicId/messages')` revalidates; the
    optimistic overlay is disposed.

## Sequence: tool approval pause + resume

1. The engine calls the tool with `needsApproval(args)` true and the
   assistant's auto-approve policy saying "ask". It writes an
   `approval-requested` part on the accumulated message and holds the
   promise.
2. Manager flips status to `awaiting-approval` on the shared cache.
3. Renderer's `useTopicAwaitingApproval(topicId)` returns true; the UI
   shows the approval card.
4. User decides → `useToolApprovalBridge` → `ai.tool.respond_approval`.
5. Main applies the decision to the anchor row, then resumes by holder:
   agent-session runtime resolves its registered approval entry; the pi
   chat engine's authorizer was holding the tool-call promise in-process,
   and the responder looks it up in the engine-neutral
   `toolApprovalRegistry` (`pi-chat:<executionId>` scope) to settle it —
   no re-dispatch happens. `AiService.respondToolApproval` still
   re-dispatches a `continue-conversation` for deferred MCP cards whose
   turn is already gone, but the pi seam serves those an explicit error
   turn (`chat.errors.approval_resume_gone`) — the user resends.
6. Status flips back to `streaming`; UI hides the card.

See [Tool Approval](./tool-approval.md) for invariants and the
overlay-vs-persist conditional write.

## Key subsystems

| Subsystem | Reference |
|---|---|
| Active-stream registry, listeners, persistence backends, reconnect, abort, grace-period eviction | [Stream Manager](./stream-manager.md) |
| Agent-session host plus Pi and DSH runtime drivers | [Agent Session Runtime](./agent-session-runtime.md) |
| `resolveChatTurnPlan` — selection, budgets, web-tool routing, reasoning invocation, custom parameters | [Chat Turn Plan](./params-pipeline.md) |
| Tool registry, MCP sync, meta-tools (`tool_search` / `tool_inspect` / `tool_invoke` / `tool_exec`), defer exposition | [Tool Registry](./tool-registry.md) |
| `Provider.endpointConfigs`, `endpointType` resolution, variant suffixes, custom providers | [Provider Resolution](./provider-resolution.md) |
| `adapterFamily` field, runtime resolver, write paths (catalog / migrator) | [Adapter Family](./adapter-family.md) |
| OTel span tree, pi provider spans, local projection, dev-tools view | [Observability](./observability.md) |
| `IpcChatTransport`, dispatch service, per-execution demux | [IPC Transport](./ipc-transport.md) |
| Approval flow, Main-as-writer invariant, persistent decisions | [Tool Approval](./tool-approval.md) |

## Invariants

- **Topic-level addressing.** Every IPC, broadcast, and shared-cache
  entry is keyed by `topicId`. A topic has at most one active stream;
  subscribers are equal — there is no "owner" window.
- **Main owns persistence.** Renderer closing or crashing does not abort
  the stream or lose data. `PersistenceListener` writes on terminal
  regardless of subscriber state.
- **Main owns approval state.** The renderer is never a writer.
- **Adapter family is per-endpoint.** Multi-endpoint relays may use
  different `@ai-sdk/*` packages on different endpoints under the same
  `provider.id`.
- **`tools/applies` predicates are pure.** They run on every
  `selectActive` pass; side effects there break tool selection
  determinism.

## Code map

```
src/main/ai/
├── AiService.ts                  ← provider operations, built-in tool init, approval decisions
├── chatTurnPlan.ts               ← engine-agnostic chat-turn plan (selection, context, reasoning, knobs)
├── runtime/                      ← piChat (pi chat engine), pi / dsh agent-session drivers
├── agentSession/                 ← agent-session topic host
├── agents/                       ← AgentJobsService, AgentTaskJobHandler, runAgentTask, prompt, heartbeat
├── channels/                     ← ChannelManager + IM adapters (discord/qq/slack/telegram/wechat) + security/
├── streamManager/                ← AiStreamManager, listeners, persistence, dispatch
├── provider/                     ← provider config, endpoint resolution, custom providers
├── mcp/                          ← McpRuntimeService / McpCatalogService, oauth, built-in servers
├── skills/                       ← SkillService, SkillInstaller
├── contextBuild/                 ← context policy, compression, persisted tool outputs
├── tokens/                       ← token estimators and modality profiles
├── tools/                        ← tool registry and runtime-specific adapters
├── observability/                ← AI trace adapters, local projection, sinks
├── messages/                     ← UI part ↔ model part conversion, replay views
├── types/                        ← AppProviderId, merged types, request types
└── utils/                        ← reasoning / model parameters / options / usage capture / websearch

src/main/ipc/handlers/ai.ts        ← IpcApi transport adapters
src/renderer/services/aiTransport/ ← IpcChatTransport, StreamDispatchService, overlays
src/renderer/hooks/               ← useChatWithHistory, useToolApprovalBridge, useTopicStreamStatus
packages/aiCore/                  ← @cherrystudio/ai-core (Agent + plugins + provider extensions)
packages/provider-registry/       ← provider catalog, registry-utils (adapterFamily inference)
```
