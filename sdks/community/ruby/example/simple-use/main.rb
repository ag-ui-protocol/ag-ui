require "ag_ui_protocol"

def send_message(message_id, content, stream)
    encoder = AgUiProtocol::Encoder::EventEncoder.new

    text_message_start_event = AgUiProtocol::Core::Events::TextMessageStartEvent.new(
        message_id: message_id,
    )
    text_message_start_event_sse = encoder.encode(text_message_start_event)
    stream.write(text_message_start_event_sse)

    text_message_content_event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(
        message_id: message_id,
        delta: content,
    )
    text_message_content_event_sse = encoder.encode(text_message_content_event)
    stream.write(text_message_content_event_sse)

    text_message_end_event = AgUiProtocol::Core::Events::TextMessageEndEvent.new(
        message_id: message_id,
    )
    text_message_end_event_sse = encoder.encode(text_message_end_event)
    stream.write(text_message_end_event_sse)
end

send_message("msg_123", "Hello from Ruby!", $stdout)