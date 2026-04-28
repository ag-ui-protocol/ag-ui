defmodule AgUi.Transport.SSE do
  @moduledoc """
  Server-Sent Events (SSE) transport for AG-UI.

  Provides a Plug-compatible handler that streams AG-UI events to clients
  as SSE data frames. Works with any Plug-based server (Phoenix, Cowboy, Bandit).

  ## Usage in Phoenix Router

      # In your router
      scope "/ag-ui" do
        pipe_through :api
        get "/events", AgUi.Transport.SSE, :stream
      end

  ## Usage as Plug

      # In a Plug pipeline
      forward "/ag-ui/events", AgUi.Transport.SSE, pubsub: MyApp.PubSub, topic: "ag_ui:events"

  ## Direct Usage

      # In a controller action
      def stream(conn, _params) do
        AgUi.Transport.SSE.stream_events(conn, MyApp.PubSub, "ag_ui:events")
      end
  """

  import Plug.Conn
  alias AgUi.Encoder.EventEncoder

  @behaviour Plug

  @type option ::
          {:pubsub, module()}
          | {:topic, String.t()}
          | {:filter, (struct() -> boolean())}
          | {:keepalive_ms, pos_integer()}

  @default_keepalive_ms 15_000

  @impl Plug
  def init(opts) do
    %{
      pubsub: Keyword.fetch!(opts, :pubsub),
      topic: Keyword.get(opts, :topic, "ag_ui:events"),
      filter: Keyword.get(opts, :filter, fn _event -> true end),
      keepalive_ms: Keyword.get(opts, :keepalive_ms, @default_keepalive_ms)
    }
  end

  @impl Plug
  def call(conn, %{pubsub: pubsub, topic: topic} = opts) do
    stream_events(conn, pubsub, topic, opts)
  end

  @doc """
  Starts streaming AG-UI events over an SSE connection.

  Subscribes to the given PubSub topic and forwards all events matching
  the optional filter function. Sends keepalive comments every `keepalive_ms`
  milliseconds to prevent connection timeout.

  This function does not return until the client disconnects.
  """
  @spec stream_events(Plug.Conn.t(), module(), String.t(), map()) :: Plug.Conn.t()
  def stream_events(conn, pubsub, topic, opts \\ %{}) do
    filter = Map.get(opts, :filter, fn _event -> true end)
    keepalive_ms = Map.get(opts, :keepalive_ms, @default_keepalive_ms)

    Phoenix.PubSub.subscribe(pubsub, topic)

    conn =
      conn
      |> put_resp_content_type("text/event-stream")
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("connection", "keep-alive")
      |> put_resp_header("x-accel-buffering", "no")
      |> send_chunked(200)

    stream_loop(conn, filter, keepalive_ms)
  end

  @doc """
  Sends a single AG-UI event over an existing chunked SSE connection.
  """
  @spec send_event(Plug.Conn.t(), struct()) :: {:ok, Plug.Conn.t()} | {:error, term()}
  def send_event(conn, event) do
    chunk(conn, EventEncoder.encode(event))
  end

  @doc """
  Sends a batch of AG-UI events over an existing chunked SSE connection.
  """
  @spec send_events(Plug.Conn.t(), [struct()]) :: {:ok, Plug.Conn.t()} | {:error, term()}
  def send_events(conn, events) do
    data = events |> Enum.map(&EventEncoder.encode/1) |> Enum.join()
    chunk(conn, data)
  end

  @doc """
  Broadcasts an AG-UI event to all subscribers on a PubSub topic.
  """
  @spec broadcast(module(), String.t(), struct()) :: :ok | {:error, term()}
  def broadcast(pubsub, topic, event) do
    Phoenix.PubSub.broadcast(pubsub, topic, {:ag_ui_event, event})
  end

  @doc """
  Broadcasts an AG-UI event locally (current node only).
  """
  @spec broadcast_local(module(), String.t(), struct()) :: :ok | {:error, term()}
  def broadcast_local(pubsub, topic, event) do
    Phoenix.PubSub.local_broadcast(pubsub, topic, {:ag_ui_event, event})
  end

  # -- Private ----------------------------------------------------------------

  defp stream_loop(conn, filter, keepalive_ms) do
    receive do
      {:ag_ui_event, event} ->
        if filter.(event) do
          case send_event(conn, event) do
            {:ok, conn} -> stream_loop(conn, filter, keepalive_ms)
            {:error, _reason} -> conn
          end
        else
          stream_loop(conn, filter, keepalive_ms)
        end

      :keepalive ->
        case chunk(conn, ": keepalive\n\n") do
          {:ok, conn} -> stream_loop(conn, filter, keepalive_ms)
          {:error, _reason} -> conn
        end
    after
      keepalive_ms ->
        case chunk(conn, ": keepalive\n\n") do
          {:ok, conn} -> stream_loop(conn, filter, keepalive_ms)
          {:error, _reason} -> conn
        end
    end
  end
end
