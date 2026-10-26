# @ag-ui/client

Client SDK for connecting to **Agent-User Interaction (AG-UI) Protocol** servers.

`@ag-ui/client` provides agent implementations that handle the full lifecycle of AG-UI communication: connecting to servers, processing streaming events, managing state mutations, and providing reactive subscriber hooks.

## Installation

```bash
npm install @ag-ui/client zod
pnpm add @ag-ui/client zod
yarn add @ag-ui/client zod
```

zod (3.25.18+ or 4.x) is a peer dependency. The client's enforcement stage
validates every event with the schemas on `@ag-ui/core/schemas`, using the zod
your application installs rather than a bundled copy.

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

## Enforcement limits

Every event an agent receives, and every input `HttpAgent` sends, is stripped and
validated against the protocol schemas. To keep that work bounded, the client
refuses a single event or input with more than 1,000,000 container entries (array
elements, object keys and record keys; opaque fields such as `state` are not
counted). The run fails with an `AGUIEnforcementLimitError` naming the path where
the limit was crossed.

```ts
// Raise the limit, or pass Infinity to disable it.
const agent = new HttpAgent({ url, maxEnforcedEntries: 5_000_000 });
```

The limit covers stripping and validation. Single linear passes that run before
them, such as parsing the transport stream, are not counted, and opaque fields
are not limited at all: a huge `state` passes enforcement and is cloned and
applied downstream at full cost.

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
a declaration, the existing rule applies: a snapshot containing any activity
replaces all activities, while a transcript-only snapshot preserves them. A missing
namespace or missing field uses this legacy rule. An invalid namespace or field
owns no types, including arrays containing non-string entries.

Authority controls deletion of omitted activity messages. A matching message ID
always updates in place, even for a type outside the declared scope. Existing
message positions are preserved and new IDs are appended in snapshot order.
This convention does not reconcile changed IDs or reposition restored activities.

History projectors must preserve full authority and extend explicit scopes with
the types they reconstruct. `withAuthoritativeActivityTypes` implements this
rule; call it on the incoming snapshot before replacing its messages.
