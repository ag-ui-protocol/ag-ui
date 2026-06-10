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
      # # => ["developer", "system", "assistant", "user", "tool", "activity", "reasoning"]
      #
      # ```
      Role = ["developer", "system", "assistant", "user", "tool", "activity", "reasoning"].freeze

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
          raise NotImplementedError, "Implement this method in a concrete subclass"
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

        sig { returns(T.nilable(String)) }
        attr_reader :encrypted_value

        # @param id [String] Unique identifier for the tool call
        # @param function [FunctionCall, Hash] Function name and arguments
        # @param type [String] Type of the tool call
        # @param encrypted_value [String] Encrypted tool call value for zero-data-retention mode
        sig { params(id: String, function: T.untyped, type: String, encrypted_value: T.nilable(String)).void }
        def initialize(id:, function:, type: 'function', encrypted_value: nil)
          @id = id
          @type = type
          @function = if function.is_a?(FunctionCall)
                       function
                     else
                       FunctionCall.new(**function.transform_keys(&:to_sym))
                     end
          @encrypted_value = encrypted_value
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            type: @type,
            function: @function,
            encrypted_value: @encrypted_value
          }
        end
      end

      # Base class for message shapes.
      class BaseMessage < Model
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :role

        sig { returns(T.nilable(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)]))) }
        attr_reader :content

        sig { returns(T.nilable(String)) }
        attr_reader :name

        sig { returns(T.nilable(String)) }
        attr_reader :encrypted_value

        # @param id [String] Unique identifier for the message
        # @param role [String] Role of the message sender
        # @param content [Object] Text content of the message
        # @param name [String] Optional name of the sender
        # @param encrypted_value [String] Encrypted content for zero-data-retention mode
        sig do
          params(
            id: String,
            role: String,
            content: T.nilable(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)])),
            name: T.nilable(String),
            encrypted_value: T.nilable(String)
          ).void
        end
        def initialize(id:, role:, content: nil, name: nil, encrypted_value: nil)
          @id = id
          @role = role
          @content = content
          @name = name
          @encrypted_value = encrypted_value
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            content: @content,
            name: @name,
            encrypted_value: @encrypted_value
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
        # @param tool_calls [Array<ToolCall, Hash>] Tool calls made in this message; Hashes are normalized to ToolCall instances.
        # @param name [String] Name of the sender
        # @param encrypted_value [String] Encrypted content for zero-data-retention mode
        sig do
          params(
            id: String,
            content: T.untyped,
            tool_calls: T.nilable(T::Array[T.any(ToolCall, T::Hash[T.any(Symbol, String), T.untyped])]),
            name: T.nilable(String),
            encrypted_value: T.nilable(String)
          ).void
        end
        def initialize(id:, content: nil, tool_calls: nil, name: nil, encrypted_value: nil)
          super(id: id, role: "assistant", content: content, name: name, encrypted_value: encrypted_value)
          @tool_calls = tool_calls&.map do |tc|
            next tc if tc.is_a?(ToolCall)
            ToolCall.new(**tc.transform_keys(&:to_sym))
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
          if [id, url, data].none? { |v| v.is_a?(String) && !v.empty? }
            raise ArgumentError, "BinaryInputContent requires at least one of id, url, or data to be a non-empty string"
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
        # @param id [String] Unique identifier for the message
        # @param content [String, Array<TextInputContent | BinaryInputContent | ImageInputContent | AudioInputContent | VideoInputContent | DocumentInputContent | Hash>] Accepted shapes: a String for plain text, or an Array whose elements are either *InputContent Models (TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent) OR Hashes with a `type:` key (`text`, `binary`, `image`, `audio`, `video`, `document`); Hash entries are normalized internally to the corresponding Model.
        # @param name [String] Optional name of the sender
        # @param encrypted_value [String] Encrypted content for zero-data-retention mode
        sig do
          params(
            id: String,
            content: T.any(
              String,
              T::Array[T.any(
                TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent,
                T::Hash[T.any(Symbol, String), T.untyped]
              )]
            ),
            name: T.nilable(String),
            encrypted_value: T.nilable(String)
          ).void
        end
        def initialize(id:, content:, name: nil, encrypted_value: nil)
          super(id: id, role: "user", content: normalize_user_content(content), name: name, encrypted_value: encrypted_value)
        end

        sig do
          params(
            content: T.any(
              String,
              T::Array[T.any(
                TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent,
                T::Hash[T.any(Symbol, String), T.untyped]
              )]
            )
          ).returns(T.any(String, T::Array[T.any(TextInputContent, BinaryInputContent, ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)]))
        end
        def normalize_user_content(content)
          if content.is_a?(Array)
            content.map do |c|
              if c.is_a?(Model)
                c
              elsif c.is_a?(Hash)
                src_type = c[:type] || c["type"]
                case src_type
                when "text"
                  TextInputContent.new(text: c[:text] || c["text"])
                when "binary"
                  BinaryInputContent.new(
                    mime_type: c[:mime_type] || c["mime_type"] || c[:mimeType] || c["mimeType"],
                    id: c[:id] || c["id"],
                    url: c[:url] || c["url"],
                    data: c[:data] || c["data"],
                    filename: c[:filename] || c["filename"] || c[:fileName] || c["fileName"]
                  )
                when "image"
                  ImageInputContent.new(source: c[:source] || c["source"], metadata: c[:metadata] || c["metadata"])
                when "audio"
                  AudioInputContent.new(source: c[:source] || c["source"], metadata: c[:metadata] || c["metadata"])
                when "video"
                  VideoInputContent.new(source: c[:source] || c["source"], metadata: c[:metadata] || c["metadata"])
                when "document"
                  DocumentInputContent.new(source: c[:source] || c["source"], metadata: c[:metadata] || c["metadata"])
                else
                  raise ArgumentError, "Unknown content type: #{src_type.inspect}"
                end
              else
                raise ArgumentError, "Unknown content type: #{c.class}"
              end
            end
          else
            content
          end
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
        attr_reader :tool_call_id

        sig { returns(T.nilable(String)) }
        attr_reader :error

        # @param id [String] Unique identifier for the message.
        # @param content [String] Tool result content.
        # @param tool_call_id [String] ID of the tool call this message responds to.
        # @param error [String] Error payload if the tool call failed.
        # @param encrypted_value [String] Encrypted tool message value for zero-data-retention mode
        sig { params(id: String, content: String, tool_call_id: String, error: T.nilable(String), encrypted_value: T.nilable(String)).void }
        def initialize(id:, content:, tool_call_id:, error: nil, encrypted_value: nil)
          super(id: id, role: "tool", content: content, encrypted_value: encrypted_value)
          @tool_call_id = tool_call_id
          @error = error
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          super.merge(
            tool_call_id: @tool_call_id,
            error: @error
          )
        end
      end

      # Represents structured activity progress emitted between chat messages.
      #
      # ActivityMessage intentionally does NOT inherit from BaseMessage because its
      # `content` is a structured Hash rather than text/multimodal, which is
      # incompatible with BaseMessage#content's type. It still appears alongside
      # other messages in the stream but is modeled as its own shape.
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
      class ActivityMessage < Model
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
          @role = "activity"
          @activity_type = activity_type
          @content = content
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            role: @role,
            activity_type: @activity_type,
            # `content` is an arbitrary user-supplied payload — preserve keys verbatim on the wire.
            content: @content.nil? ? nil : AgUiProtocol::Util::Opaque.new(@content)
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
            # `parameters` is a JSON Schema document supplied by the user — preserve keys verbatim.
            parameters: @parameters.nil? ? nil : AgUiProtocol::Util::Opaque.new(@parameters)
          }
        end
      end

      # Represents a data source for multimodal input content using base64-encoded data.
      #
      # ```ruby
      #
      # source = AgUiProtocol::Core::Types::InputContentDataSource.new(
      #   value: "base64encoded...",
      #   mime_type: "image/png"
      # )
      #
      # ```
      class InputContentDataSource < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(String) }
        attr_reader :value

        sig { returns(String) }
        attr_reader :mime_type

        # @param value [String] Base64 encoded content
        # @param mime_type [String] MIME type of the content
        # @param type [String] Identifies the source type
        sig { params(value: String, mime_type: String, type: String).void }
        def initialize(value:, mime_type:, type: "data")
          @type = type
          @value = value
          @mime_type = mime_type
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            value: @value,
            mime_type: @mime_type
          }
        end
      end

      # Represents a URL source for multimodal input content.
      #
      # ```ruby
      #
      # source = AgUiProtocol::Core::Types::InputContentUrlSource.new(
      #   value: "https://example.com/image.png",
      #   mime_type: "image/png"
      # )
      #
      # ```
      class InputContentUrlSource < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(String) }
        attr_reader :value

        sig { returns(T.nilable(String)) }
        attr_reader :mime_type

        # @param value [String] URL string
        # @param mime_type [String] Optional MIME type
        # @param type [String] Identifies the source type
        sig { params(value: String, mime_type: T.nilable(String), type: String).void }
        def initialize(value:, mime_type: nil, type: "url")
          @type = type
          @value = value
          @mime_type = mime_type
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            value: @value,
            mime_type: @mime_type
          }
        end
      end

      # Represents an image content fragment inside a multimodal user message.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::ImageInputContent.new(
      #   source: { type: "url", value: "https://example.com/cat.png", mime_type: "image/png" }
      # )
      #
      # ```
      class ImageInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(T.any(InputContentDataSource, InputContentUrlSource)) }
        attr_reader :source

        sig { returns(T.untyped) }
        attr_reader :metadata

        # @param source [InputContentDataSource, InputContentUrlSource, Hash] Content source
        # @param metadata [Object] Optional metadata
        # @param type [String] Identifies the fragment type
        sig { params(source: T.untyped, metadata: T.untyped, type: String).void }
        def initialize(source:, metadata: nil, type: "image")
          @type = type
          @source = source.is_a?(Hash) ? build_source(source) : source
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            source: @source,
            metadata: @metadata
          }
        end

        private

        def build_source(hash)
          src_type = hash[:type] || hash["type"]
          value = hash[:value] || hash["value"]
          mime_type = hash[:mime_type] || hash["mime_type"] || hash[:mimeType] || hash["mimeType"]
          case src_type
          when "data"
            InputContentDataSource.new(value: value, mime_type: mime_type)
          when "url"
            InputContentUrlSource.new(value: value, mime_type: mime_type)
          else
            raise ArgumentError, "Unknown source type: #{src_type.inspect}"
          end
        end
      end

      # Represents an audio content fragment inside a multimodal user message.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::AudioInputContent.new(
      #   source: { type: "url", value: "https://example.com/audio.mp3", mime_type: "audio/mp3" }
      # )
      #
      # ```
      class AudioInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(T.any(InputContentDataSource, InputContentUrlSource)) }
        attr_reader :source

        sig { returns(T.untyped) }
        attr_reader :metadata

        # @param source [InputContentDataSource, InputContentUrlSource, Hash] Content source
        # @param metadata [Object] Optional metadata
        # @param type [String] Identifies the fragment type
        sig { params(source: T.untyped, metadata: T.untyped, type: String).void }
        def initialize(source:, metadata: nil, type: "audio")
          @type = type
          @source = source.is_a?(Hash) ? build_source(source) : source
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            source: @source,
            metadata: @metadata
          }
        end

        private

        def build_source(hash)
          src_type = hash[:type] || hash["type"]
          value = hash[:value] || hash["value"]
          mime_type = hash[:mime_type] || hash["mime_type"] || hash[:mimeType] || hash["mimeType"]
          case src_type
          when "data"
            InputContentDataSource.new(value: value, mime_type: mime_type)
          when "url"
            InputContentUrlSource.new(value: value, mime_type: mime_type)
          else
            raise ArgumentError, "Unknown source type: #{src_type.inspect}"
          end
        end
      end

      # Represents a video content fragment inside a multimodal user message.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::VideoInputContent.new(
      #   source: { type: "url", value: "https://example.com/video.mp4", mime_type: "video/mp4" }
      # )
      #
      # ```
      class VideoInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(T.any(InputContentDataSource, InputContentUrlSource)) }
        attr_reader :source

        sig { returns(T.untyped) }
        attr_reader :metadata

        # @param source [InputContentDataSource, InputContentUrlSource, Hash] Content source
        # @param metadata [Object] Optional metadata
        # @param type [String] Identifies the fragment type
        sig { params(source: T.untyped, metadata: T.untyped, type: String).void }
        def initialize(source:, metadata: nil, type: "video")
          @type = type
          @source = source.is_a?(Hash) ? build_source(source) : source
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            source: @source,
            metadata: @metadata
          }
        end

        private

        def build_source(hash)
          src_type = hash[:type] || hash["type"]
          value = hash[:value] || hash["value"]
          mime_type = hash[:mime_type] || hash["mime_type"] || hash[:mimeType] || hash["mimeType"]
          case src_type
          when "data"
            InputContentDataSource.new(value: value, mime_type: mime_type)
          when "url"
            InputContentUrlSource.new(value: value, mime_type: mime_type)
          else
            raise ArgumentError, "Unknown source type: #{src_type.inspect}"
          end
        end
      end

      # Represents a document content fragment inside a multimodal user message.
      #
      # ```ruby
      #
      # content = AgUiProtocol::Core::Types::DocumentInputContent.new(
      #   source: { type: "url", value: "https://example.com/doc.pdf", mime_type: "application/pdf" }
      # )
      #
      # ```
      class DocumentInputContent < Model
        sig { returns(String) }
        attr_reader :type

        sig { returns(T.any(InputContentDataSource, InputContentUrlSource)) }
        attr_reader :source

        sig { returns(T.untyped) }
        attr_reader :metadata

        # @param source [InputContentDataSource, InputContentUrlSource, Hash] Content source
        # @param metadata [Object] Optional metadata
        # @param type [String] Identifies the fragment type
        sig { params(source: T.untyped, metadata: T.untyped, type: String).void }
        def initialize(source:, metadata: nil, type: "document")
          @type = type
          @source = source.is_a?(Hash) ? build_source(source) : source
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            type: @type,
            source: @source,
            metadata: @metadata
          }
        end

        private

        def build_source(hash)
          src_type = hash[:type] || hash["type"]
          value = hash[:value] || hash["value"]
          mime_type = hash[:mime_type] || hash["mime_type"] || hash[:mimeType] || hash["mimeType"]
          case src_type
          when "data"
            InputContentDataSource.new(value: value, mime_type: mime_type)
          when "url"
            InputContentUrlSource.new(value: value, mime_type: mime_type)
          else
            raise ArgumentError, "Unknown source type: #{src_type.inspect}"
          end
        end
      end

      # Represents a reasoning message from an agent with chain-of-thought content.
      #
      # ```ruby
      #
      # msg = AgUiProtocol::Core::Types::ReasoningMessage.new(
      #   id: "reason_1",
      #   content: "Let me think through this step by step...",
      #   encrypted_value: nil
      # )
      #
      # ```
      class ReasoningMessage < BaseMessage

        sig { returns(String) }
        attr_reader :content

        # @param id [String] Unique identifier for the message
        # @param content [String] Reasoning content (plaintext when not encrypted)
        # @param encrypted_value [String] Encrypted reasoning content when in zero-data-retention mode
        sig { params(id: String, content: String, encrypted_value: T.nilable(String)).void }
        def initialize(id:, content:, encrypted_value: nil)
          super(id: id, role: "reasoning", content: content, encrypted_value: encrypted_value)
        end
      end

      # Represents an interrupt that occurred during agent execution for human-in-the-loop workflows.
      #
      # ```ruby
      #
      # interrupt = AgUiProtocol::Core::Types::Interrupt.new(
      #   id: "int_1",
      #   reason: "input_required",
      #   message: "Please provide additional information"
      # )
      #
      # ```
      class Interrupt < Model
        sig { returns(String) }
        attr_reader :id

        sig { returns(String) }
        attr_reader :reason

        sig { returns(T.nilable(String)) }
        attr_reader :message

        sig { returns(T.nilable(String)) }
        attr_reader :tool_call_id

        sig { returns(T.untyped) }
        attr_reader :response_schema

        sig { returns(T.nilable(String)) }
        attr_reader :expires_at

        sig { returns(T.untyped) }
        attr_reader :metadata

        # @param id [String] Unique identifier
        # @param reason [String] Reason for the interrupt
        # @param message [String] Human-readable message
        # @param tool_call_id [String] Associated tool call if applicable
        # @param response_schema [Object] JSON schema for response
        # @param expires_at [String] ISO timestamp when interrupt expires
        # @param metadata [Object] Arbitrary metadata
        sig do
          params(
            id: String,
            reason: String,
            message: T.nilable(String),
            tool_call_id: T.nilable(String),
            response_schema: T.untyped,
            expires_at: T.nilable(String),
            metadata: T.untyped
          ).void
        end
        def initialize(id:, reason:, message: nil, tool_call_id: nil, response_schema: nil, expires_at: nil, metadata: nil)
          @id = id
          @reason = reason
          @message = message
          @tool_call_id = tool_call_id
          @response_schema = response_schema
          @expires_at = expires_at
          @metadata = metadata
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            id: @id,
            reason: @reason,
            message: @message,
            tool_call_id: @tool_call_id,
            # `response_schema` is a JSON Schema document supplied by the user — preserve keys verbatim.
            response_schema: @response_schema.nil? ? nil : AgUiProtocol::Util::Opaque.new(@response_schema),
            expires_at: @expires_at,
            # `metadata` is arbitrary user-defined key/value data — preserve keys verbatim.
            metadata: @metadata.nil? ? nil : AgUiProtocol::Util::Opaque.new(@metadata)
          }
        end
      end

      # Represents an entry for resuming an interrupted run.
      #
      # ```ruby
      #
      # entry = AgUiProtocol::Core::Types::ResumeEntry.new(
      #   interrupt_id: "int_1",
      #   status: "resolved",
      #   payload: { "answer" => "42" }
      # )
      #
      # ```
      class ResumeEntry < Model
        sig { returns(String) }
        attr_reader :interrupt_id

        # Free-form string; protocol values are "resolved" or "cancelled" but not enforced by this SDK.
        sig { returns(T.nilable(String)) }
        attr_reader :status

        sig { returns(T.untyped) }
        attr_reader :payload

        # @param interrupt_id [String] ID of the interrupt being resolved
        # @param status [String] Resolution status (free-form; protocol values are "resolved" or "cancelled")
        # @param payload [Object] Response payload for the interrupt
        sig { params(interrupt_id: String, status: T.nilable(String), payload: T.untyped).void }
        def initialize(interrupt_id:, status: nil, payload: nil)
          @interrupt_id = interrupt_id
          @status = status
          @payload = payload
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            interrupt_id: @interrupt_id,
            status: @status,
            # `payload` is the user's resume response — preserve keys verbatim.
            payload: @payload.nil? ? nil : AgUiProtocol::Util::Opaque.new(@payload)
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

        sig { returns(T::Array[T.any(BaseMessage, ActivityMessage)]) }
        attr_reader :messages

        sig { returns(T::Array[Tool]) }
        attr_reader :tools

        sig { returns(T::Array[Context]) }
        attr_reader :context

        sig { returns(T.untyped) }
        attr_reader :forwarded_props

        sig { returns(T.nilable(T::Array[ResumeEntry])) }
        attr_reader :resume

        # @param thread_id [String] ID of the conversation thread
        # @param run_id [String] ID of the current run
        # @param state [Object] Current state of the agent
        # @param messages [Array<BaseMessage, ActivityMessage>] List of messages in the conversation
        # @param tools [Array<Tool>] List of tools available to the agent
        # @param context [Array<Context>] List of context objects provided to the agent
        # @param forwarded_props [Object] Additional properties forwarded to the agent
        # @param parent_run_id [String] Lineage pointer for branching/time travel
        # @param resume [Array<ResumeEntry>] Entries for resuming interrupted runs
        # @raise [ArgumentError] if messages is not an Array of BaseMessage or ActivityMessage
        sig do
          params(
            thread_id: String,
            run_id: String,
            state: T.untyped,
            messages: T::Array[T.any(BaseMessage, ActivityMessage)],
            tools: T::Array[Tool],
            context: T::Array[Context],
            forwarded_props: T.untyped,
            parent_run_id: T.nilable(String),
            resume: T.nilable(T::Array[ResumeEntry])
          ).void.checked(:always)
        end
        def initialize(thread_id:, run_id:, state:, messages:, tools:, context:, forwarded_props:, parent_run_id: nil, resume: nil)
          unless messages.is_a?(Array) && messages.all? { |m| m.is_a?(BaseMessage) || m.is_a?(ActivityMessage) }
            raise ArgumentError, "messages must be an Array of BaseMessage or ActivityMessage"
          end
          unless tools.is_a?(Array) && tools.all? { |m| m.is_a?(Tool) }
            raise ArgumentError, "tools must be an Array of Tool"
          end
          unless context.is_a?(Array) && context.all? { |m| m.is_a?(Context) }
            raise ArgumentError, "context must be an Array of Context"
          end
          unless resume.nil? || (resume.is_a?(Array) && resume.all? { |r| r.is_a?(ResumeEntry) })
            raise ArgumentError, "resume must be an Array of ResumeEntry"
          end

          @thread_id = thread_id
          @run_id = run_id
          @parent_run_id = parent_run_id
          @state = state
          @messages = messages
          @tools = tools
          @context = context
          @forwarded_props = forwarded_props
          @resume = resume
        end

        sig { returns(T::Hash[Symbol, T.untyped]) }
        def to_h
          {
            thread_id: @thread_id,
            run_id: @run_id,
            parent_run_id: @parent_run_id,
            # `state` is the agent's user-defined state object — preserve keys verbatim.
            state: @state.nil? ? nil : AgUiProtocol::Util::Opaque.new(@state),
            messages: @messages,
            tools: @tools,
            context: @context,
            # `forwarded_props` is arbitrary user-defined key/value data — preserve keys verbatim.
            forwarded_props: @forwarded_props.nil? ? nil : AgUiProtocol::Util::Opaque.new(@forwarded_props),
            resume: @resume
          }
        end
      end
    end
  end
end
