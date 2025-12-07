# AWS Strands Integration for AG-UI (TypeScript)

`@ag-ui/strands-server` is the TypeScript twin of the Python adapter. Give us any `@strands-agents/sdk` agent, wrap it with `StrandsAgent`, and wire it to HTTP via `createStrandsServer` or `addStrandsEndpoint`. The config surface, event ordering, and helper APIs all mirror the Python version so you can switch languages without relearning the integration.

## Prerequisites

- Node.js 18+
- `pnpm` (recommended) or npm
- A Strands-compatible model key (Gemini, Bedrock, etc.)

## Quick Start

Run the bundled demo to see shared-state + tool behaviors in action:

```bash
cd integrations/aws-strands/typescript-server/examples
pnpm install
pnpm dev
```

It mounts `http://localhost:8000/runs` and streams AG-UI events for a Strands agent that owns three tools (`get_weather`, `set_theme_color`, `update_proverbs`). The demo highlights `stateContextBuilder`, `stateFromArgs`, and `skipMessagesSnapshot`.

To embed it directly:

```ts
const baseAgent = new Agent({ systemPrompt: "Be helpful.", tools: [...] });
const aguiAgent = new StrandsAgent(baseAgent, "demo_agent", "Demo agent", config);
const server = createStrandsServer(aguiAgent, "/runs");
server.listen(8000);
```

## Architecture Overview

- **StrandsAgent** – wraps `agent.streamAsync` / `stream` and emits AG-UI events (`run_started`, deltas, tool calls, PredictState, snapshots, finish/error) identically to the Python adapter.
- **Configuration layer** – `StrandsAgentConfig`, `ToolBehavior`, and `PredictStateMapping` expose the same hooks: `stateContextBuilder`, `argsStreamer`, `stateFromArgs`, `stateFromResult`, `customResultHandler`, etc.
- **Transport helpers** – `createStrandsServer`, `createStrandsHandler`, and `addStrandsEndpoint` reuse the shared `EventEncoder` to deliver SSE or newline-delimited JSON from Express-compatible apps.

## Key Files

| File                             | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `src/agent.ts`                   | Converts Strands streaming events into AG-UI protocol events                           |
| `src/config.ts`                  | Configuration primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/endpoint.ts`                | HTTP/SSE helpers                                                                       |
| `examples/src/proverbs-agent.ts` | Runnable demo showcasing shared-state behaviors                                        |

## Development

```bash
pnpm install
pnpm run build     # tsup build (CJS + ESM + d.ts)
pnpm run typecheck # tsc --noEmit
pnpm run dev       # tsup --watch
```

Only `dist/` and this README ship in the npm package; everything else stays ignored via `.npmignore`.
