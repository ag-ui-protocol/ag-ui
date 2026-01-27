defmodule AgUI.Reducer do
  @moduledoc """
  Pure reducer: applies events to session state.

  > Note: This module defines its own `apply/2` function, which shadows
  > `Kernel.apply/2`. Use `Kernel.apply/2` explicitly if needed.

  This module provides a function to apply AG-UI protocol events to a session,
  updating the session state according to the protocol semantics. Each event
  type has specific behavior defined by the AG-UI specification.

  ## Usage

      session = AgUI.Session.new()
      session = AgUI.Reducer.apply(session, run_started_event)
      session = AgUI.Reducer.apply(session, text_message_content_event)
      # ... etc

  ## Event Semantics

  ### Lifecycle Events

  - `RUN_STARTED` - Initializes a new run, resets run-specific state (steps, buffers)
  - `RUN_FINISHED` - Marks the run as complete
  - `RUN_ERROR` - Marks the run as failed with an error message
  - `STEP_STARTED` - Adds a new step to the timeline
  - `STEP_FINISHED` - Marks a step as complete

  ### Text Message Events

  - `TEXT_MESSAGE_START` - Begins a new text message buffer
  - `TEXT_MESSAGE_CONTENT` - Appends content to the buffer
  - `TEXT_MESSAGE_END` - Finalizes the buffer into a message

  ### Tool Call Events

  - `TOOL_CALL_START` - Begins a new tool call buffer
  - `TOOL_CALL_ARGS` - Appends arguments to the buffer
  - `TOOL_CALL_END` - Finalizes the buffer (attaches to parent if specified)
  - `TOOL_CALL_RESULT` - Adds a tool message to the transcript

  ### State Management Events

  - `STATE_SNAPSHOT` - Replaces the entire state
  - `STATE_DELTA` - Applies JSON Patch operations to state
  - `MESSAGES_SNAPSHOT` - Replaces all messages
  - `ACTIVITY_SNAPSHOT` - Creates/replaces an activity message
  - `ACTIVITY_DELTA` - Applies JSON Patch to activity content

  ### Thinking Events

  - `THINKING_START` - Marks thinking as active
  - `THINKING_END` - Marks thinking as inactive
  - `THINKING_TEXT_MESSAGE_*` - Records thinking content (not rendered)

  ### Special Events

  - `RAW` - Passed through, no state changes
  - `CUSTOM` - Passed through, no state changes

  """

  import Kernel, except: [apply: 2]

  alias AgUI.Session
  alias AgUI.Events
  alias AgUI.Types

  @doc """
  Applies an event to a session, returning the updated session.

  This is a pure function - it does not have side effects and always
  produces the same output for the same inputs.

  ## Examples

      iex> session = AgUI.Session.new()
      iex> event = %AgUI.Events.RunStarted{thread_id: "t1", run_id: "r1"}
      iex> session = AgUI.Reducer.apply(session, event)
      iex> session.status
      :running

  """
  @spec apply(Session.t(), Events.t()) :: Session.t()

  # ============================================================================
  # Lifecycle Events
  # ============================================================================

  def apply(%Session{} = session, %Events.RunStarted{} = event) do
    %{
      session
      | thread_id: event.thread_id,
        run_id: event.run_id,
        status: :running,
        steps: [],
        text_buffers: %{},
        tool_buffers: %{},
        thinking: %{active: false, content: ""}
    }
  end

  def apply(%Session{} = session, %Events.RunFinished{}) do
    # Finalize any pending buffers before marking finished
    session = finalize_pending_buffers(session)
    %{session | status: :finished}
  end

  def apply(%Session{} = session, %Events.RunError{message: msg}) do
    %{session | status: {:error, msg}}
  end

  def apply(%Session{} = session, %Events.StepStarted{step_name: name}) do
    step = %{name: name, status: :started}
    %{session | steps: session.steps ++ [step]}
  end

  def apply(%Session{} = session, %Events.StepFinished{step_name: name}) do
    steps =
      Enum.map(session.steps, fn
        %{name: ^name} = step -> %{step | status: :finished}
        step -> step
      end)

    %{session | steps: steps}
  end

  # ============================================================================
  # Text Message Events
  # ============================================================================

  def apply(%Session{} = session, %Events.TextMessageStart{message_id: id, role: role}) do
    role_atom =
      case role do
        r when is_atom(r) -> r
        r when is_binary(r) -> String.to_atom(r)
        _ -> :assistant
      end

    buffer = %{content: "", role: role_atom}
    %{session | text_buffers: Map.put(session.text_buffers, id, buffer)}
  end

  def apply(%Session{} = session, %Events.TextMessageContent{message_id: id, delta: delta}) do
    case Map.get(session.text_buffers, id) do
      nil ->
        # No buffer exists - create one with default role
        buffer = %{content: delta, role: :assistant}
        %{session | text_buffers: Map.put(session.text_buffers, id, buffer)}

      %{content: content} = buffer ->
        updated_buffer = %{buffer | content: content <> delta}
        %{session | text_buffers: Map.put(session.text_buffers, id, updated_buffer)}
    end
  end

  def apply(%Session{} = session, %Events.TextMessageEnd{message_id: id}) do
    case Map.get(session.text_buffers, id) do
      nil ->
        session

      %{content: content, role: role} ->
        message = %Types.Message.Assistant{
          id: id,
          role: role,
          content: content
        }

        %{
          session
          | messages: session.messages ++ [message],
            text_buffers: Map.delete(session.text_buffers, id)
        }
    end
  end

  # TEXT_MESSAGE_CHUNK is a convenience event - normally expanded by Normalize
  # But we handle it here for direct usage
  def apply(%Session{} = session, %Events.TextMessageChunk{} = chunk) do
    # Simulate START if buffer doesn't exist
    session =
      if not Map.has_key?(session.text_buffers, chunk.message_id) do
        role = chunk.role || "assistant"
        buffer = %{content: "", role: String.to_atom(role)}
        %{session | text_buffers: Map.put(session.text_buffers, chunk.message_id, buffer)}
      else
        session
      end

    # Apply content
    if chunk.delta && chunk.delta != "" do
      buffer = session.text_buffers[chunk.message_id]
      updated_buffer = %{buffer | content: buffer.content <> chunk.delta}
      %{session | text_buffers: Map.put(session.text_buffers, chunk.message_id, updated_buffer)}
    else
      session
    end
  end

  # ============================================================================
  # Tool Call Events
  # ============================================================================

  def apply(%Session{} = session, %Events.ToolCallStart{} = event) do
    buffer = %{
      name: event.tool_call_name,
      args: "",
      parent_message_id: event.parent_message_id
    }

    %{session | tool_buffers: Map.put(session.tool_buffers, event.tool_call_id, buffer)}
  end

  def apply(%Session{} = session, %Events.ToolCallArgs{tool_call_id: id, delta: delta}) do
    case Map.get(session.tool_buffers, id) do
      nil ->
        session

      %{args: args} = buffer ->
        updated_buffer = %{buffer | args: args <> delta}
        %{session | tool_buffers: Map.put(session.tool_buffers, id, updated_buffer)}
    end
  end

  def apply(%Session{} = session, %Events.ToolCallEnd{tool_call_id: id}) do
    case Map.get(session.tool_buffers, id) do
      nil ->
        session

      buffer ->
        tool_call = %Types.ToolCall{
          id: id,
          type: :function,
          function: %{name: buffer.name, arguments: buffer.args}
        }

        session =
          if buffer.parent_message_id do
            update_message_tool_calls(session, buffer.parent_message_id, tool_call)
          else
            session
          end

        %{session | tool_buffers: Map.delete(session.tool_buffers, id)}
    end
  end

  def apply(%Session{} = session, %Events.ToolCallResult{} = event) do
    message = %Types.Message.Tool{
      id: event.message_id,
      role: :tool,
      content: event.content,
      tool_call_id: event.tool_call_id
    }

    %{session | messages: session.messages ++ [message]}
  end

  # TOOL_CALL_CHUNK is a convenience event - normally expanded by Normalize
  def apply(%Session{} = session, %Events.ToolCallChunk{} = chunk) do
    # Simulate START if buffer doesn't exist and we have a name
    session =
      if not Map.has_key?(session.tool_buffers, chunk.tool_call_id) and chunk.tool_call_name do
        buffer = %{
          name: chunk.tool_call_name,
          args: "",
          parent_message_id: chunk.parent_message_id
        }

        %{session | tool_buffers: Map.put(session.tool_buffers, chunk.tool_call_id, buffer)}
      else
        session
      end

    # Apply args
    if chunk.delta && chunk.delta != "" && Map.has_key?(session.tool_buffers, chunk.tool_call_id) do
      buffer = session.tool_buffers[chunk.tool_call_id]
      updated_buffer = %{buffer | args: buffer.args <> chunk.delta}
      %{session | tool_buffers: Map.put(session.tool_buffers, chunk.tool_call_id, updated_buffer)}
    else
      session
    end
  end

  # ============================================================================
  # State Management Events
  # ============================================================================

  def apply(%Session{} = session, %Events.StateSnapshot{snapshot: snapshot}) do
    %{session | state: snapshot}
  end

  def apply(%Session{} = session, %Events.StateDelta{delta: operations}) do
    case AgUI.JSONPatch.apply(session.state, operations) do
      {:ok, new_state} -> %{session | state: new_state}
      {:error, _} -> session
    end
  end

  def apply(%Session{} = session, %Events.MessagesSnapshot{messages: messages}) do
    decoded_messages =
      Enum.map(messages, fn m ->
        case Types.Message.from_map(m) do
          {:ok, msg} -> msg
          _ -> m
        end
      end)

    %{session | messages: decoded_messages}
  end

  def apply(%Session{} = session, %Events.ActivitySnapshot{} = event) do
    activity_message = %Types.Message.Activity{
      id: event.message_id,
      role: :activity,
      activity_type: event.activity_type,
      content: event.content
    }

    # replace defaults to true
    replace? = event.replace != false

    messages =
      if replace? do
        case Enum.find_index(session.messages, &(&1.id == event.message_id)) do
          nil -> session.messages ++ [activity_message]
          idx -> List.replace_at(session.messages, idx, activity_message)
        end
      else
        session.messages ++ [activity_message]
      end

    %{session | messages: messages}
  end

  def apply(%Session{} = session, %Events.ActivityDelta{} = event) do
    messages =
      Enum.map(session.messages, fn
        %Types.Message.Activity{id: id, content: content} = msg when id == event.message_id ->
          case AgUI.JSONPatch.apply(content, event.patch) do
            {:ok, new_content} -> %{msg | content: new_content}
            {:error, _} -> msg
          end

        msg ->
          msg
      end)

    %{session | messages: messages}
  end

  # ============================================================================
  # Thinking Events
  # ============================================================================

  def apply(%Session{} = session, %Events.ThinkingStart{}) do
    %{session | thinking: %{session.thinking | active: true}}
  end

  def apply(%Session{} = session, %Events.ThinkingEnd{}) do
    %{session | thinking: %{session.thinking | active: false}}
  end

  def apply(%Session{} = session, %Events.ThinkingTextMessageStart{}) do
    # No-op for start, just track that thinking content may follow
    session
  end

  def apply(%Session{} = session, %Events.ThinkingTextMessageContent{delta: delta}) do
    %{session | thinking: %{session.thinking | content: session.thinking.content <> delta}}
  end

  def apply(%Session{} = session, %Events.ThinkingTextMessageEnd{}) do
    # No-op for end
    session
  end

  # ============================================================================
  # Special Events
  # ============================================================================

  def apply(%Session{} = session, %Events.Raw{}) do
    # Raw events are passthrough - no state changes
    session
  end

  def apply(%Session{} = session, %Events.Custom{}) do
    # Custom events are passthrough - no state changes
    session
  end

  # ============================================================================
  # Helpers
  # ============================================================================

  # Attach a tool call to a parent message
  defp update_message_tool_calls(session, parent_id, tool_call) do
    messages =
      Enum.map(session.messages, fn
        %Types.Message.Assistant{id: ^parent_id} = msg ->
          %{msg | tool_calls: msg.tool_calls ++ [tool_call]}

        msg ->
          msg
      end)

    %{session | messages: messages}
  end

  # Finalize any pending text or tool buffers
  defp finalize_pending_buffers(session) do
    # Finalize text buffers
    session =
      Enum.reduce(session.text_buffers, session, fn {id, buffer}, session ->
        message = %Types.Message.Assistant{
          id: id,
          role: buffer.role,
          content: buffer.content
        }

        %{session | messages: session.messages ++ [message]}
      end)

    # Clear buffers
    %{session | text_buffers: %{}, tool_buffers: %{}}
  end

  @doc """
  Applies a list of events to a session in order.

  ## Examples

      events = [run_started, text_start, text_content, text_end, run_finished]
      final_session = AgUI.Reducer.apply_all(session, events)

  """
  @spec apply_all(Session.t(), [Events.t()]) :: Session.t()
  def apply_all(%Session{} = session, events) when is_list(events) do
    Enum.reduce(events, session, &apply(&2, &1))
  end
end
