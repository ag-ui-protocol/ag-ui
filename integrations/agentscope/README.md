# AgentScope

Connect [AgentScope](https://github.com/agentscope-ai/agentscope) 2 agents to
AG-UI using AgentScope's native `AGUIProtocolMiddleware`.

- [Python examples](python/examples/README.md): stateless AG-UI request handling,
  streaming chat and backend weather tool rendering.
- [TypeScript workspace client](typescript/README.md): a private `HttpAgent`
  alias used by the Dojo. Applications can use `@ag-ui/client` directly.
- [Integration guide](../../docs/integrations/agentscope.mdx).

The Dojo integration id is `agentscope`, with backend port `8031` by default.
It is available in the local Dojo; no hosted backend is configured here.
