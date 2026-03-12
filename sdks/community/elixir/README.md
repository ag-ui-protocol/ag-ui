# AG-UI Elixir SDK

[![CI](https://github.com/peguesj/ag_ui_ex/actions/workflows/ci.yml/badge.svg)](https://github.com/peguesj/ag_ui_ex/actions/workflows/ci.yml)
[![Hex.pm](https://img.shields.io/hexpm/v/ag_ui_ex.svg)](https://hex.pm/packages/ag_ui_ex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Elixir SDK for the [AG-UI (Agent-User Interaction)](https://github.com/ag-ui-protocol/ag-ui) protocol. Provides typed event structs, SSE/Channel transports, middleware pipeline, state management with JSON Patch (RFC 6902), and an HTTP client for consuming AG-UI event streams.

## Features

- **30+ typed event structs** -- All AG-UI event types as Elixir structs with validation
- **SSE transport** -- Plug-based Server-Sent Events for streaming events to clients
- **Channel transport** -- Phoenix Channel macros for WebSocket-based event streaming
- **Middleware pipeline** -- Composable event processing with built-in middleware
- **State management** -- GenServer with snapshot/delta pattern and full RFC 6902 JSON Patch
- **HTTP client** -- GenServer for consuming AG-UI event streams over SSE
- **Encoder** -- SSE and JSON encoding/decoding with camelCase/snake_case conversion

## Installation

Add `ag_ui_ex` to your dependencies in `mix.exs`:

```elixir
def deps do
  [
    {:ag_ui_ex, "~> 0.1.0"}
  ]
end
```

## Quick Start

### Emit Events

```elixir
alias AgUi.Core.Events

# Create a run started event
event = %Events.RunStarted{
  run_id: "run-001",
  thread_id: "thread-001",
  timestamp: DateTime.utc_now() |> DateTime.to_unix(:millisecond)
}

# Encode as SSE
{:ok, sse_data} = AgUi.Encoder.EventEncoder.encode(event)
```

### SSE Transport (Plug)

```elixir
# In your Phoenix router or Plug pipeline
forward "/ag-ui/events", AgUi.Transport.SSE

# Or use directly in a controller
def stream(conn, _params) do
  AgUi.Transport.SSE.stream_events(conn, fn send_fn ->
    send_fn.(%Events.RunStarted{run_id: "run-001"})
    Process.sleep(100)
    send_fn.(%Events.RunFinished{run_id: "run-001"})
  end)
end
```

### Channel Transport (Phoenix)

```elixir
defmodule MyApp.AgUiChannel do
  use Phoenix.Channel
  use AgUi.Transport.Channel

  def join("ag_ui:" <> _scope, _payload, socket) do
    {:ok, socket}
  end
end
```

### State Management

```elixir
# Start the state manager
{:ok, pid} = AgUi.State.Manager.start_link(name: :my_agent_state)

# Set state
AgUi.State.Manager.set(pid, %{status: "running", progress: 0})

# Apply JSON Patch delta
AgUi.State.Manager.patch(pid, [
  %{"op" => "replace", "path" => "/progress", "value" => 75}
])

# Get current state
{:ok, state} = AgUi.State.Manager.get(pid)
# => %{status: "running", progress: 75}
```

### Middleware Pipeline

```elixir
alias AgUi.Middleware.Pipeline

pipeline =
  Pipeline.new()
  |> Pipeline.add(&Pipeline.add_timestamp/2)
  |> Pipeline.add(&Pipeline.validate_type/2)

{:ok, processed_event} = Pipeline.run(pipeline, event)
```

### HTTP Client

```elixir
# Connect to an AG-UI event stream
{:ok, client} = AgUi.Client.HttpAgent.start_link(
  url: "http://localhost:4000/ag-ui/events",
  handler: fn event -> IO.inspect(event, label: "AG-UI Event") end
)
```

## Event Types

| Category | Events |
|:---------|:-------|
| Lifecycle | `RunStarted`, `RunFinished`, `RunError` |
| Progress | `StepStarted`, `StepFinished` |
| Text | `TextMessageStart`, `TextMessageContent`, `TextMessageEnd` |
| Thinking | `ThinkingTextMessageStart`, `ThinkingTextMessageContent`, `ThinkingTextMessageEnd`, `ThinkingStart`, `ThinkingEnd` |
| Tools | `ToolCallStart`, `ToolCallArgs`, `ToolCallEnd` |
| State | `StateSnapshot`, `StateDelta` |
| Messages | `MessagesSnapshot` |
| Activity | `ActivitySnapshot`, `ActivityDelta` |
| Reasoning | `ReasoningStart`, `ReasoningMessageStart`, `ReasoningMessageContent`, `ReasoningMessageEnd`, `ReasoningMessageChunk`, `ReasoningEnd` |
| Other | `EncryptedValue`, `Raw`, `Custom` |

## Protocol Reference

This SDK implements the [AG-UI protocol specification](https://github.com/ag-ui-protocol/ag-ui). The protocol defines a standardized, event-based communication layer between AI agents and user interfaces.

## Contributing

Contributions are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

Copyright (c) 2026 Jeremiah Pegues
