defmodule AgUi.Client.HttpAgent do
  @moduledoc """
  HTTP client for consuming AG-UI event streams from remote agents.

  Connects to an AG-UI-compatible HTTP endpoint and returns a stream
  of decoded event structs. Supports SSE (text/event-stream) transport.

  ## Example

      {:ok, pid} = AgUi.Client.HttpAgent.start_link(
        url: "http://localhost:4000/ag-ui/events",
        run_input: %AgUi.Core.Types.RunAgentInput{
          thread_id: "t1",
          run_id: "r1"
        }
      )

      AgUi.Client.HttpAgent.stream(pid, fn event ->
        IO.inspect(event, label: "AG-UI event")
      end)
  """

  use GenServer

  alias AgUi.Encoder.EventEncoder

  @type option ::
          {:url, String.t()}
          | {:run_input, struct()}
          | {:headers, [{String.t(), String.t()}]}
          | {:timeout, pos_integer()}

  defstruct [:url, :run_input, :headers, :timeout, :conn_ref, :buffer, :subscribers]

  # -- Public API -------------------------------------------------------------

  @doc "Starts the HTTP agent client."
  @spec start_link([option()]) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Subscribes the calling process to receive AG-UI events.

  Events are sent as `{:ag_ui_event, event}` messages.
  Returns `:ok` on success.
  """
  @spec subscribe(GenServer.server()) :: :ok
  def subscribe(server) do
    GenServer.call(server, {:subscribe, self()})
  end

  @doc """
  Streams events, calling the given function for each one.

  Blocks until the stream ends (RunFinished/RunError) or timeout.
  """
  @spec stream(GenServer.server(), (struct() -> any()), pos_integer()) :: :ok | {:error, term()}
  def stream(server, callback, timeout \\ 30_000) when is_function(callback, 1) do
    subscribe(server)
    stream_loop(callback, timeout)
  end

  @doc "Starts the SSE connection to the remote agent."
  @spec connect(GenServer.server()) :: :ok | {:error, term()}
  def connect(server) do
    GenServer.call(server, :connect)
  end

  @doc "Disconnects from the remote agent."
  @spec disconnect(GenServer.server()) :: :ok
  def disconnect(server) do
    GenServer.call(server, :disconnect)
  end

  @doc "Returns the current connection status."
  @spec status(GenServer.server()) :: :disconnected | :connecting | :connected | :finished | :error
  def status(server) do
    GenServer.call(server, :status)
  end

  # -- GenServer Callbacks ----------------------------------------------------

  @impl true
  def init(opts) do
    state = %__MODULE__{
      url: Keyword.fetch!(opts, :url),
      run_input: Keyword.get(opts, :run_input),
      headers: Keyword.get(opts, :headers, []),
      timeout: Keyword.get(opts, :timeout, 30_000),
      conn_ref: nil,
      buffer: "",
      subscribers: MapSet.new()
    }

    if Keyword.get(opts, :auto_connect, false) do
      send(self(), :auto_connect)
    end

    {:ok, state}
  end

  @impl true
  def handle_call({:subscribe, pid}, _from, %{subscribers: subs} = state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | subscribers: MapSet.put(subs, pid)}}
  end

  def handle_call(:connect, _from, state) do
    case start_sse_connection(state) do
      {:ok, ref} ->
        {:reply, :ok, %{state | conn_ref: ref, buffer: ""}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:disconnect, _from, %{conn_ref: ref} = state) do
    if ref, do: cancel_connection(ref)
    {:reply, :ok, %{state | conn_ref: nil}}
  end

  def handle_call(:status, _from, %{conn_ref: ref} = state) do
    status = if ref, do: :connected, else: :disconnected
    {:reply, status, state}
  end

  @impl true
  def handle_info(:auto_connect, state) do
    case start_sse_connection(state) do
      {:ok, ref} -> {:noreply, %{state | conn_ref: ref, buffer: ""}}
      {:error, _} -> {:noreply, state}
    end
  end

  def handle_info({:sse_data, data}, %{buffer: buffer} = state) do
    new_buffer = buffer <> data
    {events, remaining} = parse_sse_frames(new_buffer)

    Enum.each(events, fn event ->
      broadcast_event(state.subscribers, event)
    end)

    {:noreply, %{state | buffer: remaining}}
  end

  def handle_info({:sse_done, _ref}, state) do
    {:noreply, %{state | conn_ref: nil}}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, %{subscribers: subs} = state) do
    {:noreply, %{state | subscribers: MapSet.delete(subs, pid)}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -- Private ----------------------------------------------------------------

  defp start_sse_connection(%{url: url, run_input: input, headers: extra_headers}) do
    headers = [
      {"Accept", "text/event-stream"},
      {"Cache-Control", "no-cache"}
      | extra_headers
    ]

    body =
      if input do
        Jason.encode!(Map.from_struct(input))
      end

    # Use Task.async to perform the HTTP request in a separate process.
    # The actual HTTP client is pluggable — this uses a simple :httpc approach.
    parent = self()

    task =
      Task.start_link(fn ->
        do_sse_request(parent, url, headers, body)
      end)

    case task do
      {:ok, pid} -> {:ok, pid}
      error -> error
    end
  end

  defp do_sse_request(parent, url, headers, body) do
    # Convert headers for :httpc
    httpc_headers = Enum.map(headers, fn {k, v} -> {String.to_charlist(k), String.to_charlist(v)} end)

    request =
      if body do
        {String.to_charlist(url), httpc_headers, ~c"application/json", String.to_charlist(body)}
      else
        {String.to_charlist(url), httpc_headers}
      end

    http_method = if body, do: :post, else: :get

    case :httpc.request(http_method, request, [{:timeout, 30_000}], [{:body_format, :binary}, {:sync, true}]) do
      {:ok, {{_, 200, _}, _resp_headers, resp_body}} ->
        send(parent, {:sse_data, IO.iodata_to_binary(resp_body)})
        send(parent, {:sse_done, self()})

      {:ok, {{_, status, _}, _, _}} ->
        send(parent, {:sse_data, ""})
        send(parent, {:sse_done, {:error, {:http_status, status}}})

      {:error, reason} ->
        send(parent, {:sse_done, {:error, reason}})
    end
  end

  defp cancel_connection(ref) when is_pid(ref) do
    Process.exit(ref, :shutdown)
  end

  defp cancel_connection(_), do: :ok

  defp parse_sse_frames(data) do
    # Split on double newline (SSE frame boundary)
    case String.split(data, "\n\n", parts: :infinity) do
      [incomplete] ->
        {[], incomplete}

      frames ->
        {complete, [remaining]} = Enum.split(frames, -1)

        events =
          complete
          |> Enum.flat_map(fn frame ->
            frame
            |> String.split("\n")
            |> Enum.filter(&String.starts_with?(&1, "data: "))
            |> Enum.map(fn "data: " <> json ->
              case EventEncoder.decode_json(json) do
                {:ok, event_map} -> event_map
                {:error, _} -> nil
              end
            end)
            |> Enum.reject(&is_nil/1)
          end)

        {events, remaining}
    end
  end

  defp broadcast_event(subscribers, event) do
    Enum.each(subscribers, fn pid ->
      send(pid, {:ag_ui_event, event})
    end)
  end

  defp stream_loop(callback, timeout) do
    receive do
      {:ag_ui_event, %{type: type} = event} when type in ["RUN_FINISHED", "RUN_ERROR"] ->
        callback.(event)
        :ok

      {:ag_ui_event, event} ->
        callback.(event)
        stream_loop(callback, timeout)
    after
      timeout -> {:error, :timeout}
    end
  end
end
