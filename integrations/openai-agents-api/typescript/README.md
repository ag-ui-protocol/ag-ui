# @ag-ui/openai-agents-api

Connect an [AG-UI](https://ag-ui.com) frontend to the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), OpenAI's managed agent runtime. Each AG-UI thread maps to one Agents API session. Each run sends the thread's new input to the session and streams the session's events back as AG-UI events.

## Installation

```bash
npm install @ag-ui/openai-agents-api openai
```

Requires `openai` ≥ 7.47.0 (the `client.beta.agents` namespace) and an API key with the `api.agents.read`, `api.agents.write` and `api.responses.write` scopes.

## Usage

```typescript
import { OpenAIAgentsAgent } from "@ag-ui/openai-agents-api";

const agent = new OpenAIAgentsAgent({
  agent: {
    model: "gpt-6-astra",
    instructions: "You are a helpful assistant.",
    tools: [{ type: "web_search" }],
  },
});

agent
  .run({ threadId, runId, messages, tools, state, context, forwardedProps })
  .subscribe({ next: (event) => console.log(event.type) });
```

The OpenAI client reads `OPENAI_API_KEY` from the environment. Pass `client` to supply your own. To run a saved agent (`client.beta.agents.create`), pass `savedAgentId` instead of (or together with) `agent`; `agent` fields then override the saved configuration for the session.

Serve it over HTTP with any AG-UI server setup, e.g. `EventEncoder` from `@ag-ui/encoder` (see `examples/server.ts`).

## What it does

| Agents API                                                    | AG-UI                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `message` items + `output_text.delta` / `.done`               | `TEXT_MESSAGE_START` / `CONTENT` / `END`                                                  |
| `reasoning` items + `reasoning_summary_*` events              | `REASONING_START` / `REASONING_MESSAGE_START` / `CONTENT` / `END` / `REASONING_END`       |
| `function_call` for a frontend tool                           | `TOOL_CALL_*`, then the run ends (`pendingToolCallIds`) so the client can run the tool    |
| `function_call` for a backend tool                            | `TOOL_CALL_*` + `TOOL_CALL_RESULT`; the handler's result is submitted back to the session |
| `web_search_call`, `mcp_call`, `command_execution`, subagents | `TOOL_CALL_*` + `TOOL_CALL_RESULT` (display only)                                         |
| `computer_use_approval_request`                               | `RUN_FINISHED` with an interrupt outcome                                                  |
| `turn.completed` / `session.idle`                             | `RUN_FINISHED`                                                                            |
| `turn.failed`, `session.failed`, `error`                      | `RUN_ERROR` with the API's error code                                                     |

### Frontend tools

`RunAgentInput.tools` are installed on the session as function tools, together with the backend tools and any configured built-in tools. When the list changes between runs the adapter replaces the session's tools (`sessions.update`), so a client can add or drop tools mid-conversation.

When the agent calls a frontend tool, the session parks in `requires_action` and the run ends. The client executes the tool and starts the next run with a `role: "tool"` message carrying `toolCallId`; the adapter submits it as the call's result and the **same turn** continues.

The Agents API reports parallel calls one at a time. The run therefore waits for a short quiet spell (`clientToolSettleMs`, default 1 s) before handing calls to the client; a call that arrives later is surfaced on the next run.

If the user sends a new message instead of answering a frontend call, the call is released with a neutral result so the session can move on.

### Backend tools

```typescript
new OpenAIAgentsAgent({
  agent: { model: "gpt-6-astra" },
  backendTools: [
    {
      name: "get_weather",
      description: "Get the weather for a location.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
      handler: async ({ location }, context) => {
        context.setState({ ...context.state, lastLocation: location }); // STATE_SNAPSHOT
        return { location, temperature: 21 };
      },
    },
  ],
});
```

A handler returns a string or any JSON value; a thrown error is reported to the agent as a failed result. The `context` gives access to the AG-UI state (`state`, `setState`), lets the handler `emit` any AG-UI event (`STATE_DELTA`, `CUSTOM`, ...), and carries an abort `signal`.

### Interrupts (human-in-the-loop)

Backend tools can pause the run and ask the user. The session stays parked on the tool call, so the pause is durable on OpenAI's side, and the interrupt id is the tool call id.

```typescript
{
  name: "schedule_meeting",
  description: "Schedule a meeting; the user picks the time.",
  parameters: { type: "object", properties: { topic: { type: "string" } } },
  handler: ({ topic }, context) => {
    if (!context.resume) {
      // Ends the run with RUN_FINISHED { outcome: { type: "interrupt", interrupts: [...] } }
      context.interrupt({ reason: "schedule_meeting", message: `Pick a time for ${topic}`, payload: { topic } });
    }
    // Invoked again on the run that carries RunAgentInput.resume for this interrupt.
    const answer = context.resume!.payload as { time: string };
    return `Scheduled ${topic} at ${answer.time}`;
  },
}
```

The interrupt carries `toolCallId`, `message`, `responseSchema` (if given) and `metadata: { toolName, arguments, payload, ...metadata }`.

**Tool approval.** Set `requiresApproval: true` (or a predicate over the arguments) to gate a tool. The call is surfaced as an interrupt with `reason: "tool_approval"`. Resuming with `status: "resolved"` runs the handler (with `payload.editedArgs` when present); `payload.approved === false`, `status: "cancelled"` or a new user message rejects it and the agent is told the tool did not run.

**Computer use.** Native `computer_use_approval_request` actions become interrupts with `reason: "openai_agents:computer_use_approval"` and the request under `metadata.request`. The resume payload is sent as the approval `response` (e.g. `{ "decision": "approve" }`).

### Context and state

The Agents API has no per-turn instructions, so `RunAgentInput.context` entries and the shared `state` are sent as an extra text part ahead of each new user message (`<application_context>` / `<application_state>`). Set `forwardState: false` to keep state out of the prompt.

`predictState: [{ stateKey, tool, toolArgument }]` publishes a tool's argument as predicted state: a `PredictState` custom event before the call and a `STATE_SNAPSHOT` from the final arguments before `TOOL_CALL_END`. The Agents API does not stream function arguments, so the prediction lands in one step.

`extractLinkCitations: true` attaches the markdown links in each answer as `metadata.citations` on `TEXT_MESSAGE_END` (the Agents API returns web search sources as inline links).

### Conversation state

History lives in the session. Only user messages the session has not seen are sent. When a thread has no session yet (first contact, or the store was lost), the earlier conversation is sent as a transcript with the newest user message.

## Options

| Option                 | Default             |                                                                                          |
| ---------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `agent`                | –                   | Inline agent settings (`model`, `instructions`, `tools`, `reasoning`, `text`, ...).      |
| `savedAgentId`         | –                   | A saved agent to run. Either this or `agent.model` is required.                          |
| `environment`          | `{ type: "none" }`  | Execution environment for new sessions (`openai_hosted`, `self_hosted`, ...).            |
| `client`               | `new OpenAI()`      | Bring your own OpenAI client.                                                            |
| `backendTools`         | `[]`                | Server-executed function tools.                                                          |
| `predictState`         | `[]`                | Tool arguments to publish as predicted state.                                            |
| `forwardState`         | `true`              | Send `RunAgentInput.state` with each user message.                                       |
| `extractLinkCitations` | `false`             | Attach answer links as `metadata.citations`.                                             |
| `sessionStore`         | in-memory (bounded) | Thread ↔ session mapping. Provide your own to survive restarts or run several replicas. |
| `sessionMetadata`      | –                   | Metadata for created sessions (the thread id is added as `ag_ui_thread_id`).             |
| `vaultIds`             | –                   | Vaults with credentials the session may use.                                             |
| `clientToolSettleMs`   | `1000`              | Quiet spell before a run hands parked calls to the client.                               |
| `runTimeoutMs`         | 10 minutes          | Cancel the turn and fail the run after this long.                                        |
| `onError`              | `console.error`     | Notified about failures the adapter recovers from.                                       |

## Security

AG-UI thread ids are client-supplied, so a thread id works like a bearer token for its session. Put the endpoint behind your own authentication and, in multi-tenant setups, give each caller its own `sessionStore` (or prefix keys with the caller's identity) so one caller cannot resume another's session. API error messages from OpenAI are relayed in `RUN_ERROR`; other failures are reported to `onError` and the client gets a generic message.

## Notes

- Runs are serialized per thread within a store. A second run on a busy thread waits for the first.
- When the client disconnects or calls `abortRun()` mid-run, the adapter cancels the session's turn (`agent.session.input.cancel`).
- Opening a session's event stream replays the active turn; the adapter remembers which items it has surfaced and drops the replay.
- Only text and images reach the agent; other attachment types are replaced by a short note.
- The default store is in memory: restarting the process starts new sessions (seeded with the transcript the client sends). Sessions themselves persist on OpenAI's side.

## Running the examples

The examples serve every AG-UI Dojo feature from one server. Agents are defined inline in `examples/agents.ts`, so there is nothing to provision.

```bash
cd integrations/openai-agents-api/typescript
pnpm install
export OPENAI_API_KEY=sk-...
pnpm dev:examples   # http://localhost:8027 (LOG_EVENTS=1 prints every event)
```

`OPENAI_AGENTS_MODEL` overrides the model (default `gpt-6-astra`).
