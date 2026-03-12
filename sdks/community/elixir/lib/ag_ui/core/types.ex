defmodule AgUi.Core.Types do
  @moduledoc """
  Core type definitions for the AG-UI protocol.

  These types model messages, tool calls, and agent inputs following
  the AG-UI specification. All structs serialize to camelCase JSON
  via `AgUi.Encoder`.
  """

  # -- Function Call ----------------------------------------------------------

  defmodule FunctionCall do
    @moduledoc "Name and arguments of a function call."
    @enforce_keys [:name, :arguments]
    defstruct [:name, :arguments]

    @type t :: %__MODULE__{
            name: String.t(),
            arguments: String.t()
          }
  end

  # -- Tool Call --------------------------------------------------------------

  defmodule ToolCall do
    @moduledoc "A tool call, modelled after OpenAI tool calls."
    @enforce_keys [:id, :function]
    defstruct [:id, :function, type: "function", encrypted_value: nil]

    @type t :: %__MODULE__{
            id: String.t(),
            type: String.t(),
            function: FunctionCall.t(),
            encrypted_value: String.t() | nil
          }
  end

  # -- Messages ---------------------------------------------------------------

  defmodule BaseMessage do
    @moduledoc "Base message fields shared by all message types."
    @enforce_keys [:id, :role]
    defstruct [:id, :role, :content, :name, :encrypted_value]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t() | nil,
            name: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule DeveloperMessage do
    @moduledoc "A developer message."
    @enforce_keys [:id, :content]
    defstruct [:id, :content, role: "developer", name: nil, encrypted_value: nil]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t(),
            name: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule SystemMessage do
    @moduledoc "A system message."
    @enforce_keys [:id, :content]
    defstruct [:id, :content, role: "system", name: nil, encrypted_value: nil]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t(),
            name: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule AssistantMessage do
    @moduledoc "An assistant message."
    @enforce_keys [:id]
    defstruct [:id, :content, :tool_calls, role: "assistant", name: nil, encrypted_value: nil]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t() | nil,
            tool_calls: [ToolCall.t()] | nil,
            name: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule TextInputContent do
    @moduledoc "A text fragment in a multimodal user message."
    @enforce_keys [:text]
    defstruct [:text, type: "text"]

    @type t :: %__MODULE__{type: String.t(), text: String.t()}
  end

  defmodule BinaryInputContent do
    @moduledoc "A binary payload reference in a multimodal user message."
    @enforce_keys [:mime_type]
    defstruct [:mime_type, :id, :url, :data, :filename, type: "binary"]

    @type t :: %__MODULE__{
            type: String.t(),
            mime_type: String.t(),
            id: String.t() | nil,
            url: String.t() | nil,
            data: String.t() | nil,
            filename: String.t() | nil
          }
  end

  defmodule UserMessage do
    @moduledoc "A user message supporting text or multimodal content."
    @enforce_keys [:id, :content]
    defstruct [:id, :content, role: "user", name: nil, encrypted_value: nil]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t() | [TextInputContent.t() | BinaryInputContent.t()],
            name: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule ToolMessage do
    @moduledoc "A tool result message."
    @enforce_keys [:id, :content, :tool_call_id]
    defstruct [:id, :content, :tool_call_id, :error, :encrypted_value, role: "tool"]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t(),
            tool_call_id: String.t(),
            error: String.t() | nil,
            encrypted_value: String.t() | nil
          }
  end

  defmodule ActivityMessage do
    @moduledoc "An activity progress message emitted between chat messages."
    @enforce_keys [:id, :activity_type, :content]
    defstruct [:id, :activity_type, :content, role: "activity"]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            activity_type: String.t(),
            content: map()
          }
  end

  defmodule ReasoningMessage do
    @moduledoc "A reasoning message containing the agent's internal reasoning process."
    @enforce_keys [:id, :content]
    defstruct [:id, :content, :encrypted_value, role: "reasoning"]

    @type t :: %__MODULE__{
            id: String.t(),
            role: String.t(),
            content: String.t(),
            encrypted_value: String.t() | nil
          }
  end

  # -- Union type for messages ------------------------------------------------

  @type message ::
          DeveloperMessage.t()
          | SystemMessage.t()
          | AssistantMessage.t()
          | UserMessage.t()
          | ToolMessage.t()
          | ActivityMessage.t()
          | ReasoningMessage.t()

  @type role :: :developer | :system | :assistant | :user | :tool | :activity | :reasoning

  # -- Agent Input ------------------------------------------------------------

  defmodule Context do
    @moduledoc "Additional context for the agent."
    @enforce_keys [:description, :value]
    defstruct [:description, :value]

    @type t :: %__MODULE__{description: String.t(), value: String.t()}
  end

  defmodule Tool do
    @moduledoc "A tool definition."
    @enforce_keys [:name, :description, :parameters]
    defstruct [:name, :description, :parameters]

    @type t :: %__MODULE__{
            name: String.t(),
            description: String.t(),
            parameters: map()
          }
  end

  defmodule RunAgentInput do
    @moduledoc "Input for running an agent."
    @enforce_keys [:thread_id, :run_id, :state, :messages, :tools, :context, :forwarded_props]
    defstruct [
      :thread_id,
      :run_id,
      :parent_run_id,
      :state,
      :messages,
      :tools,
      :context,
      :forwarded_props
    ]

    @type t :: %__MODULE__{
            thread_id: String.t(),
            run_id: String.t(),
            parent_run_id: String.t() | nil,
            state: any(),
            messages: [AgUi.Core.Types.message()],
            tools: [Tool.t()],
            context: [Context.t()],
            forwarded_props: any()
          }
  end

  @type state :: any()
end
