# @ag-ui/encoder

Event encoding utilities for the **Agent-User Interaction (AG-UI) Protocol**.

`@ag-ui/encoder` handles content negotiation and format encoding for AG-UI events. It automatically chooses between Server-Sent Events (JSON) and Protocol Buffers based on client `Accept` headers, ensuring optimal transport efficiency.

## Installation

```bash
npm install @ag-ui/encoder
pnpm add @ag-ui/encoder
yarn add @ag-ui/encoder
```

## Features

- 🎯 **Content negotiation** – Automatic format selection based on `Accept` headers
- 📦 **Dual encoding** – SSE (JSON) and Protocol Buffer support
- ⚡ **Efficient binary** – Length-prefixed protobuf encoding for high-throughput scenarios
- 🔄 **Seamless fallback** – Graceful degradation to SSE when protobuf isn't supported

## Quick example

```ts
import { EventEncoder } from "@ag-ui/encoder";
import { EventType } from "@ag-ui/core";

const encoder = new EventEncoder({
  accept: "application/vnd.ag-ui.event+proto, text/event-stream",
});

const event = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg_123",
  delta: "Hello, world!",
};

// Returns protobuf-encoded binary data
const encoded = encoder.encodeBinary(event);
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/encoder`](https://docs.ag-ui.com/sdk/js/encoder)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
