# @ag-ui/trpc-agent-go

TypeScript client for connecting AG-UI frontends to
[tRPC-Agent-Go](https://github.com/trpc-group/trpc-agent-go) agents.

## Installation

```bash
npm install @ag-ui/trpc-agent-go
```

## Usage

```typescript
import { TRPCAgent } from "@ag-ui/trpc-agent-go";

const agent = new TRPCAgent({
  url: "http://localhost:8027/agentic_chat/agui",
});
```

`TRPCAgent` extends `HttpAgent` from `@ag-ui/client` and accepts the same
configuration options.

See the [tRPC-Agent-Go AG-UI guide](https://trpc-group.github.io/trpc-agent-go/agui/)
for server configuration and additional examples.
