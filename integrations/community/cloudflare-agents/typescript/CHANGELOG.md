# Changelog

## 0.1.0 — 2026-11-17

- Added `withAGUI(Agent)` to serve AG-UI from a Cloudflare Agents Durable Object over HTTP (SSE) and WebSocket, with agent state as the thread's shared state.
- Added `run.streamTextOptions()` to pass instructions, messages, client tools, and abort signal to `streamText` in one call.
- Added `AGUIRun.request` exposing the originating HTTP request (body already read) for header forwarding, auth, and tracing.
- Approved tools now run exactly once via atomic claim in the Durable Object; a run failing before a claimed tool returns reopens the approval.
- Denied tool calls now carry the user's reason (`payload.reason`) in `TOOL_CALL_RESULT` and snapshot messages.
- `MESSAGES_SNAPSHOT` now records each step's assistant message in order instead of collapsing multi-step runs into one message.
- Tool errors after parsed arguments are preserved even when a server tool replaces a client tool of the same name.
- `pendingToolCallIds` is omitted for pre-1.0 clients (no declared `protocolVersion`) to avoid rejected outcome fields.
- README and Dojo Worker now use AI SDK v7 `streamText` `toolApproval`; Dojo Worker rebuilt on Agents SDK 0.33, AI SDK v7, and zod 4.
- Package now published via the pkg-pr-new preview workflow.

### Breaking changes

- Integration reworked around current Agents SDK and AI SDK v6/v7; serving now goes through `withAGUI`.
- Resume requests with a result for a call still awaiting approval are refused with `INVALID_RESUME`.
- Input members not defined by the protocol are stripped with a warning and no longer reach `RUN_STARTED.input` or `MESSAGES_SNAPSHOT`.
- Malformed known input fields now refuse the input before the run starts (400 over HTTP).
- Denial reason text changed from a fixed string to the user-supplied reason.
- Server-side state changes between runs are no longer applied as previously.

## 0.0.2 — 2026-10-12

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Adds a Durable Object example Worker, used by the AG-UI Dojo.
- The package now ships its MIT license file.

### Breaking changes

None.
