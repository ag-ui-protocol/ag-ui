defmodule AgUI.Client.HttpAgent do
  @moduledoc """
  HTTP client for AG-UI agent endpoints.

  Connects to agent endpoints via HTTP POST with SSE streaming response.
  This is the primary client for consuming AG-UI protocol events.

  ## Usage

      # Create an agent client
      agent = AgUI.Client.HttpAgent.new(url: "https://api.example.com/agent")

      # Create run input
      input = AgUI.Types.RunAgentInput.new("thread-1", "run-1",
        messages: [%AgUI.Types.Message.User{id: "1", role: :user, content: "Hello"}]
      )

      # Stream events
      {:ok, stream} = AgUI.Client.HttpAgent.stream(agent, input)
      Enum.each(stream, fn event ->
        IO.inspect(event)
      end)

  ## Options

  - `:url` - Required. The agent endpoint URL
  - `:headers` - Additional HTTP headers to send
  - `:timeout` - Request timeout in milliseconds (default: 60_000)

  """

  alias AgUI.Types.RunAgentInput
  alias AgUI.Transport.SSE
  alias AgUI.Events

  @type t :: %__MODULE__{
          url: String.t(),
          headers: [{String.t(), String.t()}],
          timeout: non_neg_integer()
        }

  defstruct [:url, headers: [], timeout: 60_000]

  @doc """
  Creates a new HTTP agent client.

  ## Options

  - `:url` - Required. The agent endpoint URL
  - `:headers` - Additional HTTP headers (default: [])
  - `:timeout` - Request timeout in milliseconds (default: 60_000)

  ## Examples

      iex> agent = AgUI.Client.HttpAgent.new(url: "https://api.example.com/agent")
      %AgUI.Client.HttpAgent{url: "https://api.example.com/agent"}

      iex> agent = AgUI.Client.HttpAgent.new(
      ...>   url: "https://api.example.com/agent",
      ...>   headers: [{"authorization", "Bearer token"}],
      ...>   timeout: 120_000
      ...> )

  """
  @spec new(keyword()) :: t()
  def new(opts) do
    %__MODULE__{
      url: Keyword.fetch!(opts, :url),
      headers: Keyword.get(opts, :headers, []),
      timeout: Keyword.get(opts, :timeout, 60_000)
    }
  end

  @doc """
  Streams raw SSE events from the agent.

  Returns `{:ok, stream}` where stream is an enumerable of raw SSE event maps,
  or `{:error, reason}` if the connection fails.

  For decoded AG-UI events, use `stream/2` instead.

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream_raw(agent, input)
      Enum.each(stream, fn sse_event ->
        IO.puts(sse_event.data)
      end)

  """
  @spec stream_raw(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_raw(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    body = RunAgentInput.to_map(input) |> Jason.encode!()

    headers =
      [
        {"content-type", "application/json"},
        {"accept", "text/event-stream"}
      ] ++ agent.headers

    req =
      Req.new(
        url: agent.url,
        method: :post,
        body: body,
        headers: headers,
        receive_timeout: agent.timeout,
        into: :self
      )

    case Req.request(req) do
      {:ok, %Req.Response{status: status, body: %Req.Response.Async{}} = resp}
      when status in 200..299 ->
        {:ok, build_sse_stream(resp)}

      {:ok, %Req.Response{status: status, body: %Req.Response.Async{}} = resp} ->
        # Cancel the async stream before returning error
        Req.cancel_async_response(resp)
        {:error, {:http_error, status, nil}}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:http_error, status, body}}

      {:error, %Req.TransportError{reason: reason}} ->
        {:error, {:transport_error, reason}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Streams decoded AG-UI events from the agent.

  Returns `{:ok, stream}` where stream is an enumerable of decoded AG-UI event structs,
  or `{:error, reason}` if the connection fails.

  Unknown or malformed events are silently skipped.

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream(agent, input)
      Enum.each(stream, fn event ->
        case event do
          %AgUI.Events.TextMessageContent{delta: delta} ->
            IO.write(delta)
          %AgUI.Events.RunFinished{} ->
            IO.puts("\\nDone!")
          _ ->
            :ok
        end
      end)

  """
  @spec stream(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    case stream_raw(agent, input) do
      {:ok, sse_stream} ->
        event_stream =
          sse_stream
          |> Stream.flat_map(&decode_sse_event/1)

        {:ok, event_stream}

      error ->
        error
    end
  end

  @doc """
  Streams canonical AG-UI events from the agent.

  This is similar to `stream/2` but expands any chunk events (TEXT_MESSAGE_CHUNK,
  TOOL_CALL_CHUNK) into their canonical start/content/end triads using
  `AgUI.Normalize.expand_stream/1`.

  This is the recommended function for UI rendering, as it provides a consistent
  event structure.

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream_canonical(agent, input)
      Enum.each(stream, fn event ->
        case event do
          %AgUI.Events.TextMessageStart{} -> IO.puts("Message started")
          %AgUI.Events.TextMessageContent{delta: delta} -> IO.write(delta)
          %AgUI.Events.TextMessageEnd{} -> IO.puts("")
          _ -> :ok
        end
      end)

  """
  @spec stream_canonical(t(), RunAgentInput.t()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_canonical(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    stream_canonical(agent, input, [])
  end

  @spec stream_canonical(t(), RunAgentInput.t(), keyword()) :: {:ok, Enumerable.t()} | {:error, term()}
  def stream_canonical(%__MODULE__{} = agent, %RunAgentInput{} = input, opts) do
    on_error = Keyword.get(opts, :on_error, :raise)

    case stream(agent, input) do
      {:ok, event_stream} ->
        canonical_stream =
          case on_error do
            :run_error -> AgUI.Normalize.expand_stream_safe(event_stream)
            _ -> AgUI.Normalize.expand_stream(event_stream)
          end

        {:ok, canonical_stream}

      error ->
        error
    end
  end

  @doc """
  Streams decoded AG-UI events, raising on connection error.

  ## Examples

      stream = AgUI.Client.HttpAgent.stream!(agent, input)
      Enum.each(stream, fn event -> ... end)

  """
  @spec stream!(t(), RunAgentInput.t()) :: Enumerable.t()
  def stream!(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    case stream(agent, input) do
      {:ok, stream} -> stream
      {:error, reason} -> raise "Failed to connect to agent: #{inspect(reason)}"
    end
  end

  @doc """
  Collects all events from a run into a list.

  This is a convenience function that consumes the entire stream.
  For large streams, prefer using `stream/2` directly.

  ## Examples

      {:ok, events} = AgUI.Client.HttpAgent.run(agent, input)
      Enum.each(events, &IO.inspect/1)

  """
  @spec run(t(), RunAgentInput.t()) :: {:ok, [Events.t()]} | {:error, term()}
  def run(%__MODULE__{} = agent, %RunAgentInput{} = input) do
    case stream(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)
        {:ok, events}

      error ->
        error
    end
  end

  # Build a stream from Req's async response
  defp build_sse_stream(%Req.Response{body: %Req.Response.Async{} = async}) do
    ref = async.ref

    Stream.resource(
      fn -> {ref, SSE.new()} end,
      fn
        {ref, :done} ->
          {:halt, {ref, :done}}

        {ref, parser} ->
          receive do
            {^ref, {:data, chunk}} ->
              {events, parser} = SSE.feed(parser, chunk)
              {events, {ref, parser}}

            {^ref, :done} ->
              {final_events, _parser} = SSE.finalize(parser)
              {final_events, {ref, :done}}

            {^ref, {:error, reason}} ->
              throw({:stream_error, reason})
          after
            # Use a long timeout since we're waiting for streaming data
            300_000 ->
              throw(:stream_timeout)
          end
      end,
      fn _ -> :ok end
    )
  end

  # Decode SSE event data as JSON and then as AG-UI event
  defp decode_sse_event(%{data: data}) do
    with {:ok, json} <- Jason.decode(data),
         {:ok, event} <- Events.decode(json) do
      [event]
    else
      _ -> []
    end
  end
end
