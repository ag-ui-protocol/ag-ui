# @ag-ui/proto

Protocol Buffer encoding/decoding for **Agent-User Interaction (AG-UI) Protocol** events.

`@ag-ui/proto` provides high-performance binary serialization of AG-UI events using Protocol Buffers. It includes generated TypeScript definitions and utilities for converting between AG-UI's JSON event format and compact binary representation.

## Installation

```bash
npm install @ag-ui/proto zod
pnpm add @ag-ui/proto zod
yarn add @ag-ui/proto zod
```

zod (3.25.18+ or 4.x) is a peer dependency. `encode` validates each event with
the schemas on `@ag-ui/core/schemas`, using the zod your application installs
rather than a bundled copy.

## Features

- ⚡ **High performance** – Binary protobuf encoding for minimal bandwidth usage
- 🔄 **Round-trip safety** – Compatible conversion between JSON and binary formats
- 📋 **Generated types** – Auto-generated TypeScript definitions from `.proto` schemas
- 🔧 **Length-prefixed** – Standard 4-byte length headers for streaming protocols
- 🖼️ **Multimodal snapshots** – Supports multimodal user content parts in message snapshots

## Quick example

```ts
import { encode, decode, AGUI_MEDIA_TYPE } from "@ag-ui/proto";
import { EventType } from "@ag-ui/core";

const event = {
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg_123",
  role: "assistant",
};

// Encode to binary protobuf format
const encoded = encode(event);

// Decode back to AG-UI event
const decoded = decode(encoded);
console.log(decoded); // Original event object
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/proto`](https://docs.ag-ui.com/sdk/js/proto)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
