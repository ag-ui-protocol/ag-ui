# Subagent Support in AG-UI — Design

Status: Approved for implementation planning
Date: 2026-07-07
Scope: TypeScript SDK (full) + Python SDK (schema mirror). .NET deferred.

## Summary

S&P Global needs subagents: a parent agent that delegates work to specialized
child agents, streamed over one AG-UI connection.

Nesting `RUN_STARTED` / `RUN_FINISHED` does not work — a flat run lifecycle is
assumed in dozens of places across the SDKs and middlewares. Instead we add
subagents as an additive layer *inside* one flat run, in two
backwards-compatible phases:

1. **Attribution** — a `subagentId` on creation/standalone events, carried onto
   the resulting messages.
2. **Lifecycle** — explicit `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` /
   `SUBAGENT_ERROR` events.

The run lifecycle never changes: one `RUN_STARTED`, one `RUN_FINISHED`.

## Goals

1. Let a parent agent stream its subagents' work over one run.
2. Let the receiver attribute every event — and every resulting message — to the
   agent that produced it.
3. Keep the run lifecycle flat and unchanged.
4. Ship without breaking any existing consumer or middleware.
5. Unblock S&P Global on Phase 1 alone.

## Non-Goals

- Nesting `RUN_STARTED` / `RUN_FINISHED`.
- Requiring any consumer or middleware to change to keep working.
- Denormalizing subagent name/description onto messages.
- Full CopilotKit/UI support.
- .NET SDK changes (tracked as a follow-up).

## Design Decisions

These decisions were settled during brainstorming and drive the spec:

- **D1 — Attribution is `subagentId` only, everywhere.** An opaque, unique
  handle for one subagent invocation (not a display name). Two concurrent
  invocations of the same subagent stay distinct. Name/description live only on
  the Phase 2 lifecycle events.
- **D2 — Attribution lives on messages, not only events.** Messages are the
  durable, round-tripping artifact; events are transient. The message carries
  `subagentId` so attribution survives history / `MESSAGES_SNAPSHOT`. Just the
  id — no denormalized name (grouping needs only the id; a name can be added
  additively later if a concrete render-from-history-without-registry need
  appears).
- **D3 — `subagentId` goes on creation + standalone events, not continuation
  events.** Continuation events (`*_CONTENT`, `*_END`, `TOOL_CALL_ARGS`, etc.)
  reference a pre-existing entity by id and inherit attribution transitively.
- **D4 — Apply-time transfer.** When a creation event mints a message, its
  `subagentId` is copied onto that message. This is the mechanism behind D2.
- **D5 — `TOOL_CALL_RESULT` is a creation event.** It both references a tool
  call and mints a new tool message; it carries `subagentId` explicitly so
  attribution is correct even when the executor differs from the caller (e.g.
  client-side/frontend tool execution).
- **D6 — Lifecycle events are enforced-when-present.** Optional to use (Phase 1
  alone is valid), but if used the verifier enforces consistency.
- **D7 — Both phases are designed now; TS + Python implemented now.**

## Approach: keep the run flat

- One run stays exactly as today: one `RUN_STARTED`, one `RUN_FINISHED` (or
  `RUN_ERROR`).
- Subagents become attribution + lifecycle *inside* that one run.
- Old consumers that ignore the new pieces still see a coherent flat stream.
- New consumers can group events/messages by subagent, render nested progress,
  and handle subagent errors.

## Phase 1 — Attribution

### 1a. Event-level `subagentId`

Add an optional `subagentId?: string` to **creation and standalone** events
only. The classifying principle: an event carries `subagentId` iff it (a)
creates a new entity, or (b) is a standalone event not bound to a pre-existing
entity. Pure continuations that reference an entity by id inherit and do not
carry it.

| Event | Carries `subagentId`? | Rationale |
|---|---|---|
| `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` | No | Run lifecycle stays flat / parent-owned |
| `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CHUNK` | Yes | Creates a message |
| `TOOL_CALL_START` / `TOOL_CALL_CHUNK` | Yes | Creates / attaches a tool call |
| `TOOL_CALL_RESULT` | Yes | Creates a tool message (D5) |
| `REASONING_START` / `REASONING_MESSAGE_START` | Yes | Creates a reasoning entity |
| `ACTIVITY_SNAPSHOT` | Yes | Creates an activity message |
| `STATE_SNAPSHOT` / `STATE_DELTA` | Yes | Standalone |
| `STEP_STARTED` / `STEP_FINISHED` | Yes | Standalone |
| `CUSTOM` / `RAW` | Yes | Standalone |
| `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` | No | Inherit via `messageId` |
| `TOOL_CALL_ARGS` / `TOOL_CALL_END` | No | Inherit via `toolCallId` |
| `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` / `REASONING_END` | No | Inherit via `messageId` |
| `ACTIVITY_DELTA` | No | Inherit via `messageId` |
| `REASONING_ENCRYPTED_VALUE` | No | Inherit via `entityId` |
| `MESSAGES_SNAPSHOT` | No (event-level) | Attribution rides inside each message object |

Deprecated `THINKING_*` events are not extended (superseded by `REASONING_*`).

Semantics:
- No `subagentId` means the event belongs to the parent agent, exactly as today.
- `subagentId` is opaque and unique per subagent invocation.

### 1b. Message-level `subagentId`

Add an optional `subagentId?: string` to the message model — `BaseMessage`
(covers developer/system/assistant/user) plus `ToolMessage`, `ActivityMessage`,
and `ReasoningMessage` (which do not extend `BaseMessage`).

In TypeScript this requires an explicit field: `BaseMessageSchema` is a plain
`z.object` and Zod strips unknown keys, so the field will not pass through on
its own. In Python `ConfiguredBaseModel` uses `extra="allow"`, but we add the
field explicitly for typing and parity. The wire form is always camelCase
`subagentId` (Python `subagent_id` via `alias_generator=to_camel`).

### 1c. Apply-time transfer (D4)

In `defaultApplyEvents` (TS client, `apply/default.ts`): when a creation event
mints a new message, copy `event.subagentId` onto the created message. This
touches the message-creating branches only:
- `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CHUNK` → assistant/user/etc. message
- `TOOL_CALL_START` / `TOOL_CALL_CHUNK` → the assistant message that owns the
  tool call (created via `resolveOrCreateAssistantMessage`)
- `TOOL_CALL_RESULT` → the new tool message
- `REASONING_MESSAGE_START` → reasoning message
- `ACTIVITY_SNAPSHOT` → activity message

The copy happens **only when the message is newly created**. If a creation
event resolves to a pre-existing message (e.g. `TOOL_CALL_START` whose
`parentMessageId` already matches an assistant message, or a `TEXT_MESSAGE_START`
for an id that already exists), the existing message's `subagentId` is left
untouched — it is not overwritten.

Continuation events do not touch `subagentId`; the message already carries it.
`MESSAGES_SNAPSHOT` messages keep whatever `subagentId` they arrive with.

### 1d. Verification & interleaving

No verifier changes are needed for attribution. The verifier already permits
interleaving: `activeMessages` / `activeToolCalls` are keyed by id, so multiple
messages / tool calls can be open concurrently. It only rejects reusing the same
id or leaving an entity open at `RUN_FINISHED`.

**New documented requirement:** subagents MUST emit globally-unique
`messageId` / `toolCallId` values within a run, so concurrent/interleaved
subagent output does not collide. (The deprecated `THINKING_*` flow uses boolean
state and cannot interleave; the new `REASONING_*` events are not verified for
interleaving, so they are unaffected.)

### Consuming Phase 1 (S&P Global's first step)

Once agents emit `subagentId`, a consumer can use it with no deeper
CopilotKit/UI support:
- Get the agent via `useAgent()`, register an `AgentSubscriber`.
- In `onEvent` (or via the resulting messages), read `subagentId` and group or
  annotate the message history by subagent.

## Phase 2 — Subagent lifecycle events

Three new event types, parallel to the run lifecycle but separate from it:

- `SUBAGENT_STARTED` — `subagentId`, `name`, `description?`, `parentSubagentId?`
- `SUBAGENT_FINISHED` — `subagentId`
- `SUBAGENT_ERROR` — `subagentId`, `message`, `code?`

`parentSubagentId` supports subagents that invoke subagents — mirrors `runId` +
`parentRunId` on `RUN_STARTED`.

### Verification (D6 — enforced-when-present)

Lifecycle events are optional; a Phase-1-only stream (subagentId on events, no
lifecycle events) stays valid. When lifecycle events are present, the verifier
enforces:

- No duplicate `SUBAGENT_STARTED` for the same `subagentId`.
- `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` must match a prior `SUBAGENT_STARTED`.
- `parentSubagentId` must reference a subagent that has been started.
- All opened subagents must be closed (`FINISHED` or `ERROR`) before
  `RUN_FINISHED` — mirroring the existing steps/messages/tool-calls checks.

Subagent boundaries are **not** run boundaries: no stream auto-close, compaction
flush, single-held `RUN_FINISHED`, or run-level telemetry span is affected.
Telemetry may open child spans keyed by `subagentId`.

### Consumer surface

Add optional typed hooks to `AgentSubscriber`:
`onSubagentStartedEvent`, `onSubagentFinishedEvent`, `onSubagentErrorEvent`.
`defaultApplyEvents` runs these hooks but performs no message/state mutation for
lifecycle events (name/description are not persisted, per D2). Phase-1-only
consumers remain unaffected.

## SDK scope

**TypeScript (full):**
- `packages/core/src/events.ts` — `subagentId` on the classified events; three
  new lifecycle event schemas + `EventType` enum entries; add to
  `EventSchemas` union, `AGUIEventByType`, and the `*Props` / inferred-type
  exports.
- `packages/core/src/types.ts` — `subagentId` on `BaseMessageSchema`,
  `ToolMessageSchema`, `ActivityMessageSchema`, `ReasoningMessageSchema`.
- `packages/core/src/event-factories.ts` — factories for the new events.
- `packages/client/src/apply/default.ts` — copy `subagentId` onto created
  messages; run new subagent-lifecycle subscriber hooks.
- `packages/client/src/verify/verify.ts` — enforced-when-present lifecycle
  checks + `RUN_FINISHED` closed-subagents check.
- `packages/client/src/agent/subscriber.ts` — new optional hooks.

**Python (schema mirror only):**
- `sdks/python/ag_ui/core/events.py` — `subagent_id` on the classified events;
  three new lifecycle event classes; `EventType` enum entries; discriminated
  union / `Event` alias updates.
- `sdks/python/ag_ui/core/types.py` — `subagent_id` on `BaseMessage`,
  `ToolMessage`, `ActivityMessage`, `ReasoningMessage`.
- No apply/verify (those are client-only, TS).

## Backwards compatibility

- **Phase 1 (optional `subagentId` fields) is transparently backwards-compatible.**
  Old producers never set it; old consumers ignore it. Zod *strips* unknown
  fields (asserted in `core/__tests__/backwards-compatibility.test.ts`), and the
  backward-compat middlewares spread the rest of the message/input, so an extra
  `subagentId` rides through untouched. This is why Phase 1 is separately shippable.
- **Phase 2 (new `SUBAGENT_*` event types) is NOT silently ignored by an older
  consumer.** Correction to an earlier draft claim: the decode path validates every
  event against the closed `EventSchemas` discriminated union
  (`client/src/transform/http.ts:55`, `proto/src/proto.ts:199,355`) and *errors the
  stream* on an unknown `type` — a discriminated union rejects an unknown
  discriminator. So a genuinely-old consumer (whose union predates `SUBAGENT_*`)
  would throw, not gracefully skip. This is inherent to adding *any* new event type
  in AG-UI (same for `REASONING_*`, `ACTIVITY_*`, `TOOL_CALL_RESULT`) and is governed
  by **producer/consumer version negotiation**, not graceful-ignore. A consumer on
  the same (post-change) SDK has `SUBAGENT_*` in its union and is unaffected.
- **Downgrade path:** `BackwardCompatibility_0_0_57` (client middleware, gated at
  `maxVersion <= 0.0.57`) adapts a subagent-aware client talking to a pre-subagent
  remote agent — stripping `subagentId` from input messages and dropping `SUBAGENT_*`
  events (and stripping `subagentId`) from the output. It does not retroactively fix
  a genuinely-old consumer receiving new events from a new producer.
- The run lifecycle is untouched, so no audited breakpoint is in play.
- Subagent boundaries are not run boundaries, so run-boundary logic (stream
  auto-close, compaction flush, the single held `RUN_FINISHED`, the run
  telemetry span) is unaffected.

## Testing

- **Attribution copy:** each creation event type → resulting message carries the
  event's `subagentId`.
- **Continuation inheritance:** `*_CONTENT` / `*_END` / `TOOL_CALL_ARGS` do not
  clear or alter the message's `subagentId`.
- **`TOOL_CALL_RESULT`:** tool message carries its own `subagentId` (D5),
  including when it differs from the owning tool call's subagent.
- **Interleaving:** two concurrent subagents streaming distinct
  message/tool-call ids produce correctly attributed, non-colliding messages.
- **`MESSAGES_SNAPSHOT` round-trip:** `subagentId` on each message survives
  snapshot → apply.
- **Lifecycle enforcement:** duplicate `STARTED`, orphan `FINISHED`/`ERROR`,
  unknown `parentSubagentId`, and unclosed-subagent-at-`RUN_FINISHED` all throw;
  a Phase-1-only stream (no lifecycle events) passes.
- **Backwards compat:** streams with and without `subagentId` both apply;
  lifecycle-free streams verify.
- **TS ↔ Python schema parity:** field names, camelCase wire form, event shapes,
  and discriminated-union membership match.
