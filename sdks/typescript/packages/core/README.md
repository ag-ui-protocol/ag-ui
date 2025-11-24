# @ag-ui/core

TypeScript definitions & runtime schemas for the **Agent-User Interaction (AG-UI) Protocol**.

`@ag-ui/core` delivers the strongly-typed building blocks that every other AG-UI package is built on: message & state models, run inputs and the full set of streaming event types.

## Installation

```bash
npm install @ag-ui/core
pnpm add @ag-ui/core
yarn add @ag-ui/core
```

## Features

- 🧩 **Typed data models** – `Message`, `Tool`, `Context`, `RunAgentInput`, `State` …
- 🔄 **Streaming events** – 16 core event kinds covering assistant messages, tool calls, state updates and run lifecycle.
- ✅ **Runtime validation** – schemas catch malformed payloads early.
- 🚀 **Framework-agnostic** – works in Node.js, browsers and any agent framework that can emit JSON.

## Quick example

```ts
import { EventSchemas, EventType } from "@ag-ui/core";

// Validate an incoming event
EventSchemas.parse({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg_123",
  delta: "Hello, world!",
});
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/core`](https://docs.ag-ui.com/sdk/js/core/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
