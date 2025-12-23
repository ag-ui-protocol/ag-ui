# ag-ui-protocol

Ruby SDK for the **Agent-User Interaction (AG-UI) Protocol**.

`ag-ui-protocol` provides Ruby developers with strongly-typed data structures and event encoding for building AG-UI compatible agent servers. Built on Sorbet for robust validation and automatic camelCase serialization for seamless frontend integration.

## Installation

Install bundle:

```bash
gem install bundler
```

Add the gem:

```bash
bundle add ag-ui-protocol
```

## Features

- 🐍 **Ruby-native** – Ruby APIs with full type hints and validation
- 📋 **Sorbet Runtime** – Runtime validation scheme
- 🔄 **Streaming events** – 16 core event types for real-time agent communication
- ⚡ **High performance** – Efficient event encoding for Server-Sent Events

## Quick example

```ruby
require "ag_ui_protocol"

event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(
    message_id: "msg_123",
    delta: "Hello from Ruby!",
)

encoder = AgUiProtocol::Encoder::EventEncoder.new
encoded_event = encoder.encode(event)
```

### Multimodal user message

```ruby
require "ag_ui_protocol/core/types"

message = AgUiProtocol::Core::Types::UserMessage.new(
    id: "user-123",
    content: [
        { type: "text", text: "Please describe this image" },
        { type: "binary", mimeType: "image/png", url: "https://example.com/a.png" }
        # or
        AgUiProtocol::Core::Types::TextInputContent.new(text: "Please describe this image"),
        AgUiProtocol::Core::Types::BinaryInputContent.new(mime_type: "image/png", url: "https://example.com/cat.png"),
    ],
)
```

## Packages

- **`AgUiProtocol::Core::Types`** – Message types, tools, and data models
- **`AgUiProtocol::Core::Events`** – Event types and event handling
- **`AgUiProtocol::Encoder`** – Event encoding utilities for HTTP streaming

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/ruby`](../../../docs/sdk/ruby/overview.mdx)

## Examples

See the [`example/`](example/) directory for:

- [Simple use case](example/simple-use/README.md)
- [Minimal Rails example](example/rails/README.md)

## Sync documentation

To sync the documentation of YARD with the path `docs/sdk/ruby`, run the following command:

```bash
cd sdks/community/ruby
rake doc
```

## Testing

```bash
cd sdks/community/ruby
rake test
```

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors