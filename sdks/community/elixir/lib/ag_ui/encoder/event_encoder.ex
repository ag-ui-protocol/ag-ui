defmodule AgUi.Encoder.EventEncoder do
  @moduledoc """
  Encodes AG-UI events to SSE (Server-Sent Events) format.

  Events are serialized to JSON with camelCase keys and wrapped in the
  SSE `data:` frame format. Nil values are excluded from the output.

  ## Example

      iex> event = %AgUi.Core.Events.RunStarted{thread_id: "t1", run_id: "r1"}
      iex> AgUi.Encoder.EventEncoder.encode(event)
      "data: {\\"type\\":\\"RUN_STARTED\\",\\"threadId\\":\\"t1\\",\\"runId\\":\\"r1\\"}\\n\\n"
  """

  @agui_media_type "application/vnd.ag-ui.event+proto"

  @doc "Returns the AG-UI binary media type."
  @spec media_type() :: String.t()
  def media_type, do: @agui_media_type

  @doc "Returns the SSE content type."
  @spec content_type() :: String.t()
  def content_type, do: "text/event-stream"

  @doc """
  Encodes an event struct to an SSE data frame.

  Converts struct keys to camelCase, drops nil values, and wraps
  in `data: <json>\\n\\n` format.
  """
  @spec encode(struct()) :: String.t()
  def encode(%{__struct__: _} = event) do
    json =
      event
      |> Map.from_struct()
      |> Enum.reject(fn {_k, v} -> is_nil(v) end)
      |> Enum.map(fn {k, v} -> {to_camel_case(k), v} end)
      |> Map.new()
      |> Jason.encode!()

    "data: #{json}\n\n"
  end

  @doc """
  Encodes an event struct to a JSON string (without SSE framing).
  """
  @spec encode_json(struct()) :: String.t()
  def encode_json(%{__struct__: _} = event) do
    event
    |> Map.from_struct()
    |> Enum.reject(fn {_k, v} -> is_nil(v) end)
    |> Enum.map(fn {k, v} -> {to_camel_case(k), v} end)
    |> Map.new()
    |> Jason.encode!()
  end

  @doc """
  Decodes a JSON string into an event map with snake_case keys.
  """
  @spec decode_json(String.t()) :: {:ok, map()} | {:error, term()}
  def decode_json(json) do
    case Jason.decode(json) do
      {:ok, map} ->
        snake =
          map
          |> Enum.map(fn {k, v} -> {to_snake_case(k), v} end)
          |> Map.new()

        {:ok, snake}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # -- Private helpers --------------------------------------------------------

  defp to_camel_case(atom) when is_atom(atom) do
    atom
    |> Atom.to_string()
    |> to_camel_case()
  end

  defp to_camel_case(string) when is_binary(string) do
    [first | rest] = String.split(string, "_")
    first <> Enum.map_join(rest, "", &String.capitalize/1)
  end

  defp to_snake_case(string) when is_binary(string) do
    string
    |> String.replace(~r/([A-Z])/, "_\\1")
    |> String.downcase()
    |> String.trim_leading("_")
  end
end
