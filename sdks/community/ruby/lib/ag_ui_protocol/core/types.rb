# typed: true
# frozen_string_literal: true

require "sorbet-runtime"
require_relative "../util"

module AgUiProtocol
  module Core
    # The Agent User Interaction Protocol Ruby SDK is built on a set of core types
    # that represent the fundamental structures used throughout the system. This page
    # documents these types and their properties.
    #
    # ## Message Types
    #
    # The SDK includes several message types that represent different kinds of
    # messages in the system.
    #
    module Types
      # Represents the possible roles a message sender can have.
      #
      # ```ruby
      #
      # AgUiProtocol::Core::Types::Role
      # # => ["developer", "system", "assistant", "user", "tool", "activity"]
      #
      # ```
      # @category Message Types
      Role = ["developer", "system", "assistant", "user", "tool", "activity"].freeze

      # Base model for protocol entities.
      #
      # Subclasses should implement {#to_h}. JSON serialization is derived from
      # that hash via {#as_json} and {#to_json}.
      class Model
        extend T::Sig

        # Returns a Ruby Hash representation using snake_case keys or raise NotImplementedError in case of not implemented.
        #
        # Subclasses override this method to provide their shape.
        #
        # @return [Hash<Symbol, Object>, raise NotImplementedError]
        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          raise NotImplementedError, 'Implement this method by concrect class'
        end

        # Returns a JSON-ready representation.
        #
        # This converts keys to camelCase and removes nil values recursively.
        #
        # @return [Object]
        sig { returns(T.untyped) }
        def as_json
          AgUiProtocol::Util.deep_transform_keys_to_camel(AgUiProtocol::Util.deep_compact(to_h))
        end

        # Serializes the model to a JSON string.
        #
        # @param _args [Array<Object>] Unused; kept for compatibility with ActiveSupport.
        # @return [String]
        sig { params(_args: T.untyped).returns(String) }
        def to_json(*_args)
          AgUiProtocol::Util.dump_json(as_json)
        end
      end

      # Function invocation descriptor used inside tool calls.
      #
      # ```ruby
      #
      # fn = AgUiProtocol::Core::Types::FunctionCall.new(
      #   name: "search",
      #   arguments: "{\"q\":\"AG-UI\"}"
      # )
      #
      # ```
      # @category ToolCall
      class FunctionCall < Model
        sig { returns(String) }
        attr_reader :name

        sig { returns(String) }
        attr_reader :arguments

        # @param name [String] Function name.
        # @param arguments [String] JSON-encoded arguments.
        sig { params(name: String, arguments: String).void }
        def initialize(name:, arguments:)
          @name = name
          @arguments = arguments
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            name: @name,
            arguments: @arguments
          }
        end
      end

      # Tool calls are embedded within assistant messages.
      #
      # ```ruby
      #
      # tool_call = AgUiProtocol::Core::Types::ToolCall.new(
      #   id: "tc_1",
      #   function: { name: "search", arguments: "{\"q\":\"AG-UI\"}" }
      # )
      #
      # ```
      class ToolCall < Model
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :type

        sig { returns(FunctionCall) }
        attr_reader :function

        # @param id [String] Unique identifier for the tool call
        # @param function [FunctionCall, Hash] Function name and arguments
        # @param type [String] Type of the tool call
        sig { params(id: String, function: T.untyped, type: String).void }
        def initialize(id:, function:, type: 'function')
          @id = id
          @type = type
          @function = function.is_a?(FunctionCall) ? function : FunctionCall.new(**function)
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            type: @type,
            function: @function
          }
        end
      end

      # Base class for message shapes.
      class BaseMessage < Model
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :role

        sig { returns(T.nilable(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)]))) }
        attr_reader :content

        sig { returns(T.nilable(String)) }
        attr_reader :name

        # @param id [String] Unique identifier for the message
        # @param role [String] Role of the message sender
        # @param content [Object] Text content of the message
        # @param name [String] Optional name of the sender
        sig { params(id: String, role: String, content: T.nilable(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)])), name: T.nilable(String)).void }
        def initialize(id:, role:, content: nil, name: nil)
          @id = id
          @role = role
          @content = content
          @name = name
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            content: @content,
            name: @name
          }
        end
      end

      # Represents a message from a developer.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::DeveloperMessage.new(
      #   id: "dev_1",
      #   content: "You are a helpful assistant."
      # )
      #
      # ```
      # @category Message Types
      class DeveloperMessage < BaseMessage

        sig { returns(String) }
        attr_reader :content

        # @param id [String] Unique identifier for the message
        # @param content [Object] Text content of the message (required)
        # @param name [String] Optional name of the sender
        sig { params(id: String, content: String, name: T.nilable(String)).void }
        def initialize(id:, content:, name: nil)
          super(id: id, role: "developer", content: content, name: name)
        end
      end

      # Represents a system message.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::SystemMessage.new(
      #   id: "sys_1",
      #   content: "Follow the protocol."
      # )
      #
      # ```
      # @category Message Types
      class SystemMessage < BaseMessage

        # @param id [String] Unique identifier for the message
        # @param content [Object] Text content of the message (required)
        # @param name [String] Optional name of the sender
        sig { params(id: String, content: String, name: T.nilable(String)).void }
        def initialize(id:, content:, name: nil)
          super(id: id, role: "system", content: content, name: name)
        end
      end

      # Represents a message from an assistant.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::AssistantMessage.new(
      #   id: "asst_1",
      #   content: "Hello!",
      #   tool_calls: [
      #     {
      #       id: "tc_1",
      #       function: { name: "search", arguments: "{\"q\":\"AG-UI\"}" }
      #     }
      #   ]
      # )
      #
      # ```
      # @category Message Types
      class AssistantMessage < BaseMessage

        sig { returns(T.nilable(T::Array[ToolCall])) }
        attr_reader :tool_calls

        # @param id [String] Unique identifier for the message
        # @param content [Object] Text content of the message
        # @param tool_calls [Array<ToolCall, Hash>] Tool calls made in this message
        # @param name [String] Name of the sender
        sig { params(id: String, content: T.untyped, tool_calls: T.nilable(T::Array[ToolCall]), name: T.nilable(String)).void }
        def initialize(id:, content: nil, tool_calls: nil, name: nil)
          super(id: id, role: "assistant", content: content, name: name)
          @tool_calls = tool_calls&.map do |tc|
            tc.is_a?(ToolCall) ? tc : ToolCall.new(**tc)
          end
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(tool_calls: @tool_calls)
        end
      end

      # Represents a text fragment inside a multimodal user message.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::TextInputContent.new(text: "hello")
      #
      # ```
      # @category Message Types
      class TextInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(String) }
        attr_reader :text

        # @param text [String] Text content
        # @param type [String] Identifies the fragment type
        sig { params(text: String, type: String).void }
        def initialize(text:, type: "text")
          @type = type
          @text = text
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            text: @text
          }
        end
      end

      # Represents binary data such as images, audio, or files.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::BinaryInputContent.new(
      #   mime_type: "image/png",
      #   url: "https://example.com/cat.png"
      # )
      #
      # ```
      #
      # > **Validation:** At least one of `id`, `url`, or `data` must be provided.
      # @category Message Types
      class BinaryInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(String) }
        attr_reader :mime_type

        sig { returns(T.nilable(String)) }
        attr_reader :id

        sig { returns(T.nilable(String)) }
        attr_reader :url

        sig { returns(T.nilable(String)) }
        attr_reader :data

        sig { returns(T.nilable(String)) }
        attr_reader :filename

        # @param type [String] Identifies the fragment type
        # @param mime_type [String] MIME type, for example `"image/png"`
        # @param id [String] Reference to previously uploaded content
        # @param url [String] Remote URL where the content can be retrieved
        # @param data [String] Base64 encoded content
        # @param filename [String] Optional filename hint
        sig do
          params(
            mime_type: String,
            type: String,
            id: T.nilable(String),
            url: T.nilable(String),
            data: T.nilable(String),
            filename: T.nilable(String)
          ).void
        end
        def initialize(mime_type:, type: "binary", id: nil, url: nil, data: nil, filename: nil)
          if [id, url, data].all?(&:nil?)
            raise ArgumentError, "BinaryInputContent requires id, url, or data to be provided."
          end

          @type = type
          @mime_type = mime_type
          @id = id
          @url = url
          @data = data
          @filename = filename
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            mime_type: @mime_type,
            id: @id,
            url: @url,
            data: @data,
            filename: @filename
          }
        end
      end

      # Represents a message from a user.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::UserMessage.new(
      #   id: "user_2",
      #   content: [
      #     { type: "text", text: "Please describe this image" },
      #     { type: "binary", mimeType: "image/png", url: "https://example.com/cat.png" }
      #   ]
      # )
      #
      # ```
      # @category Message Types
      class UserMessage < BaseMessage
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :role

        sig { returns(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)])) }
        attr_reader :content

        sig { returns(T.nilable(String)) }
        attr_reader :name

        # @param id [String] Unique identifier for the message
        # @param content [String, Array<TextInputContent | BinaryInputContent>] Either a plain text string or an ordered list of multimodal fragments
        # @param name [String] Optional name of the sender
        sig { params(id: String, content: T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)]), name: T.nilable(String)).void }
        def initialize(id:, content:, name: nil)
          super(id: id, role: "user", content: normalize_user_content(content), name: name)
        end

        sig { params(content: T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)])).returns(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent)])) }
        def normalize_user_content(content)
          if content.is_a?(Array)
            content.map do |c|
              if c.is_a?(Model)
                c
              elsif c.is_a?(Hash)
                case c[:type] || c["type"]
                when "text"
                  TextInputContent.new(text: c[:text] || c["text"])
                when "binary"
                  BinaryInputContent.new(
                    mime_type: c[:mime_type] || c["mime_type"] || c[:mimeType] || c["mimeType"],
                    id: c[:id] || c["id"],
                    url: c[:url] || c["url"],
                    data: c[:data] || c["data"],
                    filename: c[:filename] || c["filename"]
                  )
                else
                  c
                end
              else
                c
              end
            end
          else
            content
          end
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            content: @content,
            name: @name
          }
        end
      end

      # Tool result message.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::ToolMessage.new(
      #   id: "tool_msg_1",
      #   tool_call_id: "tc_1",
      #   content: "ok"
      # )
      #
      # ```
      # @category Message Types
      class ToolMessage < BaseMessage
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :role

        sig { returns(String) }
        attr_reader :content

        sig { returns(String) }
        attr_reader :tool_call_id

        sig { returns(T.nilable(String)) }
        attr_reader :error

        # @param id [String] Unique identifier for the message.
        # @param content [String] Tool result content.
        # @param tool_call_id [String] ID of the tool call this message responds to.
        # @param error [String] Error payload if the tool call failed.
        sig { params(id: String, content: String, tool_call_id: String, error: T.nilable(String)).void }
        def initialize(id:, content:, tool_call_id:, error: nil)
          super(id: id, role: "tool", content: content)
          @tool_call_id = tool_call_id
          @error = error
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            content: @content,
            tool_call_id: @tool_call_id,
            error: @error
          }
        end
      end

      # Represents structured activity progress emitted between chat messages.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::ActivityMessage.new(
      #   id: "activity_1",
      #   activity_type: "progress",
      #   content: { "pct" => 10 }
      # )
      #
      # ```
      # @category Message Types
      class ActivityMessage < BaseMessage
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :role

        sig { returns(String) }
        attr_reader :activity_type

        sig { returns(T::Hash[T.any(Symbol, String), T.untyped]) }
        attr_reader :content

        # @param id [String] Unique identifier for the activity message.
        # @param activity_type [String] Activity discriminator used for renderer selection.
        # @param content [Hash] Structured payload representing the activity state.
        sig { params(id: String, activity_type: String, content: T::Hash[T.any(Symbol, String), T.untyped]).void }
        def initialize(id:, activity_type:, content:)
          @id = id
          @role = 'activity'
          @activity_type = activity_type
          @content = content
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            activity_type: @activity_type,
            content: @content
          }
        end
      end

      # Represents a piece of contextual information provided to an agent.
      #
      # ```ruby
      #
      # ctx = AgUiProtocol::Core::Types::Context.new(description: "User locale", value: "es-CL")
      #
      # ```
      class Context < Model
        sig { returns(String) }
        attr_reader :description

        sig { returns(String) }
        attr_reader :value

        # @param description [String] Description of what this context represents.
        # @param value [String] The actual context value.
        sig { params(description: String, value: String).void }
        def initialize(description:, value:)
          @description = description
          @value = value
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            description: @description,
            value: @value
          }
        end
      end

      # Defines a tool that can be called by an agent.
      #
      # ```ruby
      #
      # tool = AgUiProtocol::Core::Types::Tool.new(
      #   name: "search",
      #   description: "Search the web",
      #   parameters: { "type" => "object", "properties" => { "q" => { "type" => "string" } } }
      # )
      #
      # ```
      class Tool < Model
        sig { returns(String) }
        attr_reader :name

        sig { returns(String) }
        attr_reader :description

        sig { returns(T.untyped) }
        attr_reader :parameters

        # @param name [String] Name of the tool.
        # @param description [String] Description of what the tool does.
        # @param parameters [Object] JSON Schema for tool parameters.
        sig { params(name: String, description: String, parameters: T.untyped).void }
        def initialize(name:, description:, parameters:)
          @name = name
          @description = description
          @parameters = parameters
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            name: @name,
            description: @description,
            parameters: @parameters
          }
        end
      end

      # Input parameters for running an agent. In the HTTP API, this is the body of the `POST` request.
      #
      # ```ruby
      #
      # input = AgUiProtocol::Core::Types::RunAgentInput.new(
      #   thread_id: "thread_123",
      #   run_id: "run_123",
      #   parent_run_id: nil,
      #   state: {},
      #   messages: [],
      #   tools: [],
      #   context: [],
      #   forwarded_props: {}
      # )
      #
      # ```
      class RunAgentInput < Model
        sig { returns(String) }
        attr_reader :thread_id

        sig { returns(String) }
        attr_reader :run_id

        sig { returns(T.nilable(String)) }
        attr_reader :parent_run_id

        sig { returns(T.untyped) }
        attr_reader :state

        sig { returns(T::Array[BaseMessage]) }
        attr_reader :messages

        sig { returns(T::Array[Tool]) }
        attr_reader :tools

        sig { returns(T::Array[Context]) }
        attr_reader :context

        sig { returns(T.untyped) }
        attr_reader :forwarded_props

        # @param thread_id [String] ID of the conversation thread
        # @param run_id [String] ID of the current run
        # @param state [Object] Current state of the agent
        # @param messages [Array<BaseMessage>] List of messages in the conversation
        # @param tools [Array<Tool>] List of tools available to the agent
        # @param context [Array<Context>] List of context objects provided to the agent
        # @param forwarded_props [Object] Additional properties forwarded to the agent
        # @param parent_run_id [String] Lineage pointer for branching/time travel
        # @raise [ArgumentError] if messages is not an Array of BaseMessage
        sig do
          params(
            thread_id: String,
            run_id: String,
            state: T.untyped,
            messages: T::Array[BaseMessage],
            tools: T::Array[Tool],
            context: T::Array[Context],
            forwarded_props: T.untyped,
            parent_run_id: T.nilable(String)
          ).void.checked(:always)
        end
        def initialize(thread_id:, run_id:, state:, messages:, tools:, context:, forwarded_props:, parent_run_id: nil)
          unless messages.is_a?(Array) && messages.all? { |m| m.is_a?(BaseMessage) }
            raise ArgumentError, "messages must be an Array of BaseMessage"
          end
          unless tools.is_a?(Array) && tools.all? { |m| m.is_a?(Tool) }
            raise ArgumentError, "tools must be an Array of Tool"
          end
          unless context.is_a?(Array) && context.all? { |m| m.is_a?(Context) }
            raise ArgumentError, "context must be an Array of Context"
          end

          @thread_id = thread_id
          @run_id = run_id
          @parent_run_id = parent_run_id
          @state = state
          @messages = messages
          @tools = tools
          @context = context
          @forwarded_props = forwarded_props
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            thread_id: @thread_id,
            run_id: @run_id,
            parent_run_id: @parent_run_id,
            state: @state,
            messages: @messages,
            tools: @tools,
            context: @context,
            forwarded_props: @forwarded_props
          }
        end
      end
    end
  end
end
