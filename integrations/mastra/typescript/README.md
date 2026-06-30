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
npm install @mastra/client-js @mastra/core @ag-ui/core @ag-ui/client @copilotkit/runtime
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

When a Mastra tool suspends, the bridge surfaces it to the frontend. Two
channels exist:

- **Legacy** `CustomEvent(name="on_interrupt")` — always emitted (backward
  compatibility). Its `value` is a JSON string carrying `type:"mastra_suspend"`,
  `toolCallId`, `toolName`, `suspendPayload`, `args`, `resumeSchema`, and the
  snapshot-keying `runId`.
- **Standard** `RunFinishedEvent.outcome = { type: "interrupt", interrupts }` —
  the canonical AG-UI signal. Each suspend maps to an `Interrupt` (`id`,
  `reason`, `toolCallId`, `responseSchema` — parsed from `resumeSchema`); the
  remaining round-trip data lives under `metadata.mastra`.

> **Opt-in (`emitInterruptOutcome`, default `false`).** The structured outcome
> is gated behind a flag, mirroring LangGraph's `emitInterruptOutcome`. Released
> clients that resume through the legacy `forwardedProps.command.resume` channel
> (e.g. CopilotKit's runtime as of v1.60.1) stop sending a resume directive once
> they observe the structured outcome, which silently strands the run. Enable it
> only with a client that understands the canonical interrupt-outcome path. When
> on, BOTH channels are emitted; when off, only the legacy event plus a plain
> `RUN_FINISHED`.

```ts
const agent = new MastraAgent({
  agent: mastra.getAgent("interrupt-agent"),
  resourceId: "user-123",
  emitInterruptOutcome: true, // opt in to RUN_FINISHED.outcome interrupts
});
```

## To run the example server in the dojo

```bash
cd integrations/mastra/typescript/examples
pnpm install
pnpm run dev
```
