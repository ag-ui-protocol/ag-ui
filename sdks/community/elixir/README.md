# AgUI

Elixir SDK for the AG‑UI protocol (SSE v1) with optional Phoenix LiveView integration.

## Features

- Typed protocol events and message/tool structs
- SSE client with chunk normalization and compaction helpers
- Protocol reducer and LiveView‑friendly renderer
- Optional LiveView component kit and runner
- Safe normalization option (`RUN_ERROR` on malformed chunks)
- SSE resume via `Last-Event-ID`

## Installation

Add `ag_ui` to your dependencies:

```elixir
def deps do
  [
    {:ag_ui, "~> 0.1.0"}
  ]
end
```

## Basic usage

```elixir
alias AgUI.Client.HttpAgent
alias AgUI.Types.RunAgentInput

agent = HttpAgent.new(url: "https://api.example.com/agent")
input = RunAgentInput.new("thread-1", "run-1")

{:ok, stream} = HttpAgent.stream_canonical(agent, input, on_error: :run_error)
Enum.each(stream, &IO.inspect/1)
```

### High-level run helper

```elixir
{:ok, result} = HttpAgent.run_agent(agent, input)
IO.inspect(result.new_messages)
IO.inspect(result.session.state)
```

### High-level run helper via AgUI

```elixir
{:ok, result} = AgUI.run_agent(agent, input)
IO.inspect(result.new_messages)
```

### High-level run helper (bang)

```elixir
result = HttpAgent.run_agent!(agent, input)
IO.inspect(result.new_messages)
```

## Server-side SSE encoding

```elixir
alias AgUI.Events.RunStarted
alias AgUI.Transport.SSE.Writer

event = %RunStarted{thread_id: "t1", run_id: "r1"}
{:ok, conn} = Writer.write_event(conn, event)
```

### Plug controller streaming example

```elixir
defmodule MyAppWeb.AgentController do
  use MyAppWeb, :controller

  alias AgUI.Events
  alias AgUI.Transport.SSE.Writer

  def run(conn, _params) do
    conn = Writer.prepare_conn(conn)

    {:ok, conn} =
      Writer.write_event(conn, %Events.RunStarted{thread_id: "t1", run_id: "r1"})

    {:ok, conn} =
      Writer.write_event(conn, %Events.TextMessageContent{
        message_id: "m1",
        delta: "Hello from Elixir",
        role: :assistant
      })

    {:ok, conn} =
      Writer.write_event(conn, %Events.RunFinished{thread_id: "t1", run_id: "r1"})

    conn
  end
end
```

### SSE resume

Pass `last_event_id` to resume from a previous event id:

```elixir
{:ok, stream} =
  HttpAgent.stream_canonical(agent, input,
    last_event_id: "evt-123",
    on_error: :run_error
  )
```

## LiveView integration (optional)

LiveView support is fully optional. Use the pure renderer and runner to
drive a LiveView without forcing Phoenix deps on non‑Phoenix users.

```elixir
alias AgUI.LiveView.Runner
alias AgUI.LiveView.Renderer

ui_state = Renderer.init()
{:ok, pid} =
  Runner.start_link(
    liveview: self(),
    agent: agent,
    run_params: input,
    tag: :agui
  )
```

You can also inject the component kit via:

```elixir
defmodule MyAppWeb.AGUIComponents do
  use Phoenix.Component
  use AgUI.LiveView.Components
end
```

## Demo app

The `demo/` directory contains a Phoenix LiveView app that exercises the SDK
via a local mock agent endpoint.

```bash
cd demo
mix deps.get
mix phx.server
```

## Testing

```bash
mix test
```

## Deferred features (not yet implemented)

- Binary protocol transport (`application/vnd.ag-ui.event+proto`)
- WebSocket transport
- CI Dialyzer/Credo gates

## License

Apache-2.0
