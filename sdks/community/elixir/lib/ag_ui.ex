defmodule AgUi do
  @moduledoc """
  AG-UI -- Elixir SDK for the Agent-User Interaction Protocol.

  AG-UI is an open, lightweight, event-based protocol that standardizes
  how AI agents connect to user-facing applications. This SDK provides:

  - `AgUi.Core.Types` -- Message types, tool calls, and agent input structs
  - `AgUi.Core.Events` -- All 30+ AG-UI event types as Elixir structs
  - `AgUi.Encoder.EventEncoder` -- SSE and JSON encoding/decoding

  ## Quick Start

      alias AgUi.Core.Events.{RunStarted, TextMessageContent, RunFinished}
      alias AgUi.Encoder.EventEncoder

      # Create events
      start = %RunStarted{thread_id: "t1", run_id: "r1"}
      content = %TextMessageContent{message_id: "m1", delta: "Hello!"}
      finish = %RunFinished{thread_id: "t1", run_id: "r1"}

      # Encode to SSE
      [start, content, finish]
      |> Enum.map(&EventEncoder.encode/1)
      |> Enum.join()

  ## Protocol Version

  This SDK implements the AG-UI protocol as defined at
  github.com/ag-ui-protocol/ag-ui.
  """

  @doc "Returns the SDK version."
  @spec version() :: String.t()
  def version, do: "0.1.0"
end
