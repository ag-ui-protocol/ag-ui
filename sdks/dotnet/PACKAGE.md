# AG-UI .NET SDK

AG-UI (Agent User Interaction Protocol) standardizes streaming communication between AI agents and user interfaces. The .NET SDK provides protocol types, wire formatters, protobuf support, an HTTP client, and a framework-agnostic server adapter built around `Microsoft.Extensions.AI`.

## Packages

- `AGUI.Abstractions` — protocol events, messages, tools, capabilities, and JSON serialization.
- `AGUI.Formatting` — event stream formatter abstractions and Server-Sent Events support.
- `AGUI.Protobuf` — protobuf codec and binary event stream formatting.
- `AGUI.Client` — AG-UI HTTP client and `IChatClient` integration.
- `AGUI.Server` — server-side adapter from `ChatResponseUpdate` streams to AG-UI events.

## Client context

`RunAgentInput.ToChatRequestContext` makes nonempty `Context` entries visible to the model as one user message containing a JSON array, after any leading system or developer messages. The original input is unchanged. Applications that already inject context manually should avoid injecting it twice. Context remains caller-supplied data; the host or agent framework controls message persistence. See [Messages and the request payload](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/dotnet/docs/architecture.md#messages-and-the-request-payload) for the format and behavior.

For documentation, samples, and source, see https://github.com/ag-ui-protocol/ag-ui.
