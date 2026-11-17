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
      ...run.streamTextOptions({ instructions: "You are a helpful assistant." }),
    });
  }
}

export default {
  fetch: async (request, env) =>
    (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
```

Each AG-UI thread is one instance of the agent (one Durable Object), at `/agents/assistant/<threadId>`.

`run.streamTextOptions()` gives `streamText` everything the client sent: the instructions with the application's context and the shared state, the conversation, the frontend's tools (followed by yours, passed as `tools`) and the signal that stops the model when the user stops the run.

## What you get

- **Messages, as the model needs them.** `run.messages` holds the client's conversation as AI SDK model messages: text, images, audio, video and documents, tool calls and their results.
- **Client tools.** `run.clientTools` (included by `run.streamTextOptions()`) holds the tools the frontend runs (CopilotKit's `useFrontendTool`, `useHumanInTheLoop`, generative UI renderers) as AI SDK tools without `execute`. When the model calls one, the run ends and `RUN_FINISHED` lists the call in `pendingToolCallIds`; the client runs it and sends the result with the next run. The agent never answers a client tool's call itself, not even one whose arguments do not parse: what to do with those is the client's call.
- **Context.** `run.instructions(base)` (included by `run.streamTextOptions()`) adds the application's context (`useAgentContext`), the conversation's system messages and the shared state to your instructions. AI SDK v7 does not accept system messages inside `messages`, so they belong here.
- **Shared state, kept in the Durable Object.** The agent's `state` is the thread's AG-UI state. The client's edits are saved into it, every `this.setState()` during a run reaches the client as a STATE_SNAPSHOT, and a client that comes back to the thread gets it. What the server changes between runs (a schedule, another client) is kept: the client's copy only wins when the client changed it.
- **Reasoning that survives the round trip.** Reasoning streams as `REASONING_*` events and stays in the history. Provider data that has to come back on the next request (Anthropic's thinking signatures, Gemini's thought signatures on tool calls, OpenAI's reasoning and message items) travels in AG-UI's `encryptedValue` and is restored as `providerOptions`, so extended thinking with tools works across client tool round trips.
- **Tool approvals as AG-UI interrupts.** A tool that needs approval (AI SDK v7 `toolApproval`, v6 `needsApproval`) ends the run with an interrupt; the client's answer resumes it, and the AI SDK runs (or skips) the tool. The paused run is not kept anywhere: the conversation and the answer are all a resume needs. A Durable Object agent records which calls it paused, so a client cannot get a call approved that the model never made.
- **Everything else in the stream.** Multi-step runs (`stopWhen`) with messages in order, streaming tool arguments, tool results and errors, token usage on `RUN_FINISHED`, cancellation (`RUN_FINISHED` with a `cancelled` outcome), sources and files as `CUSTOM` events named `ai-sdk:source`, `ai-sdk:file` and `ai-sdk:reasoning-file`.

Supports AI SDK v6 and v7, and AG-UI 1.0. Every input is checked the way AG-UI 1.0 asks: members the protocol does not define are removed (with a warning), and a malformed one is refused before the run starts (a `400` over HTTP, a `RUN_ERROR` with code `INVALID_INPUT` on the WebSocket).

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

**WebSocket:** `CloudflareAgentsClient` runs over the agent's WebSocket, next to the Agents SDK's own protocol. One connection per run. The frames are tagged JSON text messages: `{ "type": "ag-ui:run", "input" }` starts a run, `{ "type": "ag-ui:abort", "runId" }` cancels it, and each event comes back as `{ "type": "ag-ui:event", "runId", "event" }`, ending with `RUN_FINISHED` or `RUN_ERROR`. A refused input comes back as a single `RUN_ERROR` frame. Frames of other types belong to the Agents SDK and are left alone.

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
| `run.streamTextOptions({ instructions?, tools?, state? })` | What to spread into `streamText`'s options: `instructions` (and `system`, for AI SDK v6) built by `run.instructions(instructions, { state })`, `messages`, `tools` (the client's, then yours) and `abortSignal`. A tool of yours with `execute` replaces the client's tool of the same name, and the server answers its calls; one without `execute` (a client tool you wrapped, to watch its arguments) stays the client's. |
| `run.messages` | The conversation as AI SDK `ModelMessage[]`. |
| `run.clientTools` | The client's tools, without `execute`. Spread your server tools after them, so a server tool wins a name clash. |
| `run.instructions(base?, { state? })` | `base`, the conversation's system messages, the application's context and the shared state (leave it out with `{ state: false }`). |
| `run.context` | `RunAgentInput.context`. |
| `run.state` / `run.setState(state)` | The shared state. In a `withAGUI` agent these are `this.state` and `this.setState()`. |
| `run.emit(event)` | Streams an extra AG-UI event, such as a `CUSTOM` event. |
| `run.abortSignal` | Fires when the client cancels or disconnects. Pass it to `streamText`. |
| `run.input` | The `RunAgentInput` as sent. |
| `run.request` | The HTTP request the run came in on, for its headers (undefined over a WebSocket). |

To wire `streamText` yourself, pass all four: `instructions: run.instructions(base)` (`system` in AI SDK v6), `messages: run.messages`, `tools: { ...run.clientTools, ...yours }` and `abortSignal: run.abortSignal`. Leaving one out breaks a feature without an error, so the agent logs a warning when a run's handler did not use something the client sent: tools it never read from `run.clientTools`, context, system messages or state that never went through `run.instructions()` (reading `run.context` or `run.state` counts), or a stop it never read from `run.abortSignal`.

### Shared state

```ts
export class Chef extends withAGUI(Agent<Env, { recipe?: Recipe }>) {
  onAGUIRun(run: AGUIRun<{ recipe?: Recipe }>) {
    return streamText({
      model,
      ...run.streamTextOptions({
        instructions: "You help the user build the recipe shown next to the chat.",
        tools: {
          save_recipe: tool({
            inputSchema: recipeSchema,
            execute: async (recipe) => {
              this.setState({ ...this.state, recipe }); // streams to the client, and persists
              return "Saved.";
            },
          }),
        },
      }),
      stopWhen: stepCountIs(5),
    });
  }
}
```

A tool can update the state several times while it runs (a plan whose steps complete one by one); each update streams at once. For state that follows a tool's arguments as the model writes them, update it from the tool's `onInputDelta`.

An empty state (`{}`) from the client means it has none: it is what every new client sends, so the client gets the thread's state back rather than wiping it. To clear the state from the client, send its empty shape (`{ todos: [] }`); the server can always `this.setState()` whatever it likes.

### Tool approvals

```ts
streamText({
  model,
  ...run.streamTextOptions({
    tools: {
      issue_refund: tool({
        inputSchema: z.object({ order_id: z.string() }),
        execute: async ({ order_id }) => refund(order_id),
      }),
    },
  }),
  toolApproval: { issue_refund: "user-approval" }, // AI SDK v6: `needsApproval: true` on the tool
});
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

A request is refused before the run starts, with a single `RUN_ERROR` (code `INVALID_RESUME`) and without calling the model, when it leaves a waiting approval unanswered, leaves its call out of the conversation or sends a result for it, answers one in a way that cannot be honoured, or resumes a call the conversation has already moved past: AG-UI forbids an agent to drop an approval nobody answered. A client that no longer has the call, or already has a result for it, can still reject or cancel the approval. A `resume` entry for something that is not waiting for approval is ignored with a warning, as AG-UI asks.

An approved tool runs at most once. The request that answers an approval claims it before anything runs, so a second request answering it too (a retry after a dropped connection, a second tab) cannot run the tool again; its copy of the call is closed as interrupted. A Durable Object makes the claim atomic. For a tool whose effect must never repeat, pass the tool call id (`execute`'s second argument has `toolCallId`) as the idempotency key of the API it calls.

A run that stops before it finishes asks nothing. Its server tool calls without a result, a call paused for approval included, are closed with a result saying they were interrupted, and the conversation carries on. If a run resuming an approval fails (`RUN_ERROR`) before the tool returns, the approval opens again: the client still holds its interrupt and can answer it again. Once the tool has returned, the approval stays answered, even if the run fails afterwards. If the run is cancelled, the approval is closed as interrupted.

The paused call is marked in its `encryptedValue`, with the AI SDK's approval id and, with AI SDK v7's `experimental_toolApprovalSecret`, its signature. Keep `encryptedValue` when your client stores or forwards messages.

## Without Durable Objects

In a plain Worker, `handleAGUIRequest` serves one run per request; the state lives for the length of the request. If tools need approval, pass `approvals` (an `ApprovalStore` on KV or D1): otherwise a resume trusts the tool calls in the client's history. On AI SDK v7, signing approvals with `experimental_toolApprovalSecret` also stops a client from approving a call the model never made; AI SDK v6 has no such option, so there you need the store. Outside a Durable Object nothing makes claiming an approval atomic, so two requests answering the same approval at the same moment could both run its tool: give such tools an idempotency key (the tool call id). `headers` adds headers (CORS) to every response, and preflight requests are answered.

```ts
import { handleAGUIRequest } from "@ag-ui/cloudflare-agents";

export default {
  fetch: (request, env) =>
    handleAGUIRequest(request, (run) =>
      streamText({ model, ...run.streamTextOptions({ instructions: "You are a helpful assistant." }) }),
    ),
};
```

## Building blocks

For your own wiring (an `AIChatAgent` that keeps its own clients, another runtime):

- `runAGUI(input, handler, { signal, state, approvals })`: the AG-UI events of one run, from `RUN_STARTED` to `RUN_FINISHED`/`RUN_ERROR`. `StateStore` and `ApprovalStore` say where state and paused approvals live.
- `convertMessages(messages, { resume, clientToolNames, pendingApprovals })` / `toModelMessages(messages)`: AG-UI messages to AI SDK messages, with resume handling.
- `toClientTools(tools)`, `buildInstructions(...)`, `formatContext(context)`.
- `translateStream(fullStream, options)`, `streamToAGUI(input, result, { signal })`: an AI SDK stream as AG-UI events. Pass the `signal` you gave `streamText`, so a cancel ends the run as cancelled.
- `eventStreamResponse(events)`, `parseRunAgentInput(body)` (throws `InvalidInputError` for an input to refuse), `isAGUIRequest(request)`.

`withAGUI` serves AG-UI requests and frames and passes everything else to the class it extends, so an `AIChatAgent` keeps serving its own clients. If you override `onRequest`, `onMessage`, `onClose` or `setState`, call `super`; `handleAGUIRequest(request)` is there to call from your own `onRequest`. It keeps two keys in the Durable Object's storage, `ag-ui:synced-state` and `ag-ui:pending-approvals`.

## Limitations

- Changes made to a Durable Object's state by its own WebSocket clients (`useAgent`) during an AG-UI run reach the AG-UI client at its next run, not live.
- A thread keeps one record of the state its client last had, so it tells one client's edit from a stale copy, not two clients' copies apart. When two AG-UI clients take turns on a thread, a client that sends a copy from before the other's last run overwrites the other's changes: the last one to run wins.
- Preliminary tool results (tools that stream their output) are not sent; the final result is.
- Provider file references in user messages (an uploaded file's id) are not passed on: the AI SDK has no portable way to. The model gets a note that a file was attached, and the agent logs a warning.

## Upgrading from 0.0.x

- `AgentsToAGUIAdapter` and `createSSEResponse`/`createNDJSONResponse` still work but are deprecated: `withAGUI` or `handleAGUIRequest` replace them and add message and tool conversion, context, state and resume. `streamToAGUI(input, result)` replaces `adaptStreamToAGUI` for a result you already have.
- `CloudflareAgentsClient` now speaks AG-UI over the agent's WebSocket (the frames `withAGUI` understands), appends the thread id to its URL, and ends a run on `RUN_FINISHED`/`RUN_ERROR`. Import it from `@ag-ui/cloudflare-agents/client`.
- The `ai` peer dependency is now `^6 || ^7` (the Agents SDK requires one of them).

## License

MIT
