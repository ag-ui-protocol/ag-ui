defmodule AgUI.Verify do
  @moduledoc """
  Protocol event sequence verification.

  This module provides a lightweight validator for AG-UI event streams.
  It checks basic sequencing rules such as:

  - RUN_STARTED must come before RUN_FINISHED or RUN_ERROR
  - Runs must be closed before starting a new run
  - TEXT_MESSAGE_* events must be properly started/ended
  - TOOL_CALL_* events must be properly started/ended
  """

  alias AgUI.Events

  @type state :: %{
          run_status: :idle | :running | :finished | :errored,
          first_event: boolean(),
          text_open: MapSet.t(),
          tool_open: MapSet.t(),
          active_message_id: String.t() | nil,
          active_tool_call_id: String.t() | nil,
          active_steps: MapSet.t(),
          thinking_active: boolean(),
          thinking_message_active: boolean()
        }

  @type error ::
          {:run_not_started, Events.t()}
          | {:run_already_started, Events.t()}
          | {:run_already_finished, Events.t()}
          | {:run_already_errored, Events.t()}
          | {:first_event_must_be_run_started, Events.t()}
          | {:run_not_finished, Events.t()}
          | {:text_not_started, Events.t()}
          | {:text_already_started, Events.t()}
          | {:text_not_ended, Events.t()}
          | {:tool_not_started, Events.t()}
          | {:tool_already_started, Events.t()}
          | {:tool_not_ended, Events.t()}
          | {:message_id_mismatch, Events.t()}
          | {:tool_call_id_mismatch, Events.t()}
          | {:step_not_started, Events.t()}
          | {:step_not_finished, Events.t()}
          | {:thinking_not_started, Events.t()}
          | {:thinking_already_started, Events.t()}
          | {:thinking_message_not_started, Events.t()}
          | {:thinking_message_already_started, Events.t()}
          | {:event_not_allowed_during_message, Events.t()}
          | {:event_not_allowed_during_tool_call, Events.t()}
          | {:event_not_allowed_during_thinking, Events.t()}

  @doc """
  Creates a new verification state.
  """
  @spec new() :: state()
  def new do
    %{
      run_status: :idle,
      first_event: false,
      text_open: MapSet.new(),
      tool_open: MapSet.new(),
      active_message_id: nil,
      active_tool_call_id: nil,
      active_steps: MapSet.new(),
      thinking_active: false,
      thinking_message_active: false
    }
  end

  @doc """
  Verifies a full event list, returning :ok or an error tuple.

  ## Examples

      events = [
        %AgUI.Events.RunStarted{thread_id: "t1", run_id: "r1"},
        %AgUI.Events.RunFinished{thread_id: "t1", run_id: "r1"}
      ]

      AgUI.Verify.verify_events(events)
  """
  @spec verify_events([Events.t()]) :: :ok | {:error, error()}
  def verify_events(events) when is_list(events) do
    Enum.reduce_while(events, {:ok, new()}, fn event, {:ok, state} ->
      case verify_event(event, state) do
        {:ok, new_state} -> {:cont, {:ok, new_state}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, final_state} -> finalize(final_state)
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Verifies an event stream, raising on invalid sequences.

  This mirrors TypeScript's `verifyEvents` operator but for Elixir streams.

  ## Examples

      {:ok, stream} = AgUI.Client.HttpAgent.stream_canonical(agent, input)
      stream |> AgUI.Verify.verify_stream() |> Enum.to_list()
  """
  @spec verify_stream(Enumerable.t()) :: Enumerable.t()
  def verify_stream(stream) do
    Stream.transform(
      stream,
      fn -> new() end,
      fn event, state ->
        case verify_event(event, state) do
          {:ok, new_state} ->
            {[event], new_state}

          {:error, reason} ->
            raise ArgumentError, "Invalid event sequence: #{inspect(reason)}"
        end
      end,
      fn state ->
        case finalize(state) do
          :ok -> {[], nil}
          {:error, reason} -> raise ArgumentError, "Invalid event sequence: #{inspect(reason)}"
        end
      end,
      fn _ -> :ok end
    )
  end

  @doc """
  Verifies a single event against the current state.
  """
  @spec verify_event(Events.t(), state()) :: {:ok, state()} | {:error, error()}
  def verify_event(event, %{run_status: :errored} = _state) do
    {:error, {:run_already_errored, event}}
  end

  def verify_event(event, %{run_status: :finished} = _state) do
    if match?(%Events.RunError{}, event) do
      {:ok, %{new() | run_status: :errored, first_event: true}}
    else
      {:error, {:run_already_finished, event}}
    end
  end

  def verify_event(%Events.RunStarted{} = event, %{first_event: true}) do
    {:error, {:run_already_started, event}}
  end

  def verify_event(%Events.RunStarted{}, %{first_event: false} = state) do
    {:ok, %{state | run_status: :running, first_event: true}}
  end

  def verify_event(%Events.RunError{}, %{first_event: false} = state) do
    {:ok, %{state | run_status: :errored, first_event: true}}
  end

  def verify_event(%Events.RunFinished{} = event, %{run_status: :idle}) do
    {:error, {:first_event_must_be_run_started, event}}
  end

  def verify_event(%Events.RunFinished{}, %{run_status: :running} = state) do
    {:ok, %{state | run_status: :finished, first_event: true}}
  end

  def verify_event(%Events.RunError{}, %{run_status: :running} = state) do
    {:ok, %{state | run_status: :errored, first_event: true}}
  end

  def verify_event(event, %{active_message_id: msg_id} = state) when not is_nil(msg_id) do
    case event do
      %Events.TextMessageContent{} -> verify_text_content(event, state)
      %Events.TextMessageEnd{} -> verify_text_end(event, state)
      %Events.Raw{} -> {:ok, state}
      _ -> {:error, {:event_not_allowed_during_message, event}}
    end
  end

  def verify_event(event, %{active_tool_call_id: tool_id} = state) when not is_nil(tool_id) do
    case event do
      %Events.ToolCallArgs{} -> verify_tool_args(event, state)
      %Events.ToolCallEnd{} -> verify_tool_end(event, state)
      %Events.Raw{} -> {:ok, state}
      _ -> {:error, {:event_not_allowed_during_tool_call, event}}
    end
  end

  def verify_event(%Events.TextMessageStart{message_id: id} = event, state) do
    if MapSet.member?(state.text_open, id) do
      {:error, {:text_already_started, event}}
    else
      {:ok,
       %{
         state
         | text_open: MapSet.put(state.text_open, id),
           active_message_id: id
       }}
    end
  end

  def verify_event(%Events.TextMessageContent{} = event, state), do: verify_text_content(event, state)

  def verify_event(%Events.TextMessageEnd{} = event, state), do: verify_text_end(event, state)

  def verify_event(%Events.ToolCallStart{tool_call_id: id} = event, state) do
    if MapSet.member?(state.tool_open, id) do
      {:error, {:tool_already_started, event}}
    else
      {:ok,
       %{
         state
         | tool_open: MapSet.put(state.tool_open, id),
           active_tool_call_id: id
       }}
    end
  end

  def verify_event(%Events.ToolCallArgs{} = event, state), do: verify_tool_args(event, state)

  def verify_event(%Events.ToolCallEnd{} = event, state), do: verify_tool_end(event, state)

  def verify_event(%Events.StepStarted{step_name: name}, state) do
    {:ok, %{state | active_steps: MapSet.put(state.active_steps, name)}}
  end

  def verify_event(%Events.StepFinished{step_name: name} = event, state) do
    if MapSet.member?(state.active_steps, name) do
      {:ok, %{state | active_steps: MapSet.delete(state.active_steps, name)}}
    else
      {:error, {:step_not_started, event}}
    end
  end

  def verify_event(%Events.ThinkingStart{} = event, %{thinking_active: true}) do
    {:error, {:thinking_already_started, event}}
  end

  def verify_event(%Events.ThinkingStart{}, state) do
    {:ok, %{state | thinking_active: true}}
  end

  def verify_event(%Events.ThinkingEnd{} = event, %{thinking_active: false}) do
    {:error, {:thinking_not_started, event}}
  end

  def verify_event(%Events.ThinkingEnd{}, state) do
    {:ok, %{state | thinking_active: false}}
  end

  def verify_event(%Events.ThinkingTextMessageStart{} = event, %{thinking_message_active: true}) do
    {:error, {:thinking_message_already_started, event}}
  end

  def verify_event(%Events.ThinkingTextMessageStart{}, state) do
    {:ok, %{state | thinking_message_active: true}}
  end

  def verify_event(%Events.ThinkingTextMessageContent{} = event, %{thinking_message_active: false}) do
    {:error, {:thinking_message_not_started, event}}
  end

  def verify_event(%Events.ThinkingTextMessageContent{}, state) do
    {:ok, state}
  end

  def verify_event(%Events.ThinkingTextMessageEnd{} = event, %{thinking_message_active: false}) do
    {:error, {:thinking_message_not_started, event}}
  end

  def verify_event(%Events.ThinkingTextMessageEnd{}, state) do
    {:ok, %{state | thinking_message_active: false}}
  end

  def verify_event(_event, state), do: {:ok, state}

  defp verify_text_content(%Events.TextMessageContent{message_id: id} = event, state) do
    cond do
      not is_nil(state.active_message_id) and state.active_message_id != id ->
        {:error, {:message_id_mismatch, event}}

      MapSet.member?(state.text_open, id) ->
        {:ok, state}

      true ->
        {:error, {:text_not_started, event}}
    end
  end

  defp verify_text_end(%Events.TextMessageEnd{message_id: id} = event, state) do
    cond do
      not is_nil(state.active_message_id) and state.active_message_id != id ->
        {:error, {:message_id_mismatch, event}}

      MapSet.member?(state.text_open, id) ->
        {:ok,
         %{
           state
           | text_open: MapSet.delete(state.text_open, id),
             active_message_id: nil
         }}

      true ->
        {:error, {:text_not_started, event}}
    end
  end

  defp verify_tool_args(%Events.ToolCallArgs{tool_call_id: id} = event, state) do
    cond do
      not is_nil(state.active_tool_call_id) and state.active_tool_call_id != id ->
        {:error, {:tool_call_id_mismatch, event}}

      MapSet.member?(state.tool_open, id) ->
        {:ok, state}

      true ->
        {:error, {:tool_not_started, event}}
    end
  end

  defp verify_tool_end(%Events.ToolCallEnd{tool_call_id: id} = event, state) do
    cond do
      not is_nil(state.active_tool_call_id) and state.active_tool_call_id != id ->
        {:error, {:tool_call_id_mismatch, event}}

      MapSet.member?(state.tool_open, id) ->
        {:ok,
         %{
           state
           | tool_open: MapSet.delete(state.tool_open, id),
             active_tool_call_id: nil
         }}

      true ->
        {:error, {:tool_not_started, event}}
    end
  end

  defp finalize(%{run_status: :running} = state) do
    {:error, {:run_not_finished, state}}
  end

  defp finalize(%{text_open: text} = state) do
    if MapSet.size(text) > 0 do
      {:error, {:text_not_ended, state}}
    else
      finalize_tools(state)
    end
  end

  defp finalize_tools(%{tool_open: tool} = state) do
    if MapSet.size(tool) > 0 do
      {:error, {:tool_not_ended, state}}
    else
      finalize_steps(state)
    end
  end

  defp finalize_steps(%{active_steps: steps} = state) do
    if MapSet.size(steps) > 0 do
      {:error, {:step_not_finished, state}}
    else
      finalize_run(state)
    end
  end

  defp finalize_run(%{run_status: :idle, first_event: false}), do: :ok
  defp finalize_run(%{run_status: :finished}), do: :ok
  defp finalize_run(%{run_status: :errored}), do: :ok
end
