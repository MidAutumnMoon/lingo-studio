---
description: OTel tracing for AI calls and agent runtimes — Cherry-owned turn roots, pi chat engine provider spans, pi/dsh runtime spans, HTTP fetch tracing, local projection, and sinks
sources:
  - src/main/ai/observability
---

# Observability

The `src/main/ai/observability/` subsystem: OTel tracing, the local span
projection, and the sink registry. "Trace / telemetry" is the
user-facing surface; this doc covers the whole subsystem.

## What's instrumented

When developer mode is enabled and a topic trace context exists, a chat turn
produces an OpenTelemetry span tree of Cherry-owned spans:

```
chat.turn                                      (root, created by context provider)
├── pi.generate_content                        (pi chat engine, provider stream boundary)
│   └── gen_ai.usage.* / response model / id / finish reasons
└── attributes: topicId, modelName, …          (set by AiTurnTrace / turn span attributes)
```

Cherry owns every span. The root span comes from `AiTurnTrace` (the context
provider); the pi chat engine creates the `pi.generate_content` provider span
under the trunk's active context (`runExecutionLoop` wraps the execution in
its root span) — a no-op when developer-mode tracing is off. AI SDK
auto-spans (`ai.streamText`, `ai.toolCall`, …) are gone with the legacy
engine: nothing attaches `experimental_telemetry` anymore.

The main-process observability boundary is `src/main/ai/observability`:

- `runtime/` registers the developer-mode-gated global tracer provider
  (`NodeTraceService` → `NodeTracer` + `CacheBatchSpanProcessor`).
- `core/` creates Cherry-owned turn roots and common `cs.*` attributes.
- `storage/` keeps the in-memory span projection and JSONL-compatible history.
- `sinks/` defines the extension point for local and future external export.
- `adapters/aiSdk/` interprets AI SDK child spans — retained, but unwired
  since the legacy engine's telemetry option was deleted.

## Local history flush

The container `traceId` is persisted on the topic / agent-session row (one trace
tree per container), but the span tree is first collected in the main-process
`TraceStorageService` memory store.
The durable history file is written by the stream terminal path:

- `PersistentChatContextProvider` attaches a `TraceFlushListener` to normal
  chat turns.
- `AgentSessionRuntimeService` attaches the same listener to
  `agent-session:${sessionId}` turns, including queued follow-up turns.
- On the topic-level terminal event (`done`, `paused`, or `error`),
  `TraceFlushListener` calls `TraceStorageService.saveSpans(topicId)`.
- Flush errors are logged as warnings and do not affect message completion.

Collection and persistence are main-process only. Spans live in
`TraceStorageService`'s in-memory store and are flushed to the JSONL history file
on the terminal event. The renderer trace viewer (`TracePage`) reads the persisted
spans on demand through the `trace.getData` IPC — it never collects spans itself.

Trace history is stored under `{userData}/Runtime/trace/<topicId>/<traceId>`.
The previous `~/.cherrystudio/trace` location is no longer written; it remains a
cleanup-only target of the `normal_cache` (App cache) option.

## Span sources

- **pi chat engine** (`runtime/piChat/chatEngine.ts`): one
  `pi.generate_content` span per provider stream, started under the trunk's
  active context and annotated on completion with `gen_ai.usage.*`
  (input / output / cache-read / cache-write / reasoning), response model and
  id, and finish reasons. Errors set the span status and record the
  exception. A no-op when developer-mode tracing is off (`span.isRecording()`).
- **Pi agent runtime** (`runtime/pi/PiRuntimeConnection.ts`): Pi has no
  native OTel exporter, so the connection creates Cherry-owned
  `pi.generate_content` spans at the provider stream boundary and
  `pi.execute_tool` spans from Pi's tool lifecycle events. These spans use
  the agent-session trace context and flow through the existing
  `NodeTraceService` and `TraceStorageService`; parallel tool calls are
  tracked by tool-call id and unfinished spans are closed when the
  connection ends.
- **DSH runtime**: Cherry-owned spans instead of an external OTLP adapter.
  `DshTraceRecorder` records `dsh.generate_content`, tool, compaction, and
  child runtime spans under the agent-session trace root, refreshes its
  trace context between turns, and closes unfinished spans when the
  connection ends.
- **HTTP fetch tracing** (`httpTraceFetch.ts`): `applyHttpTrace` wraps the
  provider `settings.fetch` on the aiCore lanes (embedding / rerank / image
  and one-shot transport resolution) with an `http.request` span capturing
  the raw URL, method, redacted headers, and truncated request/response
  bodies. Developer-mode gated.

All of them land in the same place: the global tracer provider registered by
`NodeTraceService` feeds `CacheBatchSpanProcessor` → `TraceStorageService`,
which converts spans through `core/spanConvert.ts`.

## Developer-mode gating

Dev mode only. The span projection (`TraceStorageService`) is built and persisted
in the main process; the renderer trace viewer (`TracePage`) reads it on demand via
the `trace.getData` IPC. Outside developer mode `NodeTraceService` never
registers a tracer provider, so **no tracer is attached at all** and every
span source above is a no-op — there is nothing
to project, and the viewer shows an empty trace.

## Where to read more

- Code: `src/main/ai/observability/`
- Span projection: `src/main/ai/observability/storage/TraceStorageService.ts`
