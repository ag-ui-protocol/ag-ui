# OpenClaw

Implementation of the AG-UI protocol for [OpenClaw](https://github.com/openclaw/openclaw).

`OpenClawAgent` connects an AG-UI / CopilotKit frontend to an OpenClaw gateway
that speaks the AG-UI protocol over HTTP/SSE through the
[`clawg-ui`](https://www.npmjs.com/package/@contextableai/clawg-ui) channel
plugin. The plugin self-registers an AG-UI endpoint on the gateway (the
operator-auth route `/v1/clawg-ui/operator`), so the client talks to it exactly
like any other self-hosted AG-UI HTTP backend — no framework-specific transport
is required.

`OpenClawAgent` is a thin extension of the standard
[`HttpAgent`](https://www.npmjs.com/package/@ag-ui/client). OpenClaw emits the
current AG-UI protocol (streaming text, reasoning, tool calls), so no protocol
version capping is applied.

## Installation

```shell
npm install @ag-ui/openclaw
# or
pnpm add @ag-ui/openclaw
# or
yarn add @ag-ui/openclaw
```

`@ag-ui/core`, `@ag-ui/client`, and `rxjs` are peer dependencies.

## Usage

```ts
import { OpenClawAgent } from "@ag-ui/openclaw";

const agent = new OpenClawAgent({
  // The clawg-ui operator route exposed by the OpenClaw gateway.
  url: "http://localhost:8000/v1/clawg-ui/operator",
  // Gateway token — clawg-ui's operator route authenticates with the gateway
  // token, so no interactive device pairing is needed.
  headers: {
    Authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`,
  },
});

const result = await agent.runAgent({
  messages: [{ id: "1", role: "user", content: "Hello from AG-UI!" }],
});
```

`OpenClawAgent` accepts the same configuration as `HttpAgent` (`url`,
`headers`, `fetch`, `agentId`, `threadId`, `initialMessages`, `initialState`,
`debug`).

## Prerequisites

An OpenClaw gateway running with the `clawg-ui` plugin installed and a gateway
token configured. See the [OpenClaw](https://github.com/openclaw/openclaw)
documentation for setting up and running a gateway, and the
[`clawg-ui`](https://www.npmjs.com/package/@contextableai/clawg-ui) plugin for
installing and exposing the AG-UI endpoint.
