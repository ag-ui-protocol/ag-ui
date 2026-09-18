# Native Copilot SDK → AG-UI

Community adapter for `@github/copilot-sdk@1.0.14` (managed runtime `1.0.85`).
No CopilotKit dependency, credentials handling, React, HTTP framework, or arbitrary
shell access is included in the adapter.

## Usage

```ts
import { CopilotClient } from "@github/copilot-sdk";
import { CopilotAdapter, CopilotAgent } from "@ag-ui/copilot-sdk";

const client = new CopilotClient({ useLoggedInUser: true });
const adapter = new CopilotAdapter({ client, model: "gpt-5.4-mini" });
for await (const event of adapter.stream(runAgentInput, { signal })) {
  // Send the validated AG-UI event through your transport.
}
// Or use the ordinary AbstractAgent API:
const agent = new CopilotAgent(adapter, { threadId: "example" });

await adapter.close(); // owned native sessions and handlers
await client.stop();  // the application owns the client/runtime
```

Check model availability with `client.listModels()`: some runtimes silently
substitute an unavailable root model but reject it for a child agent. The
self-contained example defaults to `gpt-5.4-mini` and rejects unavailable models
rather than silently switching. `COPILOT_MODEL` is a validated override. The
adapter's default is also `gpt-5.4-mini`; hosts must check their own availability.

### Public API

- `CopilotEventMapper({threadId, runId, maxOutputBytes?, maxEvents?})`:
  `start()`, `mapEvent(event: CopilotSessionEvent): BaseEvent[]`, `finish(error?, cancelled?)`.
  `CopilotSessionEvent` accepts published SDK events plus the narrowly typed
  runtime `agent.interrupted` envelope missing from SDK 1.0.14's declarations.
  `start()` opts into run lifecycle events; standalone fixture projections that
  omit it get block closures only from `finish()`, not an unmatched run terminal.
  `restorePendingTool(id, name, arguments)` restores server-owned continuation
  metadata without replaying a call.
- `CopilotAdapter({client, model?, sessionConfig?, tools?, state?, ...limits})`:
  `stream(input, {signal?})` is an async generator; `cancelThread(threadId)` explicitly
  stops active **or parked** work; `close()` releases all owned sessions.
- `CopilotAgent(adapter, agentConfig?)` extends `AbstractAgent`; `run()` exposes an
  RxJS observable and `clone()` preserves the shared registry.
- `StateBridge` validates application-owned state at turn boundaries. Its optional
  prompt is included only with a new user turn. `ToolContext` provides
  `getState`, `setState(state, jsonPatch)`, `signal`, and explicit app-owned
  `emitActivity`. App activity metadata/output survive cancellation and native
  completion without marking the SDK tool completed or suppressing its result.
- `CopilotAdapterError.status` distinguishes invalid input, conflict, and capacity
  errors before a stream starts.

## Native frontend-tool continuation

AG-UI `input.tools` become **declaration-only** native SDK tools. The registry
observes `external_tool.requested` and retains the request ID privately. Once all
parallel frontend requests have arrived and other backend tools finish, it emits
`TOOL_CALL_END` and `RUN_FINISHED`. It does **not** fabricate a tool result.

A continuation supplies ordinary `role: "tool"` messages, one per pending
`toolCallId`, in any order. The registry validates the complete set before making
any RPC calls, then resolves each original
`session.rpc.tools.handlePendingToolCall({requestId, result})`. There is no
`session.send`, second user prompt, transcript replay, client-supplied native
session ID, or arbitrary pending request ID.

Backend tools also produce `external_tool.requested`; these stay owned by their
registered SDK handlers and are **not** handed to the browser. The registry scans
the complete replayed history. An exact already-answered frontend result is a
no-op: no pending RPC, SDK send, or model invocation. A replay-only request emits
only `RUN_STARTED`/successful `RUN_FINISHED`. A changed answer emits
`RUN_ERROR` with code `FRONTEND_TOOL_RESULT_CONFLICT`. New results can accompany
exact historical results; server-owned backend results are recognized separately.
Browser results already present in AG-UI input are not emitted again on native
completion, including later native echoes.

Partial batches are retained in a bounded server-owned answer map and return
successful `RUN_FINISHED` while the native session stays parked. The original
pending RPCs are submitted only when the **complete batch** is present, so a
partial answer cannot inadvertently resume the model. A new user turn mixed
with pending answers is rejected; complete the pending roundtrip first. Blank,
duplicate, or reused native frontend identities fail rather than minting IDs.
Parked tool definitions remain registered even when a continuation's tool list
no longer includes them.
Native request IDs retain bounded one-to-one ownership with their tool-call IDs,
including after resolution; missing IDs and cross-call reuse fail closed.

An ordinary completed SSE handoff keeps the native session parked. Disconnecting
an **active** stream cancels that run. Explicit Stop must call `cancelThread` (or
the examples' `POST /agent/cancel`) because disconnecting an already-finished HTTP stream
cannot cancel a parked call.

### Child-owned frontend handoff: verified mechanics, inferred interpretation

An ancestor task blocked on a child's browser tool can park with that child.
Before the successful root `RUN_FINISHED`, the adapter closes the child's stream
segment with `SUBAGENT_FINISHED` and `{type:"suspended"}`; the continuation
re-announces the **same native child identity** before emitting child events.
Root `RUN_FINISHED.outcome` remains absent: there is no AG-UI interrupt and no
`resume[]`.

This two-run sequence passes `@ag-ui/client@0.0.59`'s actual `verifyEvents`
operator in a regression test. Historical local native child-continuation probes
also observed the same child consuming the browser nonce, one SDK send/one pending RPC, exact
replay no-op, and changed-answer conflict. **Using `suspended` for a frontend-tool handoff is
an interpretation**, not a protocol guarantee: the field's documentation discusses
interrupt-backed suspension. CopilotKit browser/card continuity requires the
separate UI acceptance matrix; verifier acceptance alone does not establish it.

## Fidelity and bounds

- Typed allowlist: text/reasoning deltas and full-message fallback, tool calls and
  results, progress/output, subagent activities, errors and exactly one terminal.
  Unsupported lifecycle/telemetry/raw/provider events are omitted.
- Readable reasoning uses standard `REASONING_*`; opaque/encrypted reasoning and
  provider-native blocks are never broadcast. Message/reasoning IDs are scoped by
  actual native `agentId`.
  Every child text, reasoning, tool-call/args/end/result, and activity event also
  carries that identity as `subagentRunId`; root events omit the child attribution.
- Argument fragments are buffered until the authoritative tool name/arguments
  arrive. Argument fragments are never displayed as stdout.
- Tool activities use `ACTIVITY_SNAPSHOT`, message ID `activity:<toolCallId>`,
  activity type `copilot-sdk:tool`, and `{toolCallId, toolName, status, arguments?,
  command?, output, progress?, exitCode?, truncated, parentToolCallId?}`.
  Status is `running`, `completed`, `error`, or `cancelled`.
- Subagent activities use message ID `subagent:<toolCallId>`, activity type
  `copilot-sdk:subagent`, and `{toolCallId, agentName, status, description?,
  parentToolCallId?}`. Native `agentId`/spawn relationships are used, **never** the
  chronological event-envelope `parentId`.
  Standard `SUBAGENT_STARTED`/`SUBAGENT_FINISHED`/`SUBAGENT_ERROR` events accompany
  the activity snapshots; unfinished child segments are closed on handoff/error.
  Parent run IDs come only from children already announced in that mapper run;
  unknown root registry IDs and self-parent references are not emitted as ancestry.
- Native runtime 1.0.85 **shell** partial outputs are cumulative snapshots in live
  probes; explicit `shellToolInfo` or native bash/PowerShell names identify them.
  They replace their retained output; no prefix heuristic is used. Other tools follow the
  SDK's incremental `partialOutput` contract. Final results replace streamed
  output rather than duplicating it, preserving authoritative `result.content`
  and any runtime trailer. The shared explicit-empty-result case retains prior
  activity output while keeping the actual tool result empty.
- Default caps: 32 warm threads, 32 pending calls, 512 user turns per thread,
  20,000 SDK events per run, 64 KiB per text/argument/tool-output buffer, 1,024
  queued events / 1 MiB queue, 120-second run timeout. Output truncation is
  UTF-8-safe and labelled; excessive text/arguments fail rather than silently
  changing model content.
- A thread rejects overlapping runs, while independent threads run concurrently.
  Cancellation, consumer disconnect, mapping failure, and shutdown invalidate
  the native session and pending mappings. Idle sessions are reclaimed lazily
  after 15 minutes on subsequent requests.
- Native `abort` / `agent.interrupted` closes running activities as cancelled
  without requiring `tool.execution_complete` or inventing a result. A later
  idle event cannot turn that cancellation into successful completion.

This is a bounded **in-process** registry, not durable restart recovery. After
restart/expiry, a pending-tool continuation returns a conflict rather than silently
creating a new session. Tool declarations are fixed for new user turns on a warm
thread, while continuations retain their parked declarations. New user
turns send only the latest text user message; historic transcript import,
multimodal input, SDK slash commands, and arbitrary raw event forwarding are not
implemented. HTTP/authentication/deployment policies belong to the host.

## Validation and sample

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm exec nx run @ag-ui/copilot-sdk:build
pnpm exec nx run @ag-ui/copilot-sdk:test
```

Shared synthetic fixture projections are checked against `EventSchemas` and
the published client's canonical `verifyEvents`, including error envelopes,
nested child ancestry, and orphan reasoning closure before child termination.

The self-contained Dojo example requires no sibling checkout:

```sh
pnpm exec nx run @ag-ui/copilot-sdk:build-example
HOST=127.0.0.1 PORT=8028 node integrations/copilot-sdk/typescript/dist-example/server.js
```

This is native mode with existing inherited authentication. `HOST` defaults to
`127.0.0.1`, `PORT` to `8028`. Explicit `HOST=0.0.0.0` enables container/network
binding; use only a trusted network or add an authenticated gateway. The example
itself is unauthenticated and thread IDs are not an authorization mechanism.
It uses the managed runtime in `mode: "empty"` with isolated, gitignored
project-local `.copilot-sdk-runtime/<id>` storage, deleted on shutdown. It does
not overwrite the global CLI or login, grant shell/file access, or load ambient
tools. No sibling checkout, CopilotKit, or additional HTTP framework is required.

Endpoints: `POST http://127.0.0.1:8028/agent`,
`GET http://127.0.0.1:8028/health`, and
`POST http://127.0.0.1:8028/agent/cancel` (`/cancel` is an alias).
Native chat works with `tools: []`. For frontend continuation, declare only
`browser_nonce({}) → {nonce:string}`,
`browser_confirm({message:string}) → {approved:boolean,nonce:string}`, or the
existing Dojo Agentic Chat tool `change_background({background:string})` in
`RunAgentInput.tools`; return the browser's serialized answer in a tool-role
message on the same thread. Tool declarations have no SDK handlers. Unknown
frontend tool names are rejected, so they cannot enable native built-ins.
Loopback browser origins on ports 9999 (Dojo) and 3100 are allowed.

With the native server running, a self-contained, local-only probe validates chat,
two-request frontend continuation with a freshly minted nonce, exact full-history
replay, changed-answer/wrong-thread rejection, and the pinned AG-UI verifier;
it never submits the result as a new user message:

```sh
COPILOT_AGENT_URL=http://127.0.0.1:8028/agent node integrations/copilot-sdk/typescript/dist-example/probe.js
```

It generates local-only traces in this package's `evidence/self-contained-native.json`
and cancels its own threads afterward. Pointing it at another host instead writes
`evidence/standalone-native-http.json`, keeping host provenance separate. These
reports are ignored by Git and are not distributed. No browser is required or
restarted. Historical native observations are not fresh verification of the
current SDK pin; rerun native probes after dependency updates.

For credential-free CI, set `COPILOT_DEMO_MODE=fixture`. Health and startup output
explicitly label this as a **synthetic text fixture**: it exercises the adapter
and SSE transport but never starts a native runtime or pretends to implement
tools. Register **only `agentic_chat`** in Dojo initially. Custom application
state, commands, and frontend tools do not imply support for unrelated Dojo pages.
External application samples and their live acceptance evidence are outside this
package's distribution and deterministic test coverage.
