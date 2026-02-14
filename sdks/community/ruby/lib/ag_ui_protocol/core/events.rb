# typed: true
# frozen_string_literal: true

require "sorbet-runtime"
require_relative "types"

module AgUiProtocol
  module Core
    # The Agent User Interaction Protocol Ruby SDK uses a streaming event-based
    # architecture. Events are the fundamental units of communication between agents
    # and the frontend. This section documents the event types and their properties.
    #
    # ## Lifecycle Events
    #
    # These events represent the lifecycle of an agent run.
    #
    # ## Text Message Events
    #
    # These events represent the lifecycle of text messages in a conversation.
    #
    # ## Tool Call Events
    #
    # These events represent the lifecycle of tool calls made by agents.
    #
    # ## State Management Events
    #
    # These events are used to manage agent state.
    #
    module Events
      # Valid values for the role attribute of a text message.
      TEXT_MESSAGE_ROLE_VALUES = ["developer", "system", "assistant", "user"].freeze

      # The `EventType` module defines all possible event types in the system
      module EventType
        TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
        TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
        TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
        TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
        THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START"
        THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
        THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END"
        TOOL_CALL_START = "TOOL_CALL_START"
        TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
        TOOL_CALL_END = "TOOL_CALL_END"
        TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
        TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
        THINKING_START = "THINKING_START"
        THINKING_END = "THINKING_END"
        STATE_SNAPSHOT = "STATE_SNAPSHOT"
        STATE_DELTA = "STATE_DELTA"
        MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
        ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
        ACTIVITY_DELTA = "ACTIVITY_DELTA"
        RAW = "RAW"
        CUSTOM = "CUSTOM"
        RUN_STARTED = "RUN_STARTED"
        RUN_FINISHED = "RUN_FINISHED"
        RUN_ERROR = "RUN_ERROR"
        STEP_STARTED = "STEP_STARTED"
        STEP_FINISHED = "STEP_FINISHED"
      end

      # All events inherit from the `BaseEvent` class, which provides common properties
      # shared across all event types.
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::BaseEvent.new(
      #   type: AgUiProtocol::Core::Events::EventType::RAW,
      #   timestamp: nil,
      #   raw_event: nil
      # )
      #
      # ```
      class BaseEvent < AgUiProtocol::Core::Types::Model
        extend T::Sig

        sig { returns(String) }
        attr_reader :type

        sig { returns(T.nilable(Time)) }
        attr_reader :timestamp

        sig { returns(T.untyped) }
        attr_reader :raw_event

        # @param type [String] The type of event
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(type: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(type:, timestamp: nil, raw_event: nil)
          @type = type
          @timestamp = timestamp
          @raw_event = raw_event
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            timestamp: @timestamp,
            raw_event: @raw_event
          }
        end
      end

      # Signals the start of a text message.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::TextMessageStartEvent.new(
      #   message_id: "m1",
      # )
      #
      # ```
      # @category Text Message Events
      class TextMessageStartEvent < BaseEvent

        sig { returns(String) }
        attr_reader :message_id

        sig { returns(String) }
        attr_reader :role

        # @param message_id [String] Unique identifier for the message
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(message_id: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(message_id:, timestamp: nil, raw_event: nil)
          super(type: EventType::TEXT_MESSAGE_START, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @role = 'assistant'
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(message_id: @message_id, role: @role)
        end
      end

      # Represents a chunk of content in a streaming text message.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(
      #   message_id: "m1",
      #   delta: "Hello, world!"
      # )
      #
      # ```
      # @category Text Message Events
      class TextMessageContentEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message_id

        sig { returns(String) }
        attr_reader :delta

        # @param message_id [String] Matches the ID from TextMessageStartEvent
        # @param delta [String] Text content chunk (non-empty)
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(message_id: String, delta: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(message_id:, delta:, timestamp: nil, raw_event: nil)
          raise ArgumentError, "delta must be non-empty" if delta.nil? || delta.empty?

          super(type: EventType::TEXT_MESSAGE_CONTENT, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(message_id: @message_id, delta: @delta)
        end
      end

      # Signals the end of a text message.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::TextMessageEndEvent.new(message_id: "m1")
      #
      # ```
      # @category Text Message Events
      class TextMessageEndEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message_id

        # @param message_id [String] Matches the ID from TextMessageStartEvent
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(message_id: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(message_id:, timestamp: nil, raw_event: nil)
          super(type: EventType::TEXT_MESSAGE_END, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(message_id: @message_id)
        end
      end

      # Convenience event for complete text messages without manually emitting `TextMessageStart`/`TextMessageEnd`.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::TextMessageChunkEvent.new(
      #   message_id: "m1",
      #   delta: "Hello"
      # )
      #
      # ```
      #
      # Behavior:
      # - Convenience: Some consumers (e.g., the JS/TS client) expand chunk events into
      #   the standard start/content/end sequence automatically, allowing producers to
      #   omit explicit start/end events when using chunks.
      # - First chunk requirements: The first chunk for a given message must include
      #   `message_id`.
      # - Streaming: Subsequent chunks with the same `message_id` correspond to content
      #   pieces; completion triggers an implied end in clients that perform expansion.
      # @category Text Message Events
      class TextMessageChunkEvent < BaseEvent
        sig { returns(T.nilable(String)) }
        attr_reader :message_id

        sig { returns(T.nilable(String)) }
        attr_reader :role

        sig { returns(T.nilable(String)) }
        attr_reader :delta

        # @param message_id [String] required on first chunk for a message
        # @param role [String] must be one of TEXT_MESSAGE_ROLE_VALUES
        # @param delta [String] Text content chunk
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig do 
          params(
            message_id: T.nilable(String),
            role: T.nilable(String),
            delta: T.nilable(String),
            timestamp: T.nilable(Time),
            raw_event: T.untyped,
          ).void 
        end
        def initialize(message_id: nil, role: nil, delta: nil, timestamp: nil, raw_event: nil)
          raise ArgumentError, "role must be one of #{TEXT_MESSAGE_ROLE_VALUES.join(", ")}, got #{role}" if !role.nil? && !TEXT_MESSAGE_ROLE_VALUES.include?(role)
          
          super(type: EventType::TEXT_MESSAGE_CHUNK, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @role = role
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(message_id: @message_id, role: @role, delta: @delta)
        end
      end

      # Event indicating the start of a thinking text message.
      class ThinkingTextMessageStartEvent < BaseEvent
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(timestamp: nil, raw_event: nil)
          super(type: EventType::THINKING_TEXT_MESSAGE_START, timestamp: timestamp, raw_event: raw_event)
        end
      end

      # Event indicating a piece of a thinking text message.
      class ThinkingTextMessageContentEvent < BaseEvent
        sig { returns(String) }
        attr_reader :delta

        # @param delta [String] Text content
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(delta: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(delta:, timestamp: nil, raw_event: nil)
          raise ArgumentError, "delta must be non-empty" if delta.nil? || delta.empty?

          super(type: EventType::THINKING_TEXT_MESSAGE_CONTENT, timestamp: timestamp, raw_event: raw_event)
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(delta: @delta)
        end
      end

      # Event indicating the end of a thinking text message.
      class ThinkingTextMessageEndEvent < BaseEvent
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(timestamp: nil, raw_event: nil)
          super(type: EventType::THINKING_TEXT_MESSAGE_END, timestamp: timestamp, raw_event: raw_event)
        end
      end

      # Signals the start of a tool call.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::ToolCallStartEvent.new(
      #   tool_call_id: "tc1",
      #   tool_call_name: "search",
      #   parent_message_id: nil
      # )
      #
      # ```
      # @category Tool Call Events
      class ToolCallStartEvent < BaseEvent
        sig { returns(String) }
        attr_reader :tool_call_id

        sig { returns(String) }
        attr_reader :tool_call_name

        sig { returns(T.nilable(String)) }
        attr_reader :parent_message_id

        # @param tool_call_id [String] Unique identifier for the tool call
        # @param tool_call_name [String] Name of the tool being called
        # @param parent_message_id [String] ID of the parent message
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig do
          params(
            tool_call_id: String,
            tool_call_name: String,
            parent_message_id: T.nilable(String),
            timestamp: T.nilable(Time),
            raw_event: T.untyped
          ).void
        end
        def initialize(tool_call_id:, tool_call_name:, parent_message_id: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::TOOL_CALL_START, timestamp: timestamp, raw_event: raw_event)
          @tool_call_id = tool_call_id
          @tool_call_name = tool_call_name
          @parent_message_id = parent_message_id
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(tool_call_id: @tool_call_id, tool_call_name: @tool_call_name, parent_message_id: @parent_message_id)
        end
      end

      # Represents a chunk of argument data for a tool call.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::ToolCallArgsEvent.new(
      #   tool_call_id: "tc1",
      #   delta: "{\"q\":\"AG-UI\"}"
      # )
      #
      # ```
      # @category Tool Call Events
      class ToolCallArgsEvent < BaseEvent
        sig { returns(String) }
        attr_reader :tool_call_id

        sig { returns(String) }
        attr_reader :delta

        # @param tool_call_id [String] Matches the ID from ToolCallStartEvent
        # @param delta [String] Argument data chunk
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(tool_call_id: String, delta: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(tool_call_id:, delta:, timestamp: nil, raw_event: nil)
          super(type: EventType::TOOL_CALL_ARGS, timestamp: timestamp, raw_event: raw_event)
          @tool_call_id = tool_call_id
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(tool_call_id: @tool_call_id, delta: @delta)
        end
      end

      # Signals the end of a tool call.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::ToolCallEndEvent.new(tool_call_id: "tc1")
      #
      # ```
      # @category Tool Call Events
      class ToolCallEndEvent < BaseEvent
        sig { returns(String) }
        attr_reader :tool_call_id

        # @param tool_call_id [String] Matches the ID from ToolCallStartEvent
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(tool_call_id: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(tool_call_id:, timestamp: nil, raw_event: nil)
          super(type: EventType::TOOL_CALL_END, timestamp: timestamp, raw_event: raw_event)
          @tool_call_id = tool_call_id
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(tool_call_id: @tool_call_id)
        end
      end

      # Convenience event for tool calls without manually emitting
      # `ToolCallStartEvent`/`ToolCallEndEvent`.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::ToolCallChunkEvent.new(
      #   tool_call_id: "tc1",
      #   tool_call_name: "search",
      #   delta: "{\"q\":\"AG-UI\"}"
      # )
      #
      # ```
      #
      # Behavior:
      # - Convenience: Consumers may expand chunk sequences into the standard
      #   start/args/end triad (the JS/TS client does this automatically).
      # - First chunk requirements: Include both `tool_call_id` and `tool_call_name` on
      #   the first chunk.
      # - Streaming: Subsequent chunks with the same `tool_call_id` correspond to args
      #   pieces; completion triggers an implied end in clients that perform expansion.
      # @category Tool Call Events
      class ToolCallChunkEvent < BaseEvent
        sig { returns(T.nilable(String)) }
        attr_reader :tool_call_id

        sig { returns(T.nilable(String)) }
        attr_reader :tool_call_name

        sig { returns(T.nilable(String)) }
        attr_reader :parent_message_id

        sig { returns(T.nilable(String)) }
        attr_reader :delta

        # @param tool_call_id [String] Matches the ID from ToolCallStartEvent
        # @param tool_call_name [String] Name of the tool being called
        # @param parent_message_id [String] ID of the parent message
        # @param delta [String] Argument data chunk
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig do
          params(
            tool_call_id: T.nilable(String),
            tool_call_name: T.nilable(String),
            parent_message_id: T.nilable(String),
            delta: T.nilable(String),
            timestamp: T.nilable(Time),
            raw_event: T.untyped
          ).void
        end
        def initialize(tool_call_id: nil, tool_call_name: nil, parent_message_id: nil, delta: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::TOOL_CALL_CHUNK, timestamp: timestamp, raw_event: raw_event)
          @tool_call_id = tool_call_id
          @tool_call_name = tool_call_name
          @parent_message_id = parent_message_id
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            tool_call_id: @tool_call_id,
            tool_call_name: @tool_call_name,
            parent_message_id: @parent_message_id,
            delta: @delta
          )
        end
      end

      # Provides the result of a tool call execution.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::ToolCallResultEvent.new(
      #   message_id: "m1",
      #   tool_call_id: "tc1",
      #   content: "ok"
      # )
      #
      # ```
      # @category Tool Call Events
      class ToolCallResultEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message_id

        sig { returns(String) }
        attr_reader :tool_call_id

        sig { returns(String) }
        attr_reader :content

        sig { returns(T.nilable(String)) }
        attr_reader :role

        # @param message_id [String] ID of the conversation message this result belongs to
        # @param tool_call_id [String] Matches the ID from the corresponding ToolCallStartEvent
        # @param content [String] The actual result/output content from the tool execution
        # @param role [String] Optional role identifier, typically "tool" for tool results
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig do
          params(
            message_id: String,
            tool_call_id: String,
            content: String,
            role: T.nilable(String),
            timestamp: T.nilable(Time),
            raw_event: T.untyped
          ).void
        end
        def initialize(message_id:, tool_call_id:, content:, role: nil, timestamp: nil, raw_event: nil)
          raise ArgumentError, "role must be tool, got #{role}" if !role.nil? && role != "tool"
          
          super(type: EventType::TOOL_CALL_RESULT, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @tool_call_id = tool_call_id
          @content = content
          @role = role
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            message_id: @message_id,
            tool_call_id: @tool_call_id,
            content: @content,
            role: @role
          )
        end
      end

      # Event indicating the start of a thinking step event.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::ThinkingStartEvent.new(title: "step")
      # ```
      #
      # @category Thinking Events
      class ThinkingStartEvent < BaseEvent
        sig { returns(T.nilable(String)) }
        attr_reader :title

        # @param title [String] Title of the thinking step
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(title: T.nilable(String), timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(title: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::THINKING_START, timestamp: timestamp, raw_event: raw_event)
          @title = title
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(title: @title)
        end
      end

      # Event indicating the end of a thinking step event.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::ThinkingEndEvent.new
      # ```
      #
      # @category Thinking Events
      class ThinkingEndEvent < BaseEvent
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(timestamp: nil, raw_event: nil)
          super(type: EventType::THINKING_END, timestamp: timestamp, raw_event: raw_event)
        end
      end

      # Provides a complete snapshot of an agent's state.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::StateSnapshotEvent.new(snapshot: { "a" => 1 })
      # ```
      #
      # @category State Management Events
      class StateSnapshotEvent < BaseEvent
        sig { returns(T.untyped) }
        attr_reader :snapshot

        # @param snapshot [Object] Complete state snapshot
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(snapshot: T.untyped, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(snapshot:, timestamp: nil, raw_event: nil)
          super(type: EventType::STATE_SNAPSHOT, timestamp: timestamp, raw_event: raw_event)
          @snapshot = snapshot
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(snapshot: @snapshot)
        end
      end

      # Provides a partial update to an agent's state using JSON Patch.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::StateDeltaEvent.new(delta: [{ "op" => "replace", "path" => "/a", "value" => 2 }])
      # ```
      #
      # @category State Management Events
      class StateDeltaEvent < BaseEvent
        sig { returns(T::Array[T.untyped]) }
        attr_reader :delta

        # @param delta [Array<Object>] Array of JSON Patch operations
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(delta: T::Array[T.untyped], timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(delta:, timestamp: nil, raw_event: nil)
          super(type: EventType::STATE_DELTA, timestamp: timestamp, raw_event: raw_event)
          @delta = delta
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(delta: @delta)
        end
      end

      # Provides a snapshot of all messages in a conversation.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::MessagesSnapshotEvent.new(messages: [{ "id" => "m1", "content" => "hi" }])
      # ```
      #
      # @category State Management Events
      class MessagesSnapshotEvent < BaseEvent
        sig { returns(T::Array[T.untyped]) }
        attr_reader :messages

        # @param messages [Array<AgUiProtocol::Core::Types::BaseMessage>] Array of message objects
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(messages: T::Array[AgUiProtocol::Core::Types::BaseMessage], timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(messages:, timestamp: nil, raw_event: nil)
          unless messages.is_a?(Array) && messages.all? { |m| m.is_a?(AgUiProtocol::Core::Types::BaseMessage) }
            raise ArgumentError, "messages must be an Array of BaseMessage"
          end

          super(type: EventType::MESSAGES_SNAPSHOT, timestamp: timestamp, raw_event: raw_event)
          @messages = messages
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(messages: @messages)
        end
      end

      # Delivers a complete snapshot of an activity message.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::ActivitySnapshotEvent.new(message_id: "m1", activity_type: "PLAN", content: { "a" => 1 })
      # ```
      #
      # @category State Management Events
      class ActivitySnapshotEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message_id

        sig { returns(String) }
        attr_reader :activity_type

        sig { returns(T.untyped) }
        attr_reader :content

        sig { returns(T::Boolean) }
        attr_reader :replace

        # @param message_id [String] Identifier for the target `ActivityMessage` 
        # @param activity_type [String] Activity discriminator such as `"PLAN"` or `"SEARCH"`
        # @param content [Object] Structured payload describing the full activity state
        # @param replace [Boolean] When `false`, the snapshot is ignored if a message with the same ID already exists
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig do
          params(
            message_id: String,
            activity_type: String,
            content: T.untyped,
            replace: T::Boolean,
            timestamp: T.nilable(Time),
            raw_event: T.untyped
          ).void
        end
        def initialize(message_id:, activity_type:, content:, replace: true, timestamp: nil, raw_event: nil)
          super(type: EventType::ACTIVITY_SNAPSHOT, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @activity_type = activity_type
          @content = content
          @replace = replace
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            message_id: @message_id,
            activity_type: @activity_type,
            content: @content,
            replace: @replace
          )
        end
      end

      # Provides incremental updates to an activity snapshot using JSON Patch.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::ActivityDeltaEvent.new(message_id: "m1", activity_type: "PLAN", patch: [{ "op" => "replace", "path" => "/a", "value" => 2 }])
      # ```
      #
      # @category State Management Events
      class ActivityDeltaEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message_id

        sig { returns(String) }
        attr_reader :activity_type

        sig { returns(T::Array[T.untyped]) }
        attr_reader :patch

        # @param message_id [String] Identifier for the target `ActivityMessage`
        # @param activity_type [String] Activity discriminator mirroring the most recent snapshot
        # @param patch [Array<Object>] JSON Patch operations applied to the structured activity content
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(message_id: String, activity_type: String, patch: T.untyped, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(message_id:, activity_type:, patch:, timestamp: nil, raw_event: nil)
          super(type: EventType::ACTIVITY_DELTA, timestamp: timestamp, raw_event: raw_event)
          @message_id = message_id
          @activity_type = activity_type
          @patch = patch
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            message_id: @message_id,
            activity_type: @activity_type,
            patch: @patch
          )
        end
      end

      # Used to pass through events from external systems.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::RawEvent.new(event: { "type" => "my_event", "data" => { "a" => 1 } }, source: "my_source")
      # ```
      #
      # @category Special Events
      class RawEvent < BaseEvent
        sig { returns(T.untyped) }
        attr_reader :event

        sig { returns(T.nilable(String)) }
        attr_reader :source

        # @param event [Object] Original event data
        # @param source [String] Source of the event
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(event: T.untyped, source: T.nilable(String), timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(event:, source: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::RAW, timestamp: timestamp, raw_event: raw_event)
          @event = event
          @source = source
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(event: @event, source: @source)
        end
      end

      # Used for application-specific custom events.
      #
      # ```ruby
      # event = AgUiProtocol::Core::Events::CustomEvent.new(name: "my_event", value: { "a" => 1 })
      # ```
      #
      # @category Special Events
      class CustomEvent < BaseEvent
        sig { returns(String) }
        attr_reader :name

        sig { returns(T.untyped) }
        attr_reader :value

        # @param name [String] Name of the custom event
        # @param value [Object] Value of the custom event
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(name: String, value: T.untyped, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(name:, value:, timestamp: nil, raw_event: nil)
          super(type: EventType::CUSTOM, timestamp: timestamp, raw_event: raw_event)
          @name = name
          @value = value
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(name: @name, value: @value)
        end
      end

      # Signals the start of an agent run.
      #
      # ```ruby
      #
      # input = AgUiProtocol::Core::Types::RunAgentInput.new(
      #   thread_id: "t1",
      #   run_id: "r1",
      #   state: {},
      #   messages: [],
      #   tools: [],
      #   context: [],
      #   forwarded_props: {}
      # )
      #
      # event = AgUiProtocol::Core::Events::RunStartedEvent.new(
      #   thread_id: "t1",
      #   run_id: "r1",
      #   parent_run_id: nil,
      #   input: input
      # )
      #
      # ```
      # @category Lifecycle Events
      class RunStartedEvent < BaseEvent
        sig { returns(String) }
        attr_reader :thread_id

        sig { returns(String) }
        attr_reader :run_id

        sig { returns(T.nilable(String)) }
        attr_reader :parent_run_id

        sig { returns(T.untyped) }
        attr_reader :input

        # @param thread_id [String] ID of the conversation thread
        # @param run_id [String] ID of the run
        # @param parent_run_id [String] Lineage pointer for branching/time travel. If present, refers to a prior run within the same thread
        # @param input [Object] The exact agent input payload sent to the agent for this run. May omit messages already in history
        sig do
          params(
            thread_id: String,
            run_id: String,
            parent_run_id: T.nilable(String),
            input: T.untyped,
            timestamp: T.nilable(Time),
            raw_event: T.untyped
          ).void
        end
        def initialize(thread_id:, run_id:, parent_run_id: nil, input: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::RUN_STARTED, timestamp: timestamp, raw_event: raw_event)
          @thread_id = thread_id
          @run_id = run_id
          @parent_run_id = parent_run_id
          @input = input
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            thread_id: @thread_id,
            run_id: @run_id,
            parent_run_id: @parent_run_id,
            input: @input
          )
        end
      end

      # Signals the successful completion of an agent run.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::RunFinishedEvent.new(thread_id: "t1", run_id: "r1", result: { "a" => 1 })
      #
      # ```
      #
      # @category Lifecycle Events
      class RunFinishedEvent < BaseEvent
        sig { returns(String) }
        attr_reader :thread_id

        sig { returns(String) }
        attr_reader :run_id

        sig { returns(T.untyped) }
        attr_reader :result

        # @param thread_id [String] ID of the conversation thread
        # @param run_id [String] ID of the run
        # @param result [Object] Result data from the agent run
          # @param timestamp [Time] Timestamp when the event was created
          # @param raw_event [Object] Original event data if this event was transformed
        sig { params(thread_id: String, run_id: String, result: T.untyped, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(thread_id:, run_id:, result: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::RUN_FINISHED, timestamp: timestamp, raw_event: raw_event)
          @thread_id = thread_id
          @run_id = run_id
          @result = result
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(thread_id: @thread_id, run_id: @run_id, result: @result)
        end
      end

      # Signals an error during an agent run.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::RunErrorEvent.new(message: "An error occurred", code: "RUN_ERROR")
      #
      # ```
      #
      # @category Lifecycle Events
      class RunErrorEvent < BaseEvent
        sig { returns(String) }
        attr_reader :message

        sig { returns(T.nilable(String)) }
        attr_reader :code

        # @param message [String] Error message
        # @param code [String] Error code
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(message: String, code: T.nilable(String), timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(message:, code: nil, timestamp: nil, raw_event: nil)
          super(type: EventType::RUN_ERROR, timestamp: timestamp, raw_event: raw_event)
          @message = message
          @code = code
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(message: @message, code: @code)
        end
      end

      # Signals the start of a step within an agent run.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::StepStartedEvent.new(step_name: "s1")
      #
      # ```
      #
      # @category Lifecycle Events
      class StepStartedEvent < BaseEvent
        sig { returns(String) }
        attr_reader :step_name

        # @param step_name [String] Name of the step
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(step_name: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(step_name:, timestamp: nil, raw_event: nil)
          super(type: EventType::STEP_STARTED, timestamp: timestamp, raw_event: raw_event)
          @step_name = step_name
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(step_name: @step_name)
        end
      end

      # Signals the completion of a step within an agent run.
      #
      # ```ruby
      #
      # event = AgUiProtocol::Core::Events::StepFinishedEvent.new(step_name: "s1")
      #
      # ```
      #
      # @category Lifecycle Events
      class StepFinishedEvent < BaseEvent
        sig { returns(String) }
        attr_reader :step_name

        # @param step_name [String] Name of the step
        # @param timestamp [Time] Timestamp when the event was created
        # @param raw_event [Object] Original event data if this event was transformed
        sig { params(step_name: String, timestamp: T.nilable(Time), raw_event: T.untyped).void }
        def initialize(step_name:, timestamp: nil, raw_event: nil)
          super(type: EventType::STEP_FINISHED, timestamp: timestamp, raw_event: raw_event)
          @step_name = step_name
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(step_name: @step_name)
        end
      end
    end
  end
end
