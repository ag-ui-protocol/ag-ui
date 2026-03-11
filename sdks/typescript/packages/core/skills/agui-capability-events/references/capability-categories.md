# Capability Categories Reference

All types imported from `@ag-ui/core`. Source: `sdks/typescript/packages/core/src/capabilities.ts`.

## 1. identity (IdentityCapabilities)

Basic metadata about the agent. Useful for discovery UIs, agent marketplaces, and debugging.

| Field              | Type                     | Description                                                    |
|--------------------|--------------------------|----------------------------------------------------------------|
| `name`             | `string?`                | Human-readable name shown in UIs and agent selectors           |
| `type`             | `string?`                | Framework or platform (e.g., `"langgraph"`, `"mastra"`)       |
| `description`      | `string?`                | What this agent does                                           |
| `version`          | `string?`                | Semantic version (e.g., `"1.2.0"`)                             |
| `provider`         | `string?`                | Organization or team that maintains this agent                 |
| `documentationUrl` | `string?`                | URL to the agent's docs or homepage                            |
| `metadata`         | `Record<string, unknown>?` | Arbitrary key-value pairs for integration-specific identity  |

## 2. transport (TransportCapabilities)

Declares which transport mechanisms the agent supports. Set flags to `true` only for transports the agent handles.

| Field                | Type       | Description                                                         |
|----------------------|------------|---------------------------------------------------------------------|
| `streaming`          | `boolean?` | Streams responses via SSE. Most agents enable this.                 |
| `websocket`          | `boolean?` | Accepts persistent WebSocket connections                            |
| `httpBinary`         | `boolean?` | Supports the AG-UI binary protocol (protobuf over HTTP)             |
| `pushNotifications`  | `boolean?` | Can send async updates via webhooks after a run finishes            |
| `resumable`          | `boolean?` | Supports resuming interrupted streams via sequence numbers          |

## 3. tools (ToolsCapabilities)

Tool calling capabilities. Distinguishes agent-provided tools from client-provided tools.

| Field            | Type       | Description                                                      |
|------------------|------------|------------------------------------------------------------------|
| `supported`      | `boolean?` | Can make tool calls. `false` = explicitly disabled.              |
| `items`          | `Tool[]?`  | Tools this agent provides (full JSON Schema definitions)         |
| `parallelCalls`  | `boolean?` | Can invoke multiple tools concurrently within a single step      |
| `clientProvided` | `boolean?` | Accepts and uses tools provided by the client at runtime         |

## 4. output (OutputCapabilities)

Output format support.

| Field               | Type        | Description                                                    |
|---------------------|-------------|----------------------------------------------------------------|
| `structuredOutput`  | `boolean?`  | Can produce structured JSON output matching a provided schema  |
| `supportedMimeTypes`| `string[]?` | MIME types the agent can produce (e.g., `["text/plain"]`)      |

## 5. state (StateCapabilities)

State and memory management.

| Field             | Type       | Description                                                       |
|-------------------|------------|-------------------------------------------------------------------|
| `snapshots`       | `boolean?` | Emits `STATE_SNAPSHOT` events (full state replacement)            |
| `deltas`          | `boolean?` | Emits `STATE_DELTA` events (JSON Patch incremental updates)       |
| `memory`          | `boolean?` | Has long-term memory beyond the current thread                    |
| `persistentState` | `boolean?` | State preserved across multiple runs within the same thread       |

## 6. multiAgent (MultiAgentCapabilities)

Multi-agent coordination.

| Field        | Type              | Description                                                     |
|--------------|-------------------|-----------------------------------------------------------------|
| `supported`  | `boolean?`        | Participates in multi-agent coordination                        |
| `delegation` | `boolean?`        | Can delegate subtasks to other agents while retaining control   |
| `handoffs`   | `boolean?`        | Can transfer the conversation entirely to another agent         |
| `subAgents`  | `SubAgentInfo[]?` | List of sub-agents (`{ name: string; description?: string }`)   |

## 7. reasoning (ReasoningCapabilities)

Reasoning and thinking visibility.

| Field       | Type       | Description                                                          |
|-------------|------------|----------------------------------------------------------------------|
| `supported` | `boolean?` | Produces reasoning/thinking tokens visible to the client             |
| `streaming` | `boolean?` | Reasoning tokens are streamed incrementally                          |
| `encrypted` | `boolean?` | Reasoning content is encrypted (zero-data-retention mode)            |

## 8. multimodal (MultimodalCapabilities)

Organized into `input` and `output` sub-objects.

### multimodal.input (MultimodalInputCapabilities)

| Field   | Type       | Description                                  |
|---------|------------|----------------------------------------------|
| `image` | `boolean?` | Can process image inputs                     |
| `audio` | `boolean?` | Can process audio inputs                     |
| `video` | `boolean?` | Can process video inputs                     |
| `pdf`   | `boolean?` | Can process PDF documents                    |
| `file`  | `boolean?` | Can process arbitrary file uploads           |

### multimodal.output (MultimodalOutputCapabilities)

| Field   | Type       | Description                                  |
|---------|------------|----------------------------------------------|
| `image` | `boolean?` | Can generate images as part of response      |
| `audio` | `boolean?` | Can produce audio output                     |

## 9. execution (ExecutionCapabilities)

Execution control and limits.

| Field              | Type       | Description                                                         |
|--------------------|------------|---------------------------------------------------------------------|
| `codeExecution`    | `boolean?` | Can execute code (Python, JavaScript) during a run                  |
| `sandboxed`        | `boolean?` | Code execution is sandboxed. Only meaningful when `codeExecution`=true |
| `maxIterations`    | `number?`  | Maximum tool-call/reasoning iterations per run                      |
| `maxExecutionTime` | `number?`  | Maximum wall-clock time in milliseconds before timeout              |

## 10. humanInTheLoop (HumanInTheLoopCapabilities)

Human-in-the-loop interaction support.

| Field           | Type       | Description                                                       |
|-----------------|------------|-------------------------------------------------------------------|
| `supported`     | `boolean?` | Supports any form of human-in-the-loop interaction                |
| `approvals`     | `boolean?` | Can pause and request explicit approval before sensitive actions   |
| `interventions` | `boolean?` | Allows humans to intervene and modify the plan mid-execution      |
| `feedback`      | `boolean?` | Can incorporate user feedback to improve current session behavior  |

## 11. custom (Record<string, unknown>)

Escape hatch for integration-specific capabilities. No schema enforced -- consumers must type-assert values.

```typescript
custom: {
  rateLimit: { maxRequestsPerMinute: 60 },
  featureFlags: { experimentalSearch: true },
}
```

## Convention: absent = unknown

All fields across all categories are optional. The protocol convention is:

- **Present and `true`**: Agent supports this capability
- **Present and `false`**: Agent explicitly does not support this capability
- **Absent (omitted)**: Capability status is unknown/not declared

Only declare what you support. Omit entire categories if none of their fields apply.
