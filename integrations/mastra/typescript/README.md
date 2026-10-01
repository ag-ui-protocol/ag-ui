# @ag-ui/mastra

Implementation of the AG-UI protocol for Mastra.

Connects Mastra agents (local and remote) to frontend applications via the AG-UI protocol. Supports streaming responses, memory management, and tool execution.

## Installation

Install the `@ag-ui/mastra` package:

```bash
# npm
npm install @ag-ui/mastra
# pnpm
pnpm add @ag-ui/mastra
# yarn
yarn add @ag-ui/mastra
```

Install the required peer dependencies:

```bash
npm install @mastra/client-js @mastra/core @ag-ui/core @ag-ui/client
```

The optional CopilotKit integration is available from `@ag-ui/mastra/copilotkit`.
Install its peer dependency only when using that entry point:

```bash
npm install @copilotkit/runtime
```

## Usage

```ts
import { MastraAgent } from "@ag-ui/mastra";
import { mastra } from "./mastra"; // Your Mastra instance

// Create an AG-UI compatible agent
const agent = new MastraAgent({
  agent: mastra.getAgent("weather-agent"),
  resourceId: "user-123",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "What's the weather like?" }],
});
```

## Features

- **Local & remote agents** – Works with in-process and network Mastra agents
- **Memory integration** – Automatic thread and working memory management
- **Tool streaming** – Real-time tool call execution and results
- **State management** – Bidirectional state synchronization
- **Human-in-the-loop** – Mastra tool suspend/resume bridged to AG-UI interrupts

## Interrupts (tool suspend/resume)

When a Mastra tool suspends, the bridge ends the run with
`RunFinishedEvent.outcome = { type: "interrupt", interrupts }`. Each suspend maps
to an `Interrupt` (`reason`, `toolCallId`, `responseSchema` parsed from
`resumeSchema`, and `message` when the suspend payload has a string `message`);
the Mastra payload (`toolName`, `suspendPayload`, `args`, `resumeSchema` and the
snapshot-keying `runId`) lives under `metadata.mastra`. Its `id` is
`` `${runId}::${toolCallId}` ``: a client only round-trips `interruptId` on
resume, so the snapshot `runId` is encoded into the id and decoded back out.

A run reports at most one interrupt, because a resume can continue only one
suspended call. Mastra runs suspendable and approval-gated tools one at a time,
so a later call pauses on the resumed run instead. If a stream still pauses a
second call, the bridge logs a warning and leaves it out of the outcome.

Resume with one `RunAgentInput.resume` entry for that id. A `resolved` entry
passes its `payload` to Mastra's `resumeStream`; a `cancelled` entry declines
the call and ends the run without resuming. This needs a client that reads the
interrupt outcome and sends `RunAgentInput.resume`, such as CopilotKit
`>= 1.61.2`.

## Tool approval

Mastra's native approval gate is bridged to AG-UI interrupts. Mark a tool with
`requireApproval: true`, or set `requireToolApproval: true` in the agent's
`defaultOptions` to gate every tool:

```ts
const recordExpense = createTool({
  id: "record-expense",
  inputSchema: z.object({ amount: z.number() }),
  requireApproval: true,
  execute: async ({ amount }) => ({ recorded: true, amount }),
});
```

Mastra pauses the call before `execute` runs and streams `tool-call-approval`.
The bridge holds back that tool call and ends the run with an interrupt whose
`reason` is `mastra:tool_approval`, with the call's `toolCallId`,
`responseSchema` (Mastra's `{ approved: boolean }` schema), and `toolName`,
`args` and the snapshot `runId` under `metadata.mastra`. Its `id` is
`` `mastra-approval::${runId}::${toolCallId}` ``, and `metadata.mastra.type` is
`mastra_tool_approval`.

**Storage.** The paused call lives in Mastra's workflow snapshot until the user
decides, and the resume run loads it from storage. Configure persistent storage
on the Mastra instance, and give the agent `Memory` backed by a persistent store
so the thread keeps the settled tool call. For remote agents this is the
server's storage. Don't use an in-memory libsql URL (`:memory:`): with pooled
connections each connection gets its own empty database, so the snapshot is
missing on resume. Use a file URL such as `file:./mastra.db` instead.

**Approval UI.** With CopilotKit v2, render Approve and Reject from
`useInterrupt`, and have both call `resolve`. `event.value` is the `Interrupt`.

```tsx
useInterrupt({
  agentId: "tool_approval",
  renderInChat: true,
  enabled: (event) =>
    (event.value as Interrupt)?.reason === "mastra:tool_approval",
  render: ({ resolve }) => (
    <ApprovalCard
      onApprove={() => resolve({ approved: true })}
      onReject={() => resolve({ approved: false })}
    />
  ),
});
```

Reject with `resolve({ approved: false })` or `cancel()`.

**Resume.** Send one entry for the interrupt `id`:

- `{ status: "resolved", payload: { approved: true } }` approves (so does
  `payload: true`).
- `{ status: "resolved", payload: { approved: false } }` declines.
- `{ status: "cancelled" }` declines, whatever payload it carries.
- Any other resolved payload (none, `null`, `{}`, `{ approve: true }`,
  `{ approved: "yes" }`, a string) fails the run with a `RUN_ERROR` coded
  `MASTRA_INVALID_TOOL_APPROVAL`. Mastra is not called, so the approval stays
  pending and can still be answered.

The bridge then completes the original call, keyed by the snapshot `runId` and `toolCallId`: local agents
call Mastra's `approveToolCall` or `declineToolCall`, and remote agents call
`resumeStream({ approved })`, which is what those calls do on the server. The
resumed run streams the original call with its result: the tool's output when
approved, or Mastra's decline message when declined, without running the tool.

## How a run ends

- A run stopped on purpose (`abortRun()`, the remote handle's own
  `ClientOptions.abortSignal`, or Mastra's own `abort`) closes what it opened and
  ends with `RUN_FINISHED` carrying `outcome: { type: "cancelled" }`. A run whose
  subscriber unsubscribed is abandoned and sends nothing more.
- A run that stops on frontend tool calls it left unanswered finishes as success
  and names them in `outcome.pendingToolCallIds`. Any other call the run left
  without a result (a server call, a backgrounded one, the A2UI render
  subagent's) gets a placeholder `TOOL_CALL_RESULT` first, so a consumer that
  derives the pending calls from the stream sees only the frontend ones.
- `RUN_STARTED` declares the AG-UI `protocolVersion` the bridge speaks, and
  `getCapabilities()` returns the adapter's AG-UI capabilities declaration.

## Reasoning and tool results

- A reasoning span's provider artefacts (an Anthropic thinking signature or
  redacted block, an OpenAI reasoning item id and encrypted content) are sent as
  `REASONING_ENCRYPTED_VALUE` for the reasoning message. When that message comes
  back in the run input, directly ahead of its assistant message, the bridge
  hands the reasoning back to Mastra with those artefacts.
- A tool whose `toModelOutput` returns the content form (`{ type: "content" }`)
  reports its result as AG-UI content parts in `TOOL_CALL_RESULT`; any other
  result is the JSON string it always was. A tool message given as content parts
  reaches the model as that content. A URL or provider file handle source in a
  tool result is dropped with a warning, since Mastra's model output carries
  bytes only.
- Provider file handles (the `file` source) on user messages are dropped with a
  warning: Mastra has no input channel for a provider file id.

## To run the example server in the dojo

```bash
cd integrations/mastra/typescript/examples
pnpm install
pnpm run dev
```
