# AG-UI .NET SDK

AG-UI (Agent User Interaction Protocol) standardizes streaming communication between AI agents and user interfaces. The .NET SDK provides protocol types, wire formatters, protobuf support, an HTTP client, and a framework-agnostic server adapter built around `Microsoft.Extensions.AI`.

## Packages

- `AGUI.Abstractions` — protocol events, messages, tools, capabilities, and JSON serialization.
- `AGUI.Formatting` — event stream formatter abstractions and Server-Sent Events support.
- `AGUI.Protobuf` — protobuf codec and binary event stream formatting.
- `AGUI.Client` — AG-UI HTTP client and `IChatClient` integration.
- `AGUI.Server` — server-side adapter from `ChatResponseUpdate` streams to AG-UI events.

## Server error diagnostics

Configure `AGUIStreamOptions.OnStreamingError((exception, context) => ...)` and
pass those options to `ToChatRequestContext` to observe the original exception
when the adapter emits a `StreamingError`. The callback runs before the error
event, with or without tracing, so a host can log the stack trace and request
identity while clients receive the existing sanitized error. Observer failures
do not interrupt error delivery or cleanup; caller-requested cancellation does
not invoke the observer.

See [observing streaming errors](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/dotnet/docs/architecture.md#observing-streaming-errors)
for a logging example and callback semantics.

For documentation, samples, and source, see https://github.com/ag-ui-protocol/ag-ui.
