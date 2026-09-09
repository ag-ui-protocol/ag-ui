# @ag-ui/client

Client SDK for connecting to **Agent-User Interaction (AG-UI) Protocol** servers.

`@ag-ui/client` provides agent implementations that handle the full lifecycle of AG-UI communication: connecting to servers, processing streaming events, managing state mutations, and providing reactive subscriber hooks.

## Installation

```bash
npm install @ag-ui/client
pnpm add @ag-ui/client
yarn add @ag-ui/client
```

## Features

- 🔗 **HTTP connectivity** – `HttpAgent` for direct server connections with SSE/protobuf support
- 🏗️ **Custom agents** – `AbstractAgent` base class for building your own transport layer
- 📡 **Event streaming** – Full AG-UI event processing with validation and transformation
- 🔄 **State management** – Automatic message/state tracking with reactive updates
- 🪝 **Subscriber system** – Middleware-style hooks for logging, persistence, and custom logic
- 🎯 **Middleware support** – Transform and filter events with function or class-based middleware

## Quick example

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://api.example.com/agent",
  headers: { Authorization: "Bearer token" },
});

const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(result.newMessages);
```

## Using Middleware

```ts
import { HttpAgent, FilterToolCallsMiddleware } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://api.example.com/agent",
});

// Add middleware to transform or filter events
agent.use(
  // Function middleware for logging
  (input, next) => {
    console.log("Starting run:", input.runId);
    return next.run(input);
  },

  // Class middleware for filtering tool calls
  new FilterToolCallsMiddleware({
    allowedToolCalls: ["search", "calculate"]
  })
);

await agent.runAgent();
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/client`](https://docs.ag-ui.com/sdk/js/client/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors

## Activity snapshots

`MESSAGES_SNAPSHOT.metadata["@ag-ui/client"].authoritativeActivityTypes`
controls which activity types the snapshot replaces. An array owns those types;
`[]` owns none, and `null` owns all types, even for an empty snapshot. Without
valid metadata, the existing rule applies: a snapshot containing any activity
replaces all activities, while a transcript-only snapshot preserves them.
History projectors must preserve full authority and extend explicit scopes with
the types they reconstruct. `withAuthoritativeActivityTypes` implements this
rule; call it on the incoming snapshot before replacing its messages.
