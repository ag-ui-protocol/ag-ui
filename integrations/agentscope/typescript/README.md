# AgentScope HTTP client

This private workspace package re-exports `@ag-ui/client`'s `HttpAgent` as `AgentScopeAgent` for the Dojo. AgentScope owns conversion of its native events; the Python example supplies the AG-UI input boundary.

```ts
import { AgentScopeAgent } from "@ag-ui/agentscope";

const agent = new AgentScopeAgent({
  url: "http://localhost:8031/agentic_chat/",
});
```
