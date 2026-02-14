# typed: true
# frozen_string_literal: true

require "json"
require "sorbet-runtime"

module AgUiProtocol
  # The Agent User Interaction Protocol uses a streaming approach to send events
  # from agents to clients. The `EventEncoder` class provides the functionality to
  # encode events into a format that can be sent over HTTP.
  module Encoder
    # Media type for AGUI events
    AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto"

    # The `EventEncoder` class is responsible for encoding `BaseEvent` objects into
    # string representations that can be transmitted to clients.
    #
    # ```ruby
    #
    # require "ag_ui_protocol"
    #
    # encoder = AgUiProtocol::EventEncoder.new
    #
    # event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(
    #   message_id: "msg_123",
    #   delta: "Hello, world!"
    # )
    #
    # encoded = encoder.encode(event)
    #
    # ```
    #
    # ### Usage
    #
    # The `EventEncoder` is typically used in HTTP handlers to convert event objects
    # into a stream of data. The current implementation encodes events as Server-Sent
    # Events (SSE), which can be consumed by clients using the EventSource API.
    #
    # ### Implementation Details
    #
    # Internally, the encoder converts events to JSON and formats them as Server-Sent
    # Events with the following structure:
    #
    # ```
    # data: {json-serialized event}\n\n
    # ```
    #
    # This format allows clients to receive a continuous stream of events and process
    # them as they arrive.
    #
    class EventEncoder
      extend T::Sig

      # Creates a new encoder instance.
      #
      # @param accept [String, nil] Media type of the request
      # @return [void]
      sig { params(accept: T.nilable(String)).void }
      def initialize(accept: nil)
        @accept = accept
      end

      # Returns the content type of the encoder.
      #
      # @return [String] The content type of the encoder
      sig { returns(String) }
      def content_type
        @accept || "text/event-stream"
      end

      # Encodes an event into a string representation.
      #
      # @param event [Object] The event to encode
      # @return [String] A string representation of the event in SSE format.
      sig { params(event: AgUiProtocol::Core::Types::Model).returns(String) }
      def encode(event)
        payload = event.as_json

        "data: #{JSON.generate(payload)}\n\n"
      end
    end
  end
end
