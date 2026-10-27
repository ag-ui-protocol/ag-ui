# @ag-ui/agno

Implementation of the AG-UI protocol for Agno.

Connects Agno agents to frontend applications via the AG-UI protocol using HTTP communication.

## Installation

```bash
npm install @ag-ui/agno
pnpm add @ag-ui/agno
yarn add @ag-ui/agno
```

## Usage

```ts
import { AgnoAgent } from "@ag-ui/agno";

// Create an AG-UI compatible agent
const agent = new AgnoAgent({
  url: "https://your-agno-server.com/agui",
  headers: { Authorization: "Bearer your-token" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello from Agno!" }],
});
```

## Resumable background runs

By default a run lives and dies with its HTTP connection. Set `background` and
the server runs the agent detached from the request instead, buffering its
events; if the connection drops, the agent reconnects to the same run and picks
up from the last event it received. Its subscriber sees one unbroken sequence,
however many connections it took.

```ts
const agent = new AgnoAgent({
  url: "https://your-agno-server.com/agui",
  background: true,
  maxReconnectAttempts: 5, // default
  reconnectDelayMs: 250, // default
});
```

`maxReconnectAttempts` counts reconnects that arrive with nothing new; the
count resets whenever an attempt delivers an event, so a long run that keeps
losing its connection keeps going. The delay doubles between fruitless
attempts, up to ten seconds. Once the budget is spent the observable errors, so
handle rejection as well as the `RUN_ERROR` a server sends of its own accord.

Each event of a background run carries its resume cursor under
`metadata.agnoBackground`, and that is also how resumability is detected: when
no cursor arrives the run streams normally on a single connection and no
reconnect is attempted. That covers both a server too old to offer background
runs and a server that has them but cannot apply them to this particular agent.
The marker is stripped before the event reaches your subscriber, so it never
becomes part of a message.

Reconnecting stops when the run reaches a terminal event, when `abortRun` is
called, and when the subscriber unsubscribes. An aborted run ends with a
`RUN_ERROR` carrying the `abort` code followed by a close, whether the abort
landed during a request or between two of them; the message and raw event
differ between those two cases.

A resumed connection whose events arrive without cursors cannot place them, so
it drops them and ends the run with an error rather than reporting a result it
had to leave pieces out of.

Background execution requires a server-side database and an agent or team that
executes in the server's own process. A server that cannot honor the request
runs it in the foreground instead, and refuses outright if the request is
trying to resume, since running it in the foreground would execute the whole
run a second time.

One behavior differs from a plain `HttpAgent` even against a server with no
background support: a stream that stops part-way through a run, without a
terminal event, is treated as a dropped connection and surfaces as an error
rather than as a quiet close.

## Features

- **HTTP connectivity** – Direct connection to Agno agent servers
- **Multi-agent support** – Works with Agno's multi-agent system architecture
- **Streaming responses** – Real-time communication with full AG-UI event support
- **Resumable background runs** – Survive a dropped connection and resume from a cursor
