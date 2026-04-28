defmodule AgUi.Core.Events do
  @moduledoc """
  All AG-UI protocol event types.

  Events are the fundamental units of communication between agents and
  frontends. Each event struct includes a `:type` field set to the
  corresponding `AgUi.Core.Events.EventType` value.

  ## Event Categories

  - **Lifecycle**: `RunStarted`, `RunFinished`, `RunError`, `StepStarted`, `StepFinished`
  - **Text Message**: `TextMessageStart`, `TextMessageContent`, `TextMessageEnd`, `TextMessageChunk`
  - **Thinking Text**: `ThinkingTextMessageStart`, `ThinkingTextMessageContent`, `ThinkingTextMessageEnd`
  - **Tool Call**: `ToolCallStart`, `ToolCallArgs`, `ToolCallEnd`, `ToolCallChunk`, `ToolCallResult`
  - **Thinking**: `ThinkingStart`, `ThinkingEnd`
  - **State Management**: `StateSnapshot`, `StateDelta`, `MessagesSnapshot`
  - **Activity**: `ActivitySnapshot`, `ActivityDelta`
  - **Reasoning**: `ReasoningStart`, `ReasoningMessageStart`, `ReasoningMessageContent`,
    `ReasoningMessageEnd`, `ReasoningMessageChunk`, `ReasoningEnd`, `ReasoningEncryptedValue`
  - **Special**: `Raw`, `Custom`
  """

  alias AgUi.Core.Types

  # -- Event Type Enum --------------------------------------------------------

  defmodule EventType do
    @moduledoc "All AG-UI event type constants."

    @type t :: String.t()

    def text_message_start, do: "TEXT_MESSAGE_START"
    def text_message_content, do: "TEXT_MESSAGE_CONTENT"
    def text_message_end, do: "TEXT_MESSAGE_END"
    def text_message_chunk, do: "TEXT_MESSAGE_CHUNK"
    def thinking_text_message_start, do: "THINKING_TEXT_MESSAGE_START"
    def thinking_text_message_content, do: "THINKING_TEXT_MESSAGE_CONTENT"
    def thinking_text_message_end, do: "THINKING_TEXT_MESSAGE_END"
    def tool_call_start, do: "TOOL_CALL_START"
    def tool_call_args, do: "TOOL_CALL_ARGS"
    def tool_call_end, do: "TOOL_CALL_END"
    def tool_call_chunk, do: "TOOL_CALL_CHUNK"
    def tool_call_result, do: "TOOL_CALL_RESULT"
    def thinking_start, do: "THINKING_START"
    def thinking_end, do: "THINKING_END"
    def state_snapshot, do: "STATE_SNAPSHOT"
    def state_delta, do: "STATE_DELTA"
    def messages_snapshot, do: "MESSAGES_SNAPSHOT"
    def activity_snapshot, do: "ACTIVITY_SNAPSHOT"
    def activity_delta, do: "ACTIVITY_DELTA"
    def raw, do: "RAW"
    def custom, do: "CUSTOM"
    def run_started, do: "RUN_STARTED"
    def run_finished, do: "RUN_FINISHED"
    def run_error, do: "RUN_ERROR"
    def step_started, do: "STEP_STARTED"
    def step_finished, do: "STEP_FINISHED"
    def reasoning_start, do: "REASONING_START"
    def reasoning_message_start, do: "REASONING_MESSAGE_START"
    def reasoning_message_content, do: "REASONING_MESSAGE_CONTENT"
    def reasoning_message_end, do: "REASONING_MESSAGE_END"
    def reasoning_message_chunk, do: "REASONING_MESSAGE_CHUNK"
    def reasoning_end, do: "REASONING_END"
    def reasoning_encrypted_value, do: "REASONING_ENCRYPTED_VALUE"

    @all_types [
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_CHUNK",
      "THINKING_TEXT_MESSAGE_START",
      "THINKING_TEXT_MESSAGE_CONTENT",
      "THINKING_TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_CHUNK",
      "TOOL_CALL_RESULT",
      "THINKING_START",
      "THINKING_END",
      "STATE_SNAPSHOT",
      "STATE_DELTA",
      "MESSAGES_SNAPSHOT",
      "ACTIVITY_SNAPSHOT",
      "ACTIVITY_DELTA",
      "RAW",
      "CUSTOM",
      "RUN_STARTED",
      "RUN_FINISHED",
      "RUN_ERROR",
      "STEP_STARTED",
      "STEP_FINISHED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_MESSAGE_CHUNK",
      "REASONING_END",
      "REASONING_ENCRYPTED_VALUE"
    ]

    @doc "Returns all valid event type strings."
    @spec all() :: [String.t()]
    def all, do: @all_types

    @doc "Returns true if the given string is a valid event type."
    @spec valid?(String.t()) :: boolean()
    def valid?(type), do: type in @all_types
  end

  # -- Base Event -------------------------------------------------------------

  @type text_message_role :: :developer | :system | :assistant | :user

  @type base_fields :: %{
          type: String.t(),
          timestamp: integer() | nil,
          raw_event: any() | nil
        }

  # -- Lifecycle Events -------------------------------------------------------

  defmodule RunStarted do
    @moduledoc "Signals the start of an agent run."
    @enforce_keys [:thread_id, :run_id]
    defstruct [
      :thread_id,
      :run_id,
      :parent_run_id,
      :input,
      type: "RUN_STARTED",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            thread_id: String.t(),
            run_id: String.t(),
            parent_run_id: String.t() | nil,
            input: Types.RunAgentInput.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule RunFinished do
    @moduledoc "Signals the successful completion of an agent run."
    @enforce_keys [:thread_id, :run_id]
    defstruct [
      :thread_id,
      :run_id,
      :result,
      type: "RUN_FINISHED",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            thread_id: String.t(),
            run_id: String.t(),
            result: any() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule RunError do
    @moduledoc "Signals an error during an agent run."
    @enforce_keys [:message]
    defstruct [
      :message,
      :code,
      type: "RUN_ERROR",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message: String.t(),
            code: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule StepStarted do
    @moduledoc "Signals the start of a step within an agent run."
    @enforce_keys [:step_name]
    defstruct [:step_name, type: "STEP_STARTED", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            step_name: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule StepFinished do
    @moduledoc "Signals the completion of a step within an agent run."
    @enforce_keys [:step_name]
    defstruct [:step_name, type: "STEP_FINISHED", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            step_name: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Text Message Events ----------------------------------------------------

  defmodule TextMessageStart do
    @moduledoc "Signals the start of a text message."
    @enforce_keys [:message_id]
    defstruct [
      :message_id,
      :name,
      role: "assistant",
      type: "TEXT_MESSAGE_START",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            role: String.t(),
            name: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule TextMessageContent do
    @moduledoc "Delivers a piece of text message content."
    @enforce_keys [:message_id, :delta]
    defstruct [:message_id, :delta, type: "TEXT_MESSAGE_CONTENT", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            delta: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule TextMessageEnd do
    @moduledoc "Signals the end of a text message."
    @enforce_keys [:message_id]
    defstruct [:message_id, type: "TEXT_MESSAGE_END", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule TextMessageChunk do
    @moduledoc "Convenience event that auto-expands to Start/Content/End."
    defstruct [
      :message_id,
      :role,
      :delta,
      :name,
      type: "TEXT_MESSAGE_CHUNK",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t() | nil,
            role: String.t() | nil,
            delta: String.t() | nil,
            name: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Thinking Text Message Events -------------------------------------------

  defmodule ThinkingTextMessageStart do
    @moduledoc "Signals the start of a thinking text message."
    defstruct type: "THINKING_TEXT_MESSAGE_START", timestamp: nil, raw_event: nil
  end

  defmodule ThinkingTextMessageContent do
    @moduledoc "Delivers a piece of thinking text message content."
    @enforce_keys [:delta]
    defstruct [:delta, type: "THINKING_TEXT_MESSAGE_CONTENT", timestamp: nil, raw_event: nil]
  end

  defmodule ThinkingTextMessageEnd do
    @moduledoc "Signals the end of a thinking text message."
    defstruct type: "THINKING_TEXT_MESSAGE_END", timestamp: nil, raw_event: nil
  end

  # -- Tool Call Events -------------------------------------------------------

  defmodule ToolCallStart do
    @moduledoc "Signals the start of a tool call."
    @enforce_keys [:tool_call_id, :tool_call_name]
    defstruct [
      :tool_call_id,
      :tool_call_name,
      :parent_message_id,
      type: "TOOL_CALL_START",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            tool_call_id: String.t(),
            tool_call_name: String.t(),
            parent_message_id: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule ToolCallArgs do
    @moduledoc "Delivers tool call arguments."
    @enforce_keys [:tool_call_id, :delta]
    defstruct [:tool_call_id, :delta, type: "TOOL_CALL_ARGS", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            tool_call_id: String.t(),
            delta: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule ToolCallEnd do
    @moduledoc "Signals the end of a tool call."
    @enforce_keys [:tool_call_id]
    defstruct [:tool_call_id, type: "TOOL_CALL_END", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            tool_call_id: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule ToolCallChunk do
    @moduledoc "Convenience event for tool calls without explicit Start/End."
    defstruct [
      :tool_call_id,
      :tool_call_name,
      :parent_message_id,
      :delta,
      type: "TOOL_CALL_CHUNK",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            tool_call_id: String.t() | nil,
            tool_call_name: String.t() | nil,
            parent_message_id: String.t() | nil,
            delta: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule ToolCallResult do
    @moduledoc "Delivers the result of a tool call execution."
    @enforce_keys [:message_id, :tool_call_id, :content]
    defstruct [
      :message_id,
      :tool_call_id,
      :content,
      :role,
      type: "TOOL_CALL_RESULT",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            tool_call_id: String.t(),
            content: String.t(),
            role: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Thinking Events --------------------------------------------------------

  defmodule ThinkingStart do
    @moduledoc "Signals the start of a thinking step."
    defstruct [:title, type: "THINKING_START", timestamp: nil, raw_event: nil]
  end

  defmodule ThinkingEnd do
    @moduledoc "Signals the end of a thinking step."
    defstruct type: "THINKING_END", timestamp: nil, raw_event: nil
  end

  # -- State Management Events ------------------------------------------------

  defmodule StateSnapshot do
    @moduledoc "Delivers a complete snapshot of agent state."
    @enforce_keys [:snapshot]
    defstruct [:snapshot, type: "STATE_SNAPSHOT", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            snapshot: any(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule StateDelta do
    @moduledoc "Delivers incremental state updates using JSON Patch (RFC 6902)."
    @enforce_keys [:delta]
    defstruct [:delta, type: "STATE_DELTA", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            delta: [map()],
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule MessagesSnapshot do
    @moduledoc "Delivers a complete history of conversation messages."
    @enforce_keys [:messages]
    defstruct [:messages, type: "MESSAGES_SNAPSHOT", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            messages: [Types.message()],
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Activity Events --------------------------------------------------------

  defmodule ActivitySnapshot do
    @moduledoc "Delivers a complete snapshot of an activity message."
    @enforce_keys [:message_id, :activity_type, :content]
    defstruct [
      :message_id,
      :activity_type,
      :content,
      replace: true,
      type: "ACTIVITY_SNAPSHOT",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            activity_type: String.t(),
            content: any(),
            replace: boolean(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule ActivityDelta do
    @moduledoc "Applies JSON Patch updates to an activity message."
    @enforce_keys [:message_id, :activity_type, :patch]
    defstruct [
      :message_id,
      :activity_type,
      :patch,
      type: "ACTIVITY_DELTA",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            message_id: String.t(),
            activity_type: String.t(),
            patch: [map()],
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Reasoning Events -------------------------------------------------------

  defmodule ReasoningStart do
    @moduledoc "Signals the start of a reasoning phase."
    @enforce_keys [:message_id]
    defstruct [:message_id, type: "REASONING_START", timestamp: nil, raw_event: nil]
  end

  defmodule ReasoningMessageStart do
    @moduledoc "Signals the start of a reasoning message."
    @enforce_keys [:message_id]
    defstruct [
      :message_id,
      role: "reasoning",
      type: "REASONING_MESSAGE_START",
      timestamp: nil,
      raw_event: nil
    ]
  end

  defmodule ReasoningMessageContent do
    @moduledoc "Delivers a piece of reasoning message content."
    @enforce_keys [:message_id, :delta]
    defstruct [
      :message_id,
      :delta,
      type: "REASONING_MESSAGE_CONTENT",
      timestamp: nil,
      raw_event: nil
    ]
  end

  defmodule ReasoningMessageEnd do
    @moduledoc "Signals the end of a reasoning message."
    @enforce_keys [:message_id]
    defstruct [:message_id, type: "REASONING_MESSAGE_END", timestamp: nil, raw_event: nil]
  end

  defmodule ReasoningMessageChunk do
    @moduledoc "Convenience event for reasoning messages."
    defstruct [
      :message_id,
      :delta,
      type: "REASONING_MESSAGE_CHUNK",
      timestamp: nil,
      raw_event: nil
    ]
  end

  defmodule ReasoningEnd do
    @moduledoc "Signals the end of a reasoning phase."
    @enforce_keys [:message_id]
    defstruct [:message_id, type: "REASONING_END", timestamp: nil, raw_event: nil]
  end

  defmodule ReasoningEncryptedValue do
    @moduledoc "Attaches encrypted chain-of-thought to a message or tool call."
    @enforce_keys [:subtype, :entity_id, :encrypted_value]
    defstruct [
      :subtype,
      :entity_id,
      :encrypted_value,
      type: "REASONING_ENCRYPTED_VALUE",
      timestamp: nil,
      raw_event: nil
    ]

    @type t :: %__MODULE__{
            type: String.t(),
            subtype: String.t(),
            entity_id: String.t(),
            encrypted_value: String.t(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Special Events ---------------------------------------------------------

  defmodule Raw do
    @moduledoc "Container for events from external systems."
    @enforce_keys [:event]
    defstruct [:event, :source, type: "RAW", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            event: any(),
            source: String.t() | nil,
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  defmodule Custom do
    @moduledoc "Extension mechanism for application-specific events."
    @enforce_keys [:name, :value]
    defstruct [:name, :value, type: "CUSTOM", timestamp: nil, raw_event: nil]

    @type t :: %__MODULE__{
            type: String.t(),
            name: String.t(),
            value: any(),
            timestamp: integer() | nil,
            raw_event: any() | nil
          }
  end

  # -- Union type for all events ----------------------------------------------

  @type event ::
          RunStarted.t()
          | RunFinished.t()
          | RunError.t()
          | StepStarted.t()
          | StepFinished.t()
          | TextMessageStart.t()
          | TextMessageContent.t()
          | TextMessageEnd.t()
          | TextMessageChunk.t()
          | struct()

  @doc "Returns the event type string for a given event struct."
  @spec type_of(struct()) :: String.t()
  def type_of(%{type: type}), do: type
end
