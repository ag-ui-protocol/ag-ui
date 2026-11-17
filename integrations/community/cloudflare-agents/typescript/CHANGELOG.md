# Changelog

## 0.1.0 — 2026-11-17

- Added `withAGUI(Agent)`: an Agents SDK agent serves AG-UI from its Durable Object over HTTP (SSE) and WebSocket, one thread per Durable Object, with the agent's state as the thread's shared state.
- Added `run.streamTextOptions()`, which passes the run's instructions (context, system messages, state), messages, client tools and abort signal to `streamText` in one spread. A run warns about anything the client sent that the handler never used.
- Added `AGUIRun.request`, the originating HTTP request, for header forwarding, auth and tracing.
- Reasoning is kept: REASONING events, reasoning messages in the snapshot, and provider data (thinking and thought signatures, OpenAI reasoning items) round-trips through `encryptedValue`.
- Tool approvals (AI SDK `toolApproval` / `needsApproval`) become AG-UI interrupts and resume statelessly. The Durable Object records pending approvals, so a resume cannot approve a call the model never made, and an approved tool runs at most once. A rejection's result carries the user's reason (`payload.reason`).
- The agent never answers client tool calls; `RUN_FINISHED` lists them in `pendingToolCallIds` (left out for pre-1.0 clients).
- `MESSAGES_SNAPSHOT` keeps each step's assistant message in order.
- Server-side state changes between runs are no longer overwritten by a client's stale copy.

### Breaking changes

- The `ai` peer is now `^6 || ^7` (was `^5`), as Agents SDK 0.33 requires.
- `CloudflareAgentsClient` now speaks the `ag-ui:*` WebSocket frames `withAGUI` serves. `AgentsToAGUIAdapter` and the SSE/NDJSON helpers remain, deprecated.
- Input members the protocol does not define are stripped with a warning, and malformed known fields are refused before the run starts (400 over HTTP).
- A resume that leaves a waiting approval unanswered, leaves out its call or sends a result for it is refused with `RUN_ERROR` `INVALID_RESUME`.

## 0.0.2 — 2026-10-12

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Adds a Durable Object example Worker, used by the AG-UI Dojo.
- The package now ships its MIT license file.

### Breaking changes

None.
