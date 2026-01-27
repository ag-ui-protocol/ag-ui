if Code.ensure_loaded?(Phoenix.Component) do
  defmodule AgUI.LiveView.Components do
    @moduledoc """
    AG-UI component kit for Phoenix LiveView.

    This module provides pre-built LiveView components for rendering AG-UI
    chat interfaces. Components support pluggable renderers for custom
    message and activity types.

    ## Usage

    Import the components into your LiveView module:

        defmodule MyAppWeb.ChatLive do
          use MyAppWeb, :live_view
          import AgUI.LiveView.Components

          def render(assigns) do
            ~H\"\"\"
            <.agui_chat ui_state={@agui} />
            \"\"\"
          end
        end

    ## Components

    - `agui_chat/1` - Main chat container
    - `agui_message_list/1` - List of messages with streaming support
    - `agui_message/1` - Single message with role-based rendering
    - `agui_streaming_text/1` - Streaming text with cursor
    - `agui_tool_call/1` - Tool call display
    - `agui_run_status/1` - Run status indicator
    - `agui_thinking/1` - Thinking indicator
    - `agui_state_debug/1` - State debug view
    - `agui_streaming_tools/1` - Streaming tool calls display

    ## Customization

    For custom message or activity rendering, you can define your own components
    that wrap or replace these defaults.

    """

    use Phoenix.Component

    @doc """
    Main chat container component.

    ## Attributes

    - `ui_state` - The AG-UI renderer state (required)
    - `class` - Additional CSS classes (default: "")
    - `show_status` - Whether to show run status (default: true)
    - `show_thinking` - Whether to show thinking indicator (default: true)

    ## Example

        <.agui_chat ui_state={@agui} />

    """
    attr :ui_state, :map, required: true
    attr :class, :string, default: ""
    attr :show_status, :boolean, default: true
    attr :show_thinking, :boolean, default: true

    def agui_chat(assigns) do
      ~H"""
      <div class={"agui-chat " <> @class}>
        <.agui_message_list
          messages={@ui_state.session.messages}
          streaming={@ui_state.streaming_messages}
        />
        <%= if @show_thinking and @ui_state.session.thinking.active do %>
          <.agui_thinking content={@ui_state.session.thinking.content} />
        <% end %>
        <%= if @show_status do %>
          <.agui_run_status status={@ui_state.run_status} steps={@ui_state.steps} />
        <% end %>
      </div>
      """
    end

    @doc """
    Message list component with streaming support.

    ## Attributes

    - `messages` - List of message structs (required)
    - `streaming` - Map of message_id => streaming buffer (default: %{})

    """
    attr :messages, :list, required: true
    attr :streaming, :map, default: %{}

    def agui_message_list(assigns) do
      ~H"""
      <div class="agui-message-list">
        <%= for message <- @messages do %>
          <.agui_message message={message} />
        <% end %>
        <%= for {id, buffer} <- @streaming do %>
          <.agui_streaming_text id={id} content={buffer.content} role={buffer.role} />
        <% end %>
      </div>
      """
    end

    @doc """
    Single message component with role-based rendering.

    ## Attributes

    - `message` - Message struct with :role and :content fields (required)

    """
    attr :message, :map, required: true

    def agui_message(assigns) do
      ~H"""
      <div class={"agui-message agui-message--" <> to_string(@message.role)}>
        <.render_message_content message={@message} />
      </div>
      """
    end

    attr :message, :map, required: true
    defp render_message_content(%{message: %{role: :user}} = assigns) do
      ~H"""
      <div class="agui-user-content"><%= @message.content %></div>
      """
    end

    defp render_message_content(
           %{message: %{role: :assistant, tool_calls: tool_calls}} = assigns
         )
         when is_list(tool_calls) and tool_calls != [] do
      ~H"""
      <div class="agui-assistant-content">
        <%= if @message.content do %><%= @message.content %><% end %>
        <%= for tc <- @message.tool_calls do %>
          <.agui_tool_call tool_call={tc} />
        <% end %>
      </div>
      """
    end

    defp render_message_content(%{message: %{role: :assistant}} = assigns) do
      ~H"""
      <div class="agui-assistant-content"><%= @message.content %></div>
      """
    end

    defp render_message_content(%{message: %{role: :tool}} = assigns) do
      ~H"""
      <pre class="agui-tool-content"><%= @message.content %></pre>
      """
    end

    defp render_message_content(%{message: %{role: :system}} = assigns) do
      ~H"""
      <div class="agui-system-content"><%= @message.content %></div>
      """
    end

    defp render_message_content(%{message: %{role: :developer}} = assigns) do
      ~H"""
      <div class="agui-developer-content"><%= @message.content %></div>
      """
    end

    defp render_message_content(%{message: %{role: :activity}} = assigns) do
      ~H"""
      <div class="agui-activity">
        <div class="agui-activity-type"><%= @message[:activity_type] %></div>
        <pre class="agui-activity-content"><%= format_json(@message[:content]) %></pre>
      </div>
      """
    end

    defp render_message_content(assigns) do
      ~H"""
      <div class="agui-unknown-content"><%= inspect(@message) %></div>
      """
    end

    @doc """
    Streaming text component with cursor indicator.

    ## Attributes

    - `id` - Unique identifier (required)
    - `content` - Current content (required)
    - `role` - Message role (default: :assistant)

    """
    attr :id, :string, required: true
    attr :content, :string, required: true
    attr :role, :atom, default: :assistant

    def agui_streaming_text(assigns) do
      ~H"""
      <div class={"agui-streaming-text agui-streaming-text--" <> to_string(@role)} id={@id}>
        <span class="agui-streaming-content"><%= @content %></span>
        <span class="agui-cursor">|</span>
      </div>
      """
    end

    @doc """
    Tool call display component.

    ## Attributes

    - `tool_call` - Tool call map with :name and :args fields (required)

    """
    attr :tool_call, :map, required: true

    def agui_tool_call(assigns) do
      ~H"""
      <div class="agui-tool-call">
        <div class="agui-tool-name"><%= @tool_call.name %></div>
        <pre class="agui-tool-args"><%= format_json(@tool_call.args) %></pre>
      </div>
      """
    end

    @doc """
    Run status indicator component.

    ## Attributes

    - `status` - Current run status (:idle, :running, :finished, {:error, msg}) (required)
    - `steps` - List of step structs (default: [])

    """
    attr :status, :any, required: true
    attr :steps, :list, default: []

    def agui_run_status(assigns) do
      ~H"""
      <div class={"agui-run-status agui-run-status--" <> status_class(@status)}>
        <span class="agui-status-indicator"></span>
        <span class="agui-status-label"><%= status_label(@status) %></span>
        <%= if @steps != [] do %>
          <div class="agui-steps">
            <%= for step <- @steps do %>
              <span class={"agui-step agui-step--" <> to_string(step.status)}>
                <%= step.name %>
              </span>
            <% end %>
          </div>
        <% end %>
      </div>
      """
    end

    @doc """
    Thinking indicator component.

    ## Attributes

    - `content` - Current thinking content (default: "")
    - `label` - Label text (default: "Thinking...")

    """
    attr :content, :string, default: ""
    attr :label, :string, default: "Thinking..."

    def agui_thinking(assigns) do
      ~H"""
      <div class="agui-thinking">
        <div class="agui-thinking-label"><%= @label %></div>
        <%= if @content != "" do %>
          <div class="agui-thinking-content"><%= @content %></div>
        <% end %>
      </div>
      """
    end

    @doc """
    State debug view component.

    Shows the current shared state in a collapsible details element.

    ## Attributes

    - `state` - State map to display (required)

    """
    attr :state, :map, required: true

    def agui_state_debug(assigns) do
      ~H"""
      <details class="agui-state-debug">
        <summary>State</summary>
        <pre><%= format_json(@state) %></pre>
      </details>
      """
    end

    @doc """
    Streaming tool calls display component.

    ## Attributes

    - `tools` - Map of tool_call_id => tool buffer (required)

    """
    attr :tools, :map, required: true

    def agui_streaming_tools(assigns) do
      ~H"""
      <div class="agui-streaming-tools">
        <%= for {id, tool} <- @tools do %>
          <div class="agui-streaming-tool" id={id}>
            <div class="agui-tool-name"><%= tool.name %></div>
            <pre class="agui-tool-args"><%= tool.args %></pre>
          </div>
        <% end %>
      </div>
      """
    end

    # Helpers
    defp status_class(:idle), do: "idle"
    defp status_class(:running), do: "running"
    defp status_class(:finished), do: "finished"
    defp status_class({:error, _}), do: "error"

    defp status_label(:idle), do: "Ready"
    defp status_label(:running), do: "Running..."
    defp status_label(:finished), do: "Complete"
    defp status_label({:error, msg}), do: "Error: #{msg}"

    defp format_json(data) when is_binary(data) do
      case Jason.decode(data) do
        {:ok, json} -> Jason.encode!(json, pretty: true)
        _ -> data
      end
    end

    defp format_json(data) when is_map(data) do
      Jason.encode!(data, pretty: true)
    end

    defp format_json(other), do: inspect(other)
  end
end
