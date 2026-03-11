---
name: agui-capability-events
description: >
  Declare agent capabilities via optional getCapabilities() method. AgentCapabilities
  covers identity, transport, tools, output, state, multiAgent, reasoning, multimodal,
  execution, humanInTheLoop, and custom categories. Absent = unknown convention.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/capabilities.ts
  - ag-ui-protocol/ag-ui:docs/concepts/capabilities.mdx
---

# AG-UI — Capability Events

No dependencies. This skill covers the `AgentCapabilities` interface and `getCapabilities()` method for runtime capability discovery.

## Setup

```typescript
import type {
  AgentCapabilities,
  IdentityCapabilities,
  TransportCapabilities,
  ToolsCapabilities,
  OutputCapabilities,
  StateCapabilities,
  MultiAgentCapabilities,
  ReasoningCapabilities,
  MultimodalCapabilities,
  ExecutionCapabilities,
  HumanInTheLoopCapabilities,
} from "@ag-ui/core";
```

Minimal capabilities declaration:

```typescript
const capabilities: AgentCapabilities = {
  identity: {
    name: "my-agent",
    description: "Answers questions about project status",
    version: "1.0.0",
  },
  transport: {
    streaming: true,
  },
};
```

## Core Patterns

### Pattern 1: Implementing getCapabilities() on an agent

`getCapabilities()` is optional on `AbstractAgent`. Return only the capabilities your agent actually supports. Omitted fields mean "unknown" -- not "unsupported".

```typescript
import type { AgentCapabilities } from "@ag-ui/core";

// Inside an AbstractAgent subclass:
async getCapabilities(): Promise<AgentCapabilities> {
  return {
    identity: {
      name: "research-agent",
      type: "langgraph",
      description: "Deep research with multi-step reasoning",
      version: "2.1.0",
      provider: "acme-corp",
    },
    transport: {
      streaming: true,
    },
    tools: {
      supported: true,
      items: this.getRegisteredTools(), // dynamic based on current state
      clientProvided: true,
      parallelCalls: true,
    },
    state: {
      snapshots: true,
      deltas: true,
      persistentState: true,
    },
    reasoning: {
      supported: true,
      streaming: true,
      encrypted: false,
    },
    humanInTheLoop: {
      supported: true,
      approvals: true,
    },
  };
}
```

### Pattern 2: Client-side capability querying

Always use optional chaining because `getCapabilities()` may not be implemented and individual categories may be absent:

```typescript
import type { AgentCapabilities } from "@ag-ui/core";

async function adaptUI(
  agent: { getCapabilities?: () => Promise<AgentCapabilities> },
): Promise<void> {
  const caps = await agent.getCapabilities?.();

  // Absent = unknown, so default to false for feature gating
  const canStream = caps?.transport?.streaming ?? false;
  const hasTools = caps?.tools?.supported ?? false;
  const hasApprovals = caps?.humanInTheLoop?.approvals ?? false;
  const hasReasoning = caps?.reasoning?.supported ?? false;

  if (hasReasoning) {
    // Show reasoning panel toggle
  }

  if (caps?.multiAgent?.subAgents?.length) {
    // Show sub-agent selector with caps.multiAgent.subAgents
  }

  if (caps?.multimodal?.input?.image) {
    // Show image upload button
  }
}
```

### Pattern 3: Dynamic capabilities reflecting current state

Since `getCapabilities()` returns a live snapshot at call time, it should reflect dynamically registered tools, loaded plugins, or configuration changes:

```typescript
import type { AgentCapabilities, Tool } from "@ag-ui/core";

class DynamicAgent {
  private tools: Tool[] = [];

  registerTool(tool: Tool): void {
    this.tools.push(tool);
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      tools: {
        supported: this.tools.length > 0,
        items: this.tools,
        clientProvided: true,
      },
    };
  }
}

// Usage:
const agent = new DynamicAgent();
let caps = await agent.getCapabilities();
// caps.tools?.items?.length === 0

agent.registerTool({ name: "search", description: "Search the web", parameters: {} });
caps = await agent.getCapabilities();
// caps.tools?.items?.length === 1
```

### Pattern 4: Custom capabilities escape hatch

For integration-specific capabilities not covered by standard categories, use the `custom` field:

```typescript
import type { AgentCapabilities } from "@ag-ui/core";

const capabilities: AgentCapabilities = {
  identity: { name: "rate-limited-agent" },
  custom: {
    rateLimit: {
      maxRequestsPerMinute: 60,
      burstLimit: 10,
    },
    featureFlags: {
      experimentalSearch: true,
      betaRewrite: false,
    },
  },
};

// Consumer reads custom capabilities with type assertion:
const rateLimit = capabilities.custom?.rateLimit as
  | { maxRequestsPerMinute: number; burstLimit: number }
  | undefined;
```

## Common Mistakes

### Mistake 1: Setting unsupported capabilities to false instead of omitting (priority: MEDIUM)

The convention is absent = unknown. Only declare capabilities that are supported. Setting flags to `false` is technically valid but semantically different from omitting them. `false` means "explicitly does not support this." Omitting means "not declared / unknown."

Wrong:

```typescript
const capabilities: AgentCapabilities = {
  transport: {
    streaming: true,
    websocket: false,    // Don't set to false unless explicitly disabling
    httpBinary: false,   // Just omit these
    pushNotifications: false,
    resumable: false,
  },
  reasoning: {
    supported: false,    // Omit the entire category instead
    streaming: false,
    encrypted: false,
  },
};
```

Correct:

```typescript
const capabilities: AgentCapabilities = {
  transport: {
    streaming: true,
    // websocket, httpBinary, etc. omitted = unknown
  },
  // reasoning omitted entirely = not declared
};
```

### Mistake 2: Static capabilities for dynamic agent (priority: MEDIUM)

`getCapabilities()` reflects current agent state at call time. Returning a hardcoded object misses capabilities that change based on configuration or loaded tools.

Wrong:

```typescript
// Hardcoded at module level -- never changes
const STATIC_CAPS: AgentCapabilities = {
  tools: { supported: true, items: [] },
};

class MyAgent {
  async getCapabilities(): Promise<AgentCapabilities> {
    return STATIC_CAPS; // Always returns empty items even after tools registered
  }
}
```

Correct:

```typescript
class MyAgent {
  private registeredTools: Tool[] = [];

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      tools: {
        supported: this.registeredTools.length > 0,
        items: this.registeredTools, // Reflects current state
        clientProvided: true,
      },
    };
  }
}
```

### Mistake 3: Forgetting getCapabilities is optional (priority: MEDIUM)

`getCapabilities()` is optional on `AbstractAgent`. Calling it on an agent that does not implement it returns `undefined`. Consumers must handle this case.

Wrong:

```typescript
// Crashes if agent doesn't implement getCapabilities
const caps = await agent.getCapabilities();
if (caps.tools.supported) { /* ... */ }
```

Correct:

```typescript
// Safe: optional chaining handles undefined at every level
const caps = await agent.getCapabilities?.();
if (caps?.tools?.supported) { /* ... */ }
```

## References

- [references/capability-categories.md](references/capability-categories.md) -- Full detail of all 12 capability categories

See also: `agui-reasoning-events` (ReasoningCapabilities), `agui-human-in-the-loop` (HumanInTheLoopCapabilities), `agui-state-synchronization` (StateCapabilities)
