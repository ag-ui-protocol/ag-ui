# AG-UI ⨯ GitHub Copilot SDK

Implementation of the [AG-UI protocol](https://docs.ag-ui.com) for the native
[GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk), in
Python and TypeScript.

| SDK | Package | Port |
|-----|---------|------|
| Python | [`python/`](./python) — `ag_ui_copilot_sdk` | 8027 |
| TypeScript | [`typescript/`](./typescript) — `@ag-ui/copilot-sdk` | 8028 |

Both expose the same surface: one native Copilot session per AG-UI thread, with
`agent.run(input)` streaming AG-UI events.

## Frontend tools and the pending-tool mechanism

This is the piece worth understanding. A tool registered with the Copilot SDK
**without a handler** is not executed by the runtime — the call is suspended and
surfaced as an `external_tool.requested` event carrying a native `requestId`.

That maps onto AG-UI's browser-executed tools as follows:

1. The model calls a frontend tool. The adapter emits `TOOL_CALL_START` /
   `TOOL_CALL_ARGS` / `TOOL_CALL_END` and then `RUN_FINISHED`, leaving the
   native call suspended.
2. The browser executes the tool and sends the next `RunAgentInput`, which
   carries a `role: "tool"` message.
3. The adapter resolves the **original** suspended RPC with
   `session.rpc.tools.handlePendingToolCall({ requestId, result })`
   (`handle_pending_tool_call` in Python). The result is never re-prompted as
   user text, so the model continues the same turn.

The native `requestId` and the AG-UI `toolCallId` are distinct identifiers; the
adapter keeps the mapping between them.

**Known limitation:** that mapping lives in an in-process registry. A server
restart between the handoff and the browser's answer drops the suspended call,
and the affected run ends with `RUN_ERROR`. There is no durable recovery.

## Model access

By default the SDK uses the machine's logged-in Copilot account. Set
`OPENAI_BASE_URL` (and `OPENAI_API_KEY`) to route inference at any
OpenAI-compatible endpoint through the SDK's BYOK provider instead — this is how
the Dojo e2e suites drive both servers against the repository's pinned mock model
server. `OPENAI_CHAT_MODEL_ID` selects the wire model (default `gpt-4o`).

## Dojo

Both integrations currently serve the `agentic_chat` feature. Additional Dojo
features are planned as a follow-up.

```bash
node apps/dojo/scripts/run-dojo-everything.js --only dojo,copilot-sdk-python
node apps/dojo/scripts/run-dojo-everything.js --only dojo,copilot-sdk-typescript
```
