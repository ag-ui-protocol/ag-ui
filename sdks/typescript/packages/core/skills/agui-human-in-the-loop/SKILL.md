---
name: agui-human-in-the-loop
description: >
  Add human-in-the-loop collaboration using tool calls for approvals, interventions,
  and feedback. Frontend-defined tools executed by frontend, results returned to agent.
  Declare HumanInTheLoopCapabilities for discovery.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:docs/concepts/tools.mdx
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/capabilities.ts
requires:
  - agui-tool-calling-events
---

# AG-UI — Human-in-the-Loop

Depends on `agui-tool-calling-events`. Human-in-the-loop (HITL) in AG-UI is implemented entirely through the tool call mechanism. The agent emits tool call events, the frontend executes the tool (e.g., showing a confirmation dialog), and returns the result. There is no separate interrupt/resume API -- tool calls are the stable HITL primitive.

## Setup

```typescript
import {
  EventType,
  type Tool,
  type RunAgentInput,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type BaseEvent,
} from "@ag-ui/core";
import {
  type AgentCapabilities,
  type HumanInTheLoopCapabilities,
} from "@ag-ui/core";
```

Define a frontend tool for approval and pass it in `RunAgentInput.tools`:

```typescript
const approvalTool: Tool = {
  name: "requestApproval",
  description: "Ask the user to approve or reject a proposed action before it is executed",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action that needs user approval",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "How impactful the action is",
      },
    },
    required: ["action"],
  },
};

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  tools: [approvalTool],
  state: {},
  context: [],
  forwardedProps: {},
};
```

## Core Patterns

### Pattern 1: Approval workflow via tool calls

The agent proposes an action by calling a frontend-defined tool. The frontend shows UI to the user, collects a decision, and sends the result back as a `ToolMessage`.

Agent-side event emission:

```typescript
import { Observable } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

function emitApprovalRequest(
  subscriber: { next: (event: BaseEvent) => void },
  threadId: string,
  runId: string,
): void {
  subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

  // Agent asks for approval via a tool call
  subscriber.next({
    type: EventType.TOOL_CALL_START,
    toolCallId: "tc-approve-1",
    toolCallName: "requestApproval",
  });
  subscriber.next({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "tc-approve-1",
    delta: '{"action":"Delete all staging data","severity":"critical"}',
  });
  subscriber.next({
    type: EventType.TOOL_CALL_END,
    toolCallId: "tc-approve-1",
  });

  // Run finishes -- frontend will handle the tool and re-run with the result
  subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
  // subscriber.complete() called by the caller
}
```

Frontend-side tool result:

```typescript
import type { ToolMessage, RunAgentInput } from "@ag-ui/core";

// After user clicks "Approve" in the UI:
const toolResult: ToolMessage = {
  id: "msg-result-1",
  role: "tool",
  content: "approved",
  toolCallId: "tc-approve-1",
};

// Include the tool result in the next run's messages
const nextInput: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-2",
  messages: [
    // ...previous messages including the assistant message with the tool call
    toolResult,
  ],
  tools: [approvalTool],
  state: {},
  context: [],
  forwardedProps: {},
};
```

### Pattern 2: Declaring HumanInTheLoopCapabilities

Advertise HITL support so clients can adapt their UI:

```typescript
import type { AgentCapabilities } from "@ag-ui/core";

const capabilities: AgentCapabilities = {
  humanInTheLoop: {
    supported: true,
    approvals: true,
    interventions: false, // omit if unknown; false explicitly disables
    feedback: true,
  },
  tools: {
    supported: true,
    clientProvided: true,
  },
};
```

Client-side adaptive UI:

```typescript
import type { AgentCapabilities } from "@ag-ui/core";

async function setupHITL(capabilities: AgentCapabilities | undefined): Promise<void> {
  if (capabilities?.humanInTheLoop?.approvals) {
    // Show approval UI components
  }
  if (capabilities?.humanInTheLoop?.feedback) {
    // Show thumbs up/down controls
  }
}
```

### Pattern 3: State-based collaboration via HITL

Combine tool calls with state events to let the agent propose changes and the human confirm them:

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitProposalWithState(
  subscriber: { next: (event: BaseEvent) => void },
  threadId: string,
  runId: string,
): void {
  subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

  // Emit state with the proposal for the frontend to render
  subscriber.next({
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
      proposal: {
        action: "deploy",
        target: "production",
        estimatedDowntime: "2 minutes",
      },
      status: "awaiting_approval",
    },
  });

  // Ask for approval via tool call
  subscriber.next({
    type: EventType.TOOL_CALL_START,
    toolCallId: "tc-deploy-1",
    toolCallName: "requestApproval",
  });
  subscriber.next({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "tc-deploy-1",
    delta: '{"action":"Deploy to production","severity":"high"}',
  });
  subscriber.next({
    type: EventType.TOOL_CALL_END,
    toolCallId: "tc-deploy-1",
  });

  subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
}
```

## Common Mistakes

### Mistake 1: Agent executing tool instead of frontend (priority: HIGH)

AG-UI tools are frontend-defined and frontend-executed. The agent emits TOOL_CALL events to request execution, but never runs the tool itself.

Wrong:

```typescript
// Agent-side code -- DO NOT DO THIS
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "requestApproval",
});
// Agent runs the tool itself and fabricates a result
const result = executeApprovalLocally(); // Wrong: agent should not execute
subscriber.next({
  type: EventType.TOOL_CALL_RESULT,
  messageId: "msg-1",
  toolCallId: "tc-1",
  content: result,
});
```

Correct:

```typescript
// Agent emits tool call events and finishes the run
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "requestApproval",
});
subscriber.next({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "tc-1",
  delta: '{"action":"Send email to client"}',
});
subscriber.next({
  type: EventType.TOOL_CALL_END,
  toolCallId: "tc-1",
});
// Frontend handles execution, collects user input, sends ToolMessage back on next run
```

### Mistake 2: Not returning tool result to agent (priority: HIGH)

After the frontend executes a tool, the result must be sent back as a `ToolMessage` with a matching `toolCallId`. Without it, the agent has no context about what happened and cannot continue the workflow.

Wrong:

```typescript
// Frontend executes the tool but discards the result
const userDecision = await showApprovalDialog(args);
// Nothing sent back to the agent -- next run has no tool result
```

Correct:

```typescript
import type { ToolMessage } from "@ag-ui/core";

const userDecision = await showApprovalDialog(args);
const toolResult: ToolMessage = {
  id: "msg-tool-result-1",
  role: "tool",
  content: userDecision ? "approved" : "rejected",
  toolCallId: "tc-1", // Must match the original tool call
};
// Include toolResult in the messages array of the next RunAgentInput
```

See also: `agui-tool-calling-events`, `agui-capability-events`, `agui-state-synchronization`
