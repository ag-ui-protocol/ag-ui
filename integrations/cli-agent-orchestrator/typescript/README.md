# @ag-ui/cli-agent-orchestrator

AG-UI TypeScript client for [CLI Agent Orchestrator (CAO)](https://github.com/awslabs/cli-agent-orchestrator) backed agents.

## Installation

```bash
npm install @ag-ui/cli-agent-orchestrator @ag-ui/client @ag-ui/core rxjs
```

## Usage

```typescript
import { CliAgentOrchestratorAgent } from "@ag-ui/cli-agent-orchestrator";

const agent = new CliAgentOrchestratorAgent({
  url: "http://127.0.0.1:9889/agui/v1/run",
});

// Collect whatever CLI prompt is waiting. When one is, the run finishes with
// an interrupt outcome and the agent records it in `pendingInterrupts`.
await agent.runAgent();

// Answer every open interrupt. CAO types the answer into that CLI's terminal:
// `approved: true` accepts the prompt, `approved: false` declines it.
if (agent.pendingInterrupts.length > 0) {
  await agent.runAgent({
    resume: agent.pendingInterrupts.map((interrupt) => ({
      interruptId: interrupt.id,
      status: "resolved",
      payload: { approved: true },
    })),
  });
}
```

Each interrupt's `metadata` carries `provider` and `terminalId`, so a UI can say which CLI is
asking. CAO never puts the prompt text on the wire.

## Overview

`CliAgentOrchestratorAgent` extends `HttpAgent` from `@ag-ui/client`. Since CAO already exposes a fully AG-UI-compliant streaming endpoint, this client requires no additional logic beyond what `HttpAgent` provides. It serves as a named, semantically meaningful entry point for consumers connecting to CAO backends.

## License

MIT
