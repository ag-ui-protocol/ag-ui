defmodule AgUi.Transport.Channel do
  @moduledoc """
  Phoenix Channel transport for AG-UI.

  Provides a channel that streams AG-UI events over WebSocket.
  Clients join a topic and receive events as they're broadcast.

  ## Setup

  Add to your socket:

      # In your UserSocket
      channel "ag_ui:*", AgUi.Transport.Channel

  ## Client Usage

      // JavaScript
      let channel = socket.channel("ag_ui:events", {})
      channel.on("ag_ui_event", (event) => {
        console.log(event.type, event)
      })
      channel.join()

      // Filter by agent
      let agentChannel = socket.channel("ag_ui:agent:my-agent-id", {})

  ## Server-side Broadcasting

      AgUi.Transport.Channel.push_event(socket, event)
      AgUi.Transport.Channel.broadcast_event("ag_ui:events", event)
  """

  @doc false
  defmacro __using__(_opts) do
    quote do
      use Phoenix.Channel
      alias AgUi.Encoder.EventEncoder

      @impl true
      def join("ag_ui:events", params, socket) do
        filter = build_filter(params)
        socket = assign(socket, :ag_ui_filter, filter)

        send(self(), :subscribe_ag_ui)
        {:ok, socket}
      end

      def join("ag_ui:agent:" <> agent_id, _params, socket) do
        socket =
          assign(socket, :ag_ui_filter, fn event ->
            Map.get(event, :run_id) == agent_id or
              Map.get(event, :thread_id) == agent_id
          end)

        send(self(), :subscribe_ag_ui)
        {:ok, socket}
      end

      def join("ag_ui:thread:" <> thread_id, _params, socket) do
        socket =
          assign(socket, :ag_ui_filter, fn event ->
            Map.get(event, :thread_id) == thread_id
          end)

        send(self(), :subscribe_ag_ui)
        {:ok, socket}
      end

      @impl true
      def handle_info(:subscribe_ag_ui, socket) do
        pubsub = socket.endpoint.config(:pubsub_server)
        Phoenix.PubSub.subscribe(pubsub, "ag_ui:events")
        {:noreply, socket}
      end

      def handle_info({:ag_ui_event, event}, socket) do
        filter = socket.assigns[:ag_ui_filter] || fn _ -> true end

        if filter.(event) do
          json = EventEncoder.encode_json(event)
          push(socket, "ag_ui_event", %{data: json, type: event.type})
        end

        {:noreply, socket}
      end

      # -- Helpers --------------------------------------------------------------

      defp build_filter(%{"event_types" => types}) when is_list(types) do
        type_set = MapSet.new(types)
        fn event -> MapSet.member?(type_set, event.type) end
      end

      defp build_filter(%{"agent_id" => agent_id}) when is_binary(agent_id) do
        fn event ->
          Map.get(event, :run_id) == agent_id or
            Map.get(event, :thread_id) == agent_id
        end
      end

      defp build_filter(_params), do: fn _ -> true end

      defoverridable join: 3, handle_info: 2
    end
  end
end
