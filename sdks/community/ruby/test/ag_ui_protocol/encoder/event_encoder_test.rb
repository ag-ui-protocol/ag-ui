require "test_helper"
require "json"

class EventEncoderTest < Minitest::Test
  context "when encoding events" do
    should "return text/event-stream content type" do
      encoder = AgUiProtocol::EventEncoder.new
      assert_equal "text/event-stream", encoder.content_type
    end

    should "encode SSE with data prefix and double newline" do
      encoder = AgUiProtocol::EventEncoder.new
      event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(message_id: "m1", delta: "hi")

      sse = encoder.encode(event)

      assert sse.start_with?("data: ")
      assert sse.end_with?("\n\n")
    end

    should "encode camelCase keys and exclude nil values" do
      encoder = AgUiProtocol::EventEncoder.new
      event = AgUiProtocol::Core::Events::ToolCallStartEvent.new(
        tool_call_id: "tc1",
        tool_call_name: "search",
        parent_message_id: nil
      )

      sse = encoder.encode(event)
      json = sse.sub(/^data: /, "").strip

      payload = JSON.parse(json)

      assert_equal "TOOL_CALL_START", payload["type"]
      assert_equal "tc1", payload["toolCallId"]
      assert_equal "search", payload["toolCallName"]
      refute payload.key?("parentMessageId")
    end

    should "raise when encoding a non-serializable object" do
      encoder = AgUiProtocol::EventEncoder.new
      assert_raises(TypeError) do
        encoder.encode(Float::NAN)
      end
    end
  end
end
