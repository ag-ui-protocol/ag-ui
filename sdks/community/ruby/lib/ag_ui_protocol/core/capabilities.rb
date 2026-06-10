# typed: true
# frozen_string_literal: true

require "sorbet-runtime"
require_relative "types"

module AgUiProtocol
  module Core
    # Agent capabilities define what an agent can do. They are declared by the agent
    # implementation and communicated to the client during a run.
    #
    # All fields on `AgentCapabilities` and its sub-capability classes are optional — agents
    # only declare what they support. (Nested helper types like `SubAgentInfo` may still have
    # required identifier fields.) Omitted fields mean the capability is not declared
    # (unknown), not that it's unsupported.
    module Capabilities
      # Describes a sub-agent that can be invoked by a parent agent.
      class SubAgentInfo < AgUiProtocol::Core::Types::Model
        sig { returns(String) }
        attr_reader :name

        sig { returns(T.nilable(String)) }
        attr_reader :description

        # @param name [String] Unique name or identifier of the sub-agent.
        # @param description [String, nil] What this sub-agent specializes in. Helps clients build agent selection UIs.
        sig do
          params(
            name: String,
            description: T.nilable(String)
          ).void
        end
        def initialize(name:, description: nil)
          @name = name
          @description = description
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            name: @name,
            description: @description
          }
        end
      end

      # Basic metadata about the agent.
      #
      # Useful for discovery UIs, agent marketplaces, and debugging. Set these when you want
      # clients to display agent information or when multiple agents are available and users
      # need to pick one.
      class IdentityCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(String)) }
        attr_reader :name

        sig { returns(T.nilable(String)) }
        attr_reader :type

        sig { returns(T.nilable(String)) }
        attr_reader :description

        sig { returns(T.nilable(String)) }
        attr_reader :version

        sig { returns(T.nilable(String)) }
        attr_reader :provider

        sig { returns(T.nilable(String)) }
        attr_reader :documentation_url

        sig { returns(T.nilable(T::Hash[T.any(String, Symbol), T.untyped])) }
        attr_reader :metadata

        # @param name [String, nil] Human-readable name shown in UIs and agent selectors.
        # @param type [String, nil] The framework or platform powering this agent (e.g., "langgraph", "mastra", "crewai").
        # @param description [String, nil] What this agent does — helps users and routing logic decide when to use it.
        # @param version [String, nil] Semantic version of the agent (e.g., "1.2.0"). Useful for compatibility checks.
        # @param provider [String, nil] Organization or team that maintains this agent.
        # @param documentation_url [String, nil] URL to the agent's documentation or homepage.
        # @param metadata [Hash{String, Symbol => Object}, nil] Arbitrary key-value pairs for integration-specific identity info. String or Symbol keys are both accepted.
        sig do
          params(
            name: T.nilable(String),
            type: T.nilable(String),
            description: T.nilable(String),
            version: T.nilable(String),
            provider: T.nilable(String),
            documentation_url: T.nilable(String),
            metadata: T.nilable(T::Hash[T.any(String, Symbol), T.untyped])
          ).void
        end
        def initialize(
          name: nil, type: nil, description: nil, version: nil,
          provider: nil, documentation_url: nil, metadata: nil
        )
          @name = name
          @type = type
          @description = description
          @version = version
          @provider = provider
          @documentation_url = documentation_url
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            name: @name,
            type: @type,
            description: @description,
            version: @version,
            provider: @provider,
            documentation_url: @documentation_url,
            # `metadata` is arbitrary integration-specific identity info — preserve keys verbatim.
            metadata: @metadata.nil? ? nil : AgUiProtocol::Util::Opaque.new(@metadata)
          }
        end
      end

      # Declares which transport mechanisms the agent supports.
      #
      # Clients use this to pick the best connection strategy. Only set flags to `true` for
      # transports your agent actually handles — omit or set `false` for unsupported ones.
      class TransportCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :streaming

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :websocket

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :http_binary

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :push_notifications

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :resumable

        # @param streaming [Boolean, nil] Set `true` if the agent streams responses via SSE. Most agents enable this.
        # @param websocket [Boolean, nil] Set `true` if the agent accepts persistent WebSocket connections.
        # @param http_binary [Boolean, nil] Set `true` if the agent supports the AG-UI binary protocol (protobuf over HTTP).
        # @param push_notifications [Boolean, nil] Set `true` if the agent can send async updates via webhooks after a run finishes.
        # @param resumable [Boolean, nil] Set `true` if the agent supports resuming interrupted streams via sequence numbers.
        sig do
          params(
            streaming: T.nilable(T::Boolean),
            websocket: T.nilable(T::Boolean),
            http_binary: T.nilable(T::Boolean),
            push_notifications: T.nilable(T::Boolean),
            resumable: T.nilable(T::Boolean)
          ).void
        end
        def initialize(
          streaming: nil, websocket: nil, http_binary: nil,
          push_notifications: nil, resumable: nil
        )
          @streaming = streaming
          @websocket = websocket
          @http_binary = http_binary
          @push_notifications = push_notifications
          @resumable = resumable
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            streaming: @streaming,
            websocket: @websocket,
            http_binary: @http_binary,
            push_notifications: @push_notifications,
            resumable: @resumable
          }
        end
      end

      # Tool calling capabilities.
      #
      # Distinguishes between tools the agent itself provides (listed in `items`) and tools
      # the client passes at runtime via `RunAgentInput.tools`. Enable this when your agent
      # can call functions, search the web, execute code, etc.
      class ToolsCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :supported

        sig { returns(T.nilable(T::Array[AgUiProtocol::Core::Types::Tool])) }
        attr_reader :items

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :parallel_calls

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :client_provided

        # @param supported [Boolean, nil] Set `true` if the agent can make tool calls at all. Set `false` to explicitly signal tool calling is disabled even if items are present.
        # @param items [Array<Tool>, nil] The tools this agent provides on its own (full JSON Schema definitions). These are distinct from client-provided tools passed in RunAgentInput.tools.
        # @param parallel_calls [Boolean, nil] Set `true` if the agent can invoke multiple tools concurrently within a single step.
        # @param client_provided [Boolean, nil] Set `true` if the agent accepts and uses tools provided by the client at runtime.
        sig do
          params(
            supported: T.nilable(T::Boolean),
            items: T.nilable(T::Array[AgUiProtocol::Core::Types::Tool]),
            parallel_calls: T.nilable(T::Boolean),
            client_provided: T.nilable(T::Boolean)
          ).void
        end
        def initialize(
          supported: nil, items: nil, parallel_calls: nil, client_provided: nil
        )
          @supported = supported
          @items = items
          @parallel_calls = parallel_calls
          @client_provided = client_provided
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            supported: @supported,
            items: @items,
            parallel_calls: @parallel_calls,
            client_provided: @client_provided
          }
        end
      end

      # Output format support.
      #
      # Enable `structured_output` when your agent can return responses conforming to a
      # JSON schema, which is useful for programmatic consumption.
      class OutputCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :structured_output

        sig { returns(T.nilable(T::Array[String])) }
        attr_reader :supported_mime_types

        # @param structured_output [Boolean, nil] Set `true` if the agent can produce structured JSON output matching a provided schema.
        # @param supported_mime_types [Array<String>, nil] MIME types the agent can produce (e.g., ["text/plain", "application/json"]). Omit if the agent only produces plain text.
        sig do
          params(
            structured_output: T.nilable(T::Boolean),
            supported_mime_types: T.nilable(T::Array[String])
          ).void
        end
        def initialize(structured_output: nil, supported_mime_types: nil)
          @structured_output = structured_output
          @supported_mime_types = supported_mime_types
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            structured_output: @structured_output,
            supported_mime_types: @supported_mime_types
          }
        end
      end

      # State and memory management capabilities.
      #
      # These tell the client how the agent handles shared state and whether conversation
      # context persists across runs.
      class StateCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :snapshots

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :deltas

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :memory

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :persistent_state

        # @param snapshots [Boolean, nil] Set `true` if the agent emits STATE_SNAPSHOT events (full state replacement).
        # @param deltas [Boolean, nil] Set `true` if the agent emits STATE_DELTA events (JSON Patch incremental updates).
        # @param memory [Boolean, nil] Set `true` if the agent has long-term memory beyond the current thread (e.g., vector store, knowledge base, or cross-session recall).
        # @param persistent_state [Boolean, nil] Set `true` if state is preserved across multiple runs within the same thread. When `false`, state resets on each run.
        sig do
          params(
            snapshots: T.nilable(T::Boolean),
            deltas: T.nilable(T::Boolean),
            memory: T.nilable(T::Boolean),
            persistent_state: T.nilable(T::Boolean)
          ).void
        end
        def initialize(snapshots: nil, deltas: nil, memory: nil, persistent_state: nil)
          @snapshots = snapshots
          @deltas = deltas
          @memory = memory
          @persistent_state = persistent_state
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            snapshots: @snapshots,
            deltas: @deltas,
            memory: @memory,
            persistent_state: @persistent_state
          }
        end
      end

      # Multi-agent coordination capabilities.
      #
      # Enable these when your agent can orchestrate or hand off work to other agents.
      class MultiAgentCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :supported

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :delegation

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :handoffs

        sig { returns(T.nilable(T::Array[SubAgentInfo])) }
        attr_reader :sub_agents

        # @param supported [Boolean, nil] Set `true` if the agent participates in any form of multi-agent coordination.
        # @param delegation [Boolean, nil] Set `true` if the agent can delegate subtasks to other agents while retaining control.
        # @param handoffs [Boolean, nil] Set `true` if the agent can transfer the conversation entirely to another agent.
        # @param sub_agents [Array<SubAgentInfo>, nil] List of sub-agents this agent can invoke. Helps clients build agent selection UIs.
        sig do
          params(
            supported: T.nilable(T::Boolean),
            delegation: T.nilable(T::Boolean),
            handoffs: T.nilable(T::Boolean),
            sub_agents: T.nilable(T::Array[SubAgentInfo])
          ).void
        end
        def initialize(
          supported: nil, delegation: nil, handoffs: nil, sub_agents: nil
        )
          @supported = supported
          @delegation = delegation
          @handoffs = handoffs
          @sub_agents = sub_agents
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            supported: @supported,
            delegation: @delegation,
            handoffs: @handoffs,
            sub_agents: @sub_agents
          }
        end
      end

      # Reasoning and thinking capabilities.
      #
      # Enable these when your agent exposes its internal thought process (e.g.,
      # chain-of-thought, extended thinking).
      class ReasoningCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :supported

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :streaming

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :encrypted

        # @param supported [Boolean, nil] Set `true` if the agent produces reasoning/thinking tokens visible to the client.
        # @param streaming [Boolean, nil] Set `true` if reasoning tokens are streamed incrementally (vs. returned all at once).
        # @param encrypted [Boolean, nil] Set `true` if reasoning content is encrypted (zero-data-retention mode). Clients should expect opaque `encrypted_value` fields instead of readable content.
        sig do
          params(
            supported: T.nilable(T::Boolean),
            streaming: T.nilable(T::Boolean),
            encrypted: T.nilable(T::Boolean)
          ).void
        end
        def initialize(supported: nil, streaming: nil, encrypted: nil)
          @supported = supported
          @streaming = streaming
          @encrypted = encrypted
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            supported: @supported,
            streaming: @streaming,
            encrypted: @encrypted
          }
        end
      end

      # Modalities the agent can accept as input.
      #
      # Clients use this to show/hide file upload buttons, audio recorders, image pickers, etc.
      class MultimodalInputCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :image

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :audio

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :video

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :pdf

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :file

        # @param image [Boolean, nil] Set `true` if the agent can process image inputs (e.g., screenshots, photos).
        # @param audio [Boolean, nil] Set `true` if the agent can process audio inputs (speech, recordings).
        # @param video [Boolean, nil] Set `true` if the agent can process video inputs.
        # @param pdf [Boolean, nil] Set `true` if the agent can process PDF documents.
        # @param file [Boolean, nil] Set `true` if the agent can process arbitrary file uploads.
        sig do
          params(
            image: T.nilable(T::Boolean),
            audio: T.nilable(T::Boolean),
            video: T.nilable(T::Boolean),
            pdf: T.nilable(T::Boolean),
            file: T.nilable(T::Boolean)
          ).void
        end
        def initialize(image: nil, audio: nil, video: nil, pdf: nil, file: nil)
          @image = image
          @audio = audio
          @video = video
          @pdf = pdf
          @file = file
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            image: @image,
            audio: @audio,
            video: @video,
            pdf: @pdf,
            file: @file
          }
        end
      end

      # Modalities the agent can produce as output.
      #
      # Clients use this to anticipate rich content in the agent's response.
      class MultimodalOutputCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :image

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :audio

        # @param image [Boolean, nil] Set `true` if the agent can generate images as part of its response.
        # @param audio [Boolean, nil] Set `true` if the agent can produce audio output (text-to-speech, audio files).
        sig do
          params(
            image: T.nilable(T::Boolean),
            audio: T.nilable(T::Boolean)
          ).void
        end
        def initialize(image: nil, audio: nil)
          @image = image
          @audio = audio
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            image: @image,
            audio: @audio
          }
        end
      end

      # Multimodal input and output support.
      #
      # Organized into `input` and `output` sub-objects so clients can independently query
      # what the agent accepts versus what it produces.
      class MultimodalCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(MultimodalInputCapabilities)) }
        attr_reader :input

        sig { returns(T.nilable(MultimodalOutputCapabilities)) }
        attr_reader :output

        # @param input [MultimodalInputCapabilities, nil] Modalities the agent can accept as input (images, audio, video, PDFs, files).
        # @param output [MultimodalOutputCapabilities, nil] Modalities the agent can produce as output (images, audio).
        sig do
          params(
            input: T.nilable(MultimodalInputCapabilities),
            output: T.nilable(MultimodalOutputCapabilities)
          ).void
        end
        def initialize(input: nil, output: nil)
          @input = input
          @output = output
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            input: @input,
            output: @output
          }
        end
      end

      # Execution control and limits.
      #
      # Declare these so clients can set expectations about how long or how many steps an
      # agent run might take.
      class ExecutionCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :code_execution

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :sandboxed

        sig { returns(T.nilable(Integer)) }
        attr_reader :max_iterations

        sig { returns(T.nilable(Integer)) }
        attr_reader :max_execution_time

        # @param code_execution [Boolean, nil] Set `true` if the agent can execute code (e.g., Python, JavaScript) during a run.
        # @param sandboxed [Boolean, nil] Set `true` if code execution happens in a sandboxed/isolated environment. Only meaningful when `code_execution` is `true`.
        # @param max_iterations [Integer, nil] Maximum number of tool-call/reasoning iterations the agent will perform per run. Helps clients display progress or set timeout expectations.
        # @param max_execution_time [Integer, nil] Maximum wall-clock time (in milliseconds) the agent will run before timing out.
        sig do
          params(
            code_execution: T.nilable(T::Boolean),
            sandboxed: T.nilable(T::Boolean),
            max_iterations: T.nilable(Integer),
            max_execution_time: T.nilable(Integer)
          ).void
        end
        def initialize(
          code_execution: nil, sandboxed: nil,
          max_iterations: nil, max_execution_time: nil
        )
          @code_execution = code_execution
          @sandboxed = sandboxed
          @max_iterations = max_iterations
          @max_execution_time = max_execution_time
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            code_execution: @code_execution,
            sandboxed: @sandboxed,
            max_iterations: @max_iterations,
            max_execution_time: @max_execution_time
          }
        end
      end

      # Human-in-the-loop interaction support.
      #
      # Enable these when your agent can pause execution to request human input, approval,
      # or feedback before continuing.
      class HumanInTheLoopCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :supported

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :approvals

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :interventions

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :feedback

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :interrupts

        sig { returns(T.nilable(T::Boolean)) }
        attr_reader :approve_with_edits

        # @param supported [Boolean, nil] Set `true` if the agent supports any form of human-in-the-loop interaction.
        # @param approvals [Boolean, nil] Set `true` if the agent can pause and request explicit approval before performing sensitive actions (e.g., sending emails, deleting data).
        # @param interventions [Boolean, nil] Set `true` if the agent allows humans to intervene and modify its plan mid-execution.
        # @param feedback [Boolean, nil] Set `true` if the agent can incorporate user feedback (thumbs up/down, corrections) to improve its behavior within the current session.
        # @param interrupts [Boolean, nil] Set `true` if the agent participates in the AG-UI interrupt protocol (emits RUN_FINISHED with interrupt outcome, accepts resume[]).
        # @param approve_with_edits [Boolean, nil] Set `true` if tool-call interrupts accept editedArgs in the resume payload. Only meaningful when interrupts is true.
        sig do
          params(
            supported: T.nilable(T::Boolean),
            approvals: T.nilable(T::Boolean),
            interventions: T.nilable(T::Boolean),
            feedback: T.nilable(T::Boolean),
            interrupts: T.nilable(T::Boolean),
            approve_with_edits: T.nilable(T::Boolean)
          ).void
        end
        def initialize(
          supported: nil, approvals: nil, interventions: nil,
          feedback: nil, interrupts: nil, approve_with_edits: nil
        )
          @supported = supported
          @approvals = approvals
          @interventions = interventions
          @feedback = feedback
          @interrupts = interrupts
          @approve_with_edits = approve_with_edits
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            supported: @supported,
            approvals: @approvals,
            interventions: @interventions,
            feedback: @feedback,
            interrupts: @interrupts,
            approve_with_edits: @approve_with_edits
          }
        end
      end

      # A categorized snapshot of an agent's current capabilities.
      #
      # All fields are optional — agents only declare what they support. Omitted fields mean
      # the capability is not declared (unknown), not that it's unsupported.
      #
      # The `custom` field is an escape hatch for integration-specific capabilities that
      # don't fit into the standard categories.
      class AgentCapabilities < AgUiProtocol::Core::Types::Model
        sig { returns(T.nilable(IdentityCapabilities)) }
        attr_reader :identity

        sig { returns(T.nilable(TransportCapabilities)) }
        attr_reader :transport

        sig { returns(T.nilable(ToolsCapabilities)) }
        attr_reader :tools

        sig { returns(T.nilable(OutputCapabilities)) }
        attr_reader :output

        sig { returns(T.nilable(StateCapabilities)) }
        attr_reader :state

        sig { returns(T.nilable(MultiAgentCapabilities)) }
        attr_reader :multi_agent

        sig { returns(T.nilable(ReasoningCapabilities)) }
        attr_reader :reasoning

        sig { returns(T.nilable(MultimodalCapabilities)) }
        attr_reader :multimodal

        sig { returns(T.nilable(ExecutionCapabilities)) }
        attr_reader :execution

        sig { returns(T.nilable(HumanInTheLoopCapabilities)) }
        attr_reader :human_in_the_loop

        sig { returns(T.nilable(T::Hash[T.any(String, Symbol), T.untyped])) }
        attr_reader :custom

        # @param identity [IdentityCapabilities, nil] Agent identity and metadata.
        # @param transport [TransportCapabilities, nil] Supported transport mechanisms (SSE, WebSocket, binary, etc.).
        # @param tools [ToolsCapabilities, nil] Tools the agent provides and tool calling configuration.
        # @param output [OutputCapabilities, nil] Output format support (structured output, MIME types).
        # @param state [StateCapabilities, nil] State and memory management (snapshots, deltas, persistence).
        # @param multi_agent [MultiAgentCapabilities, nil] Multi-agent coordination (delegation, handoffs, sub-agents).
        # @param reasoning [ReasoningCapabilities, nil] Reasoning and thinking support (chain-of-thought, encrypted thinking).
        # @param multimodal [MultimodalCapabilities, nil] Multimodal input/output support (images, audio, video, files).
        # @param execution [ExecutionCapabilities, nil] Execution control and limits (code execution, timeouts, iteration caps).
        # @param human_in_the_loop [HumanInTheLoopCapabilities, nil] Human-in-the-loop support (approvals, interventions, feedback).
        # @param custom [Hash{String, Symbol => Object}, nil] Integration-specific capabilities not covered by the standard categories. String or Symbol keys are both accepted.
        sig do
          params(
            identity: T.nilable(IdentityCapabilities),
            transport: T.nilable(TransportCapabilities),
            tools: T.nilable(ToolsCapabilities),
            output: T.nilable(OutputCapabilities),
            state: T.nilable(StateCapabilities),
            multi_agent: T.nilable(MultiAgentCapabilities),
            reasoning: T.nilable(ReasoningCapabilities),
            multimodal: T.nilable(MultimodalCapabilities),
            execution: T.nilable(ExecutionCapabilities),
            human_in_the_loop: T.nilable(HumanInTheLoopCapabilities),
            custom: T.nilable(T::Hash[T.any(String, Symbol), T.untyped])
          ).void
        end
        def initialize(
          identity: nil, transport: nil, tools: nil, output: nil,
          state: nil, multi_agent: nil, reasoning: nil, multimodal: nil,
          execution: nil, human_in_the_loop: nil, custom: nil
        )
          @identity = identity
          @transport = transport
          @tools = tools
          @output = output
          @state = state
          @multi_agent = multi_agent
          @reasoning = reasoning
          @multimodal = multimodal
          @execution = execution
          @human_in_the_loop = human_in_the_loop
          @custom = custom
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            identity: @identity,
            transport: @transport,
            tools: @tools,
            output: @output,
            state: @state,
            multi_agent: @multi_agent,
            reasoning: @reasoning,
            multimodal: @multimodal,
            execution: @execution,
            human_in_the_loop: @human_in_the_loop,
            # `custom` is the explicit escape hatch for integration-specific
            # capabilities — preserve keys verbatim.
            custom: @custom.nil? ? nil : AgUiProtocol::Util::Opaque.new(@custom)
          }
        end
      end
    end
  end
end
