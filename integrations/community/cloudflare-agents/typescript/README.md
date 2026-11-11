# @ag-ui/cloudflare-agents

Serve [AG-UI](https://docs.ag-ui.com) from [Cloudflare Agents](https://developers.cloudflare.com/agents/): any AG-UI client, such as CopilotKit, can talk to an Agents SDK agent running on Workers and Durable Objects. The [AI SDK](https://ai-sdk.dev) does the model work, so every AI SDK provider works, Workers AI included.

```ts
import { Agent, routeAgentRequest } from "agents";
import { withAGUI, type AGUIRun } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

type State = { todos: string[] };

export class Assistant extends withAGUI(Agent<Env, State>) {
  initialState: State = { todos: [] };

  onAGUIRun(run: AGUIRun<State>) {
    return streamText({
      model: createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-4-scout-17b-16e-instruct"),
      instructions: run.instructions("You are a helpful assistant."),
      messages: run.messages,
      tools: { ...run.clientTools },
      abortSignal: run.abortSignal,
    });
  }
}

export default {
  fetch: async (request, env) =>
    (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
```

Each AG-UI thread is one instance of the agent (one Durable Object), at `/agents/assistant/<threadId>`.

## What you get

- **Messages, as the model needs them.** `run.messages` holds the client's conversation as AI SDK model messages: text, images, audio, video and documents, tool calls and their results.
- **Client tools.** `run.clientTools` holds the tools the frontend runs (CopilotKit's `useFrontendTool`, `useHumanInTheLoop`, generative UI renderers) as AI SDK tools without `execute`. When the model calls one, the run ends; the client runs it and sends the result with the next run.
- **Context.** `run.instructions(base)` adds the application's context (`useAgentContext`), the conversation's system messages and the shared state to your instructions. AI SDK v7 does not accept system messages inside `messages`, so they belong here.
- **Shared state, kept in the Durable Object.** The agent's `state` is the thread's AG-UI state. The client's edits are saved into it, every `this.setState()` during a run reaches the client as a STATE_SNAPSHOT, and a client that comes back to the thread gets it. What the server changes between runs (a schedule, another client) is kept: the client's copy only wins when the client changed it.
- **Reasoning that survives the round trip.** Reasoning streams as `REASONING_*` events and stays in the history. Provider data that has to come back on the next request (Anthropic's thinking signatures, Gemini's thought signatures on tool calls, OpenAI's reasoning and message items) travels in AG-UI's `encryptedValue` and is restored as `providerOptions`, so extended thinking with tools works across client tool round trips.
- **Tool approvals as AG-UI interrupts.** A tool with AI SDK's `needsApproval` ends the run with an interrupt; the client's answer resumes it, and the AI SDK runs (or skips) the tool. The paused run is not kept anywhere: the conversation and the answer are all a resume needs. A Durable Object agent records which calls it paused, so a client cannot get a call approved that the model never made.
- **Everything else in the stream.** Multi-step runs (`stopWhen`) with messages in order, streaming tool arguments, tool results and errors, token usage on `RUN_FINISHED`, cancellation (`RUN_FINISHED` with a `cancelled` outcome), sources and files as `CUSTOM` events.

Supports AI SDK v6 and v7, and AG-UI 1.0.

## Install

```bash
npm install @ag-ui/cloudflare-agents agents ai
```

## Connect a client

The agent serves AG-UI at `/agents/<agent>/<threadId>`, over HTTP (Server-Sent Events) and over the agent's WebSocket.

**CopilotKit, or any AG-UI client in your app:** `CloudflareAgentsHttpAgent` adds the thread id to the URL for you.

```ts
import { CloudflareAgentsHttpAgent } from "@ag-ui/cloudflare-agents/client";

const runtime = new CopilotRuntime({
  agents: {
    assistant: new CloudflareAgentsHttpAgent({
      url: "https://my-worker.example.workers.dev/agents/assistant",
    }),
  },
});
```

**A plain `HttpAgent` with one fixed URL:** let the Worker move the thread id from the request body into the path.

```ts
import { toThreadRequest } from "@ag-ui/cloudflare-agents";

export default {
  fetch: async (request, env) =>
    (await routeAgentRequest(await toThreadRequest(request), env)) ??
    new Response("Not found", { status: 404 }),
};
```

**WebSocket:** `CloudflareAgentsClient` runs over the agent's WebSocket, next to the Agents SDK's own protocol. One connection per run.

```ts
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents/client";

const agent = new CloudflareAgentsClient({
  url: "wss://my-worker.example.workers.dev/agents/assistant",
});
```

`@ag-ui/cloudflare-agents/client` runs anywhere (browsers, Node, Workers) and does not load the Agents SDK or the AI SDK.

## The run

`onAGUIRun(run)` gets one `AGUIRun` per request and returns the result of `streamText` (or of an AI SDK agent's `stream()`):

| Field | |
|---|---|
| `run.messages` | The conversation as AI SDK `ModelMessage[]`. |
| `run.clientTools` | The client's tools, without `execute`. Spread your server tools after them, so a server tool wins a name clash. |
| `run.instructions(base?, { state? })` | `base`, the conversation's system messages, the application's context and the shared state (leave it out with `{ state: false }`). |
| `run.context` | `RunAgentInput.context`. |
| `run.state` / `run.setState(state)` | The shared state. In a `withAGUI` agent these are `this.state` and `this.setState()`. |
| `run.emit(event)` | Streams an extra AG-UI event, such as a `CUSTOM` event. |
| `run.abortSignal` | Fires when the client cancels or disconnects. Pass it to `streamText`. |
| `run.input` | The `RunAgentInput` as sent. |
| `run.request` | The HTTP request the run came in on, for its headers (undefined over a WebSocket). |

### Shared state

```ts
export class Chef extends withAGUI(Agent<Env, { recipe?: Recipe }>) {
  onAGUIRun(run: AGUIRun<{ recipe?: Recipe }>) {
    return streamText({
      model,
      instructions: run.instructions("You help the user build the recipe shown next to the chat."),
      messages: run.messages,
      tools: {
        ...run.clientTools,
        save_recipe: tool({
          inputSchema: recipeSchema,
          execute: async (recipe) => {
            this.setState({ ...this.state, recipe }); // streams to the client, and persists
            return "Saved.";
          },
        }),
      },
      stopWhen: stepCountIs(5),
      abortSignal: run.abortSignal,
    });
  }
}
```

A tool can update the state several times while it runs (a plan whose steps complete one by one); each update streams at once. For state that follows a tool's arguments as the model writes them, update it from the tool's `onInputDelta`.

### Tool approvals

```ts
issue_refund: tool({
  inputSchema: z.object({ order_id: z.string() }),
  needsApproval: true,
  execute: async ({ order_id }) => refund(order_id),
}),
```

The run ends with `RUN_FINISHED { outcome: { type: "interrupt" } }`, one interrupt per paused call:

```json
{
  "id": "<tool call id>",
  "reason": "tool_approval",
  "message": "Approve call to issue_refund?",
  "toolCallId": "<tool call id>",
  "responseSchema": { "type": "object", "properties": { "approved": { "type": "boolean" } }, "required": ["approved"] },
  "metadata": { "tool_name": "issue_refund", "tool_input": { "order_id": "ORD-1001" }, "ag-ui:tool-execution": "server" }
}
```

The next run's `resume` answers it: `{ "interruptId": "<id>", "status": "resolved", "payload": { "approved": true } }`. An approved call runs its tool; a rejected or cancelled one tells the model it did not run (`payload.reason` becomes the reason). In CopilotKit, `useInterrupt` renders the decision and sends the resume.

The reason is `tool_approval` rather than AG-UI's `tool_call` because clients treat `tool_call` answers as the tool's result; here the server runs the tool.

As AG-UI's interrupt rules require, a request ends with `RUN_ERROR` (code `INVALID_RESUME`, without calling the model) when its `resume` leaves a pending approval unanswered, answers a call that is not waiting for approval, or resumes a call the conversation has already moved past. A server tool call left without a result some other way (the user stopped the run, the provider failed mid-call) is closed with a result saying it was interrupted, and the conversation carries on.

The paused call is marked in its `encryptedValue`, with the AI SDK's approval id and, if you set `experimental_toolApprovalSecret`, its signature. Keep `encryptedValue` when your client stores or forwards messages.

## Without Durable Objects

In a plain Worker, `handleAGUIRequest` serves one run per request; the state lives for the length of the request. Pass `approvals` (an `ApprovalStore` on KV or D1) or set AI SDK's `experimental_toolApprovalSecret` if you gate tools with `needsApproval`: otherwise a resume trusts the tool calls in the client's history. `headers` adds headers (CORS) to every response, and preflight requests are answered.

```ts
import { handleAGUIRequest } from "@ag-ui/cloudflare-agents";

export default {
  fetch: (request, env) =>
    handleAGUIRequest(request, (run) =>
      streamText({
        model,
        instructions: run.instructions("You are a helpful assistant."),
        messages: run.messages,
        tools: run.clientTools,
        abortSignal: run.abortSignal,
      }),
    ),
};
```

## Building blocks

For your own wiring (an `AIChatAgent` that keeps its own clients, another runtime):

- `runAGUI(input, handler, { signal, state, approvals })`: the AG-UI events of one run, from `RUN_STARTED` to `RUN_FINISHED`/`RUN_ERROR`. `StateStore` and `ApprovalStore` say where state and paused approvals live.
- `convertMessages(messages, { resume, clientToolNames, pendingApprovals })` / `toModelMessages(messages)`: AG-UI messages to AI SDK messages, with resume handling.
- `toClientTools(tools)`, `buildInstructions(...)`, `formatContext(context)`.
- `translateStream(fullStream, options)`, `streamToAGUI(input, result)`: an AI SDK stream as AG-UI events.
- `eventStreamResponse(events)`, `parseRunAgentInput(body)`, `isAGUIRequest(request)`.

`withAGUI` serves AG-UI requests and frames and passes everything else to the class it extends, so an `AIChatAgent` keeps serving its own clients. If you override `onRequest`, `onMessage`, `onClose` or `setState`, call `super`; `handleAGUIRequest(request)` is there to call from your own `onRequest`. It keeps two keys in the Durable Object's storage, `ag-ui:synced-state` and `ag-ui:pending-approvals`.

## Limitations

- Changes made to a Durable Object's state by its own WebSocket clients (`useAgent`) during an AG-UI run reach the AG-UI client at its next run, not live.
- Preliminary tool results (tools that stream their output) are not sent; the final result is.
- Provider file references in user messages (an uploaded file's id) reach the model as a text note.

## Upgrading from 0.0.x

- `AgentsToAGUIAdapter` and `createSSEResponse`/`createNDJSONResponse` still work but are deprecated: `withAGUI` or `handleAGUIRequest` replace them and add message and tool conversion, context, state and resume. `streamToAGUI(input, result)` replaces `adaptStreamToAGUI` for a result you already have.
- `CloudflareAgentsClient` now speaks AG-UI over the agent's WebSocket (the frames `withAGUI` understands), appends the thread id to its URL, and ends a run on `RUN_FINISHED`/`RUN_ERROR`. Import it from `@ag-ui/cloudflare-agents/client`.
- The `ai` peer dependency is now `^6 || ^7` (the Agents SDK requires one of them).

## License

MIT
