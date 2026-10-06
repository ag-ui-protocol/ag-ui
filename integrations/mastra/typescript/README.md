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
- **Capability discovery** – `getCapabilities()` reports what the bridge supports

## Capabilities

`MastraAgent.getCapabilities()` reports what the bridge supports for the wrapped
agent — streaming, client-provided tools, state snapshots/deltas, reasoning, and
interrupts — so a frontend can read it through the CopilotKit `/info` handshake
(`useCapabilities(agentId)`) instead of hardcoding assumptions.

Declare anything the bridge cannot observe on its own (which input modalities
your agent parses, identity, integration-specific values) via `capabilities`,
which replaces the inferred category it names and is preserved across `clone()`:

```ts
const agent = new MastraAgent({
  agentId: "my-agent",
  agent: mastraAgent,
  capabilities: {
    multimodal: { input: { pdf: true } },
    custom: { modes: ["assisted", "autonomous"] },
  },
});
```

Pass a function instead of a literal when the answer depends on state resolved
later — it is invoked on every call, keeping the response a live snapshot. The
registry helpers take the same value per agent id:

```ts
const agents = getLocalAgents({
  mastra,
  resourceId,
  capabilities: { "my-agent": { multimodal: { input: { pdf: true } } } },
});
```

## Interrupts (tool suspend/resume)

When a Mastra tool suspends, the bridge surfaces it to the frontend. Two
channels exist:

- **Legacy** `CustomEvent(name="on_interrupt")` — always emitted (backward
  compatibility). Its `value` is a JSON string carrying `type:"mastra_suspend"`,
  `toolCallId`, `toolName`, `suspendPayload`, `args`, `resumeSchema`, and the
  snapshot-keying `runId`.
- **Standard** `RunFinishedEvent.outcome = { type: "interrupt", interrupts }` —
  the canonical AG-UI signal. Each suspend maps to an `Interrupt` (`reason`,
  `toolCallId`, `responseSchema` — parsed from `resumeSchema`); the remaining
  round-trip data lives under `metadata.mastra`. Its `id` is
  `` `${runId}::${toolCallId}` `` — the snapshot-keying `runId` is encoded into
  the id because a standard-path client only round-trips `interruptId` (not
  `metadata`) on resume; the bridge decodes it back out.

Resume is consumed from **both** channels regardless of the flag: the legacy
`forwardedProps.command.resume` and the standard `RunAgentInput.resume` array.

> **Opt-out (`emitInterruptOutcome`, default `true`).** The structured outcome
> is the canonical AG-UI interrupt path, emitted by default alongside the legacy
> event. **It requires a CopilotKit client `>= 1.61.2`** — the release that
> reads `outcome:"interrupt"` and resumes via `RunAgentInput.resume`. On older
> clients (`<= 1.61.1`, incl. 1.60.1/1.61.0) the client records the structured
> interrupt but never addresses it on resume, stranding the run with
> `Thread has N pending interrupt(s) not addressed by resume`. **If you target a
> client below 1.61.2, set `emitInterruptOutcome: false`** to fall back to the
> legacy `on_interrupt`-only path. When on, BOTH channels are emitted; when off,
> only the legacy event plus a plain `RUN_FINISHED`.

```ts
const agent = new MastraAgent({
  agent: mastra.getAgent("interrupt-agent"),
  resourceId: "user-123",
  // Default true. Set false if your CopilotKit client is < 1.61.2.
  emitInterruptOutcome: false,
});
```

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
`` `mastra-approval::${runId}::${toolCallId}` ``. The legacy `on_interrupt`
event carries the same data with `type: "mastra_tool_approval"`.

**Storage.** The paused call lives in Mastra's workflow snapshot until the user
decides, and the resume run loads it from storage. Configure persistent storage
on the Mastra instance, and give the agent `Memory` backed by a persistent store
so the thread keeps the settled tool call. For remote agents this is the
server's storage. Don't use an in-memory libsql URL (`:memory:`): with pooled
connections each connection gets its own empty database, so the snapshot is
missing on resume. Use a file URL such as `file:./mastra.db` instead.

**Approval UI.** With CopilotKit v2, render Approve and Reject from
`useInterrupt`, and have both call `resolve`. For a standard interrupt,
`event.value` is the `Interrupt`; on the legacy path it is the `on_interrupt`
JSON string instead.

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

Reject with `resolve({ approved: false })`, not a dismiss-only control. On the
legacy path (`emitInterruptOutcome: false`), CopilotKit's `cancel()` only
dismisses the card and sends no resume, so the call stays pending in Mastra.

**Resume.** Send one entry for the interrupt `id`:

- `{ status: "resolved", payload: { approved: true } }` approves (so does
  `payload: true`).
- `{ status: "resolved", payload: { approved: false } }` declines.
- `{ status: "cancelled" }` declines, whatever payload it carries.
- Any other resolved payload (none, `null`, `{}`, `{ approve: true }`,
  `{ approved: "yes" }`, a string) fails the run with a `RUN_ERROR` coded
  `MASTRA_INVALID_TOOL_APPROVAL`. Mastra is not called, so the approval stays
  pending and can still be answered.

The legacy `forwardedProps.command.resume` follows the same rules: `true` or
`{ approved: true }` approves, `false` or `{ approved: false }` declines, and
anything else fails the run. The bridge then completes the
original call, keyed by the snapshot `runId` and `toolCallId`: local agents
call Mastra's `approveToolCall` or `declineToolCall`, and remote agents call
`resumeStream({ approved })`, which is what those calls do on the server. The
resumed run streams the original call with its result: the tool's output when
approved, or Mastra's decline message when declined, without running the tool.

## To run the example server in the dojo

```bash
cd integrations/mastra/typescript/examples
pnpm install
pnpm run dev
```
