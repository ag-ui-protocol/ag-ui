# AgUi

Elixir SDK for the AG-UI protocol (SSE v1) with optional Phoenix LiveView integration.

## Installation

If [available in Hex](https://hex.pm/docs/publish), the package can be installed
by adding `ag_ui` to your list of dependencies in `mix.exs`:

```elixir
def deps do
  [
    {:ag_ui, "~> 0.1.0"}
  ]
end
```

Documentation can be generated with [ExDoc](https://github.com/elixir-lang/ex_doc)
and published on [HexDocs](https://hexdocs.pm). Once published, the docs can
be found at <https://hexdocs.pm/ag_ui>.

## Deferred Features (not yet implemented)

- Binary protocol transport (`application/vnd.ag-ui.event+proto`)
- WebSocket transport
- SSE resume via `Last-Event-ID`
- CI Dialyzer/Credo gates
