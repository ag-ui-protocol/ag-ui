defmodule AgUI.Transport.SSE.Writer do
  @moduledoc """
  SSE writer utilities for emitting AG-UI events.

  Encodes events as SSE frames:
    data: <json>
    \\n
  """

  alias AgUI.Encoder
  alias AgUI.Events

  @type sse_opts :: [
          event: String.t() | nil,
          id: String.t() | nil,
          retry: non_neg_integer() | nil,
          content_type: String.t()
        ]

  @doc """
  Encodes an AG-UI event into an SSE frame.

  ## Options
  - `:event` - SSE event type (optional)
  - `:id` - SSE event id (optional)
  - `:retry` - SSE retry value in ms (optional)
  - `:content_type` - encoding content type (default: application/json)
  """
  @spec encode_event(Events.t(), sse_opts()) :: iodata()
  def encode_event(event, opts \\ []) do
    content_type = Keyword.get(opts, :content_type, "application/json")
    data = Encoder.encode_event(event, content_type)
    encode_data(data, opts)
  end

  @doc """
  Encodes raw data into an SSE frame.
  """
  @spec encode_data(binary(), sse_opts()) :: iodata()
  def encode_data(data, opts \\ []) when is_binary(data) do
    event = Keyword.get(opts, :event)
    id = Keyword.get(opts, :id)
    retry = Keyword.get(opts, :retry)

    [
      maybe_field("event", event),
      maybe_field("id", id),
      maybe_field("retry", retry && Integer.to_string(retry)),
      data_lines(data),
      "\n"
    ]
  end

  if Code.ensure_loaded?(Plug.Conn) do
    @default_headers [
      {"content-type", "text/event-stream"},
      {"cache-control", "no-cache"},
      {"connection", "keep-alive"}
    ]

    @doc """
    Prepares a Plug.Conn for SSE streaming.

    Sets content-type and common SSE headers, then sends a chunked response.

    ## Examples

        conn = AgUI.Transport.SSE.Writer.prepare_conn(conn)
    """
    @spec prepare_conn(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
    def prepare_conn(%Plug.Conn{} = conn, opts \\ []) do
      status = Keyword.get(opts, :status, 200)
      extra_headers = Keyword.get(opts, :headers, [])

      headers = @default_headers ++ extra_headers

      conn
      |> put_headers(headers)
      |> Plug.Conn.send_chunked(status)
    end

    defp put_headers(conn, headers) do
      Enum.reduce(headers, conn, fn {k, v}, acc ->
        Plug.Conn.put_resp_header(acc, k, v)
      end)
    end
  end

  @doc """
  Writes an SSE frame to an IO device or Plug.Conn.

  For Plug.Conn targets, this will auto-prepare the connection unless
  `auto_prepare: false` is provided.

  ## Examples

      event = %AgUI.Events.RunStarted{thread_id: "t1", run_id: "r1"}
      AgUI.Transport.SSE.Writer.write_event(conn, event)
  """
  @spec write_event(IO.device() | Plug.Conn.t(), Events.t(), sse_opts()) ::
          :ok | {:error, term()} | {:ok, Plug.Conn.t()}
  def write_event(target, event, opts \\ []) do
    if Code.ensure_loaded?(Plug.Conn) and match?(%Plug.Conn{}, target) do
      conn = target
      auto_prepare? = Keyword.get(opts, :auto_prepare, true)

      conn =
        if auto_prepare? and conn.state != :chunked do
          prepare_conn(conn, opts)
        else
          conn
        end

      frame = encode_event(event, opts)
      Plug.Conn.chunk(conn, frame)
    else
      frame = encode_event(event, opts)
      IO.binwrite(target, frame)
      :ok
    end
  rescue
    e -> {:error, e}
  end

  defp maybe_field(_name, nil), do: []

  defp maybe_field(name, value) when is_binary(value) do
    [name, ": ", value, "\n"]
  end

  defp data_lines(data) do
    data
    |> String.split("\n", trim: false)
    |> Enum.map(fn line -> ["data: ", line, "\n"] end)
  end
end
