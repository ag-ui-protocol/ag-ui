require "test_helper"
require "json"

class EventsTest < Minitest::Test
  context "AgUiProtocol::Core::Events" do
    context "BaseEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::BaseEvent.new(type: AgUiProtocol::Core::Events::EventType::RAW)
        assert_event_payload(event, { "type" => "RAW" })
      end

      should "raise when type is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::BaseEvent.new
        end
      end
    end

    context "TextMessageStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::TextMessageStartEvent.new(message_id: "m1")
        assert_event_payload(event, { "type" => "TEXT_MESSAGE_START", "messageId" => "m1", "role" => "assistant" })
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::TextMessageStartEvent.new
        end
      end
    end

    context "TextMessageContentEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::TextMessageContentEvent.new(message_id: "m1", delta: "hi")
        assert_event_payload(event, { "type" => "TEXT_MESSAGE_CONTENT", "messageId" => "m1", "delta" => "hi" })
      end

      should "raise when delta is empty" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::TextMessageContentEvent.new(message_id: "m1", delta: "")
        end
      end
    end

    context "TextMessageEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::TextMessageEndEvent.new(message_id: "m1")
        assert_event_payload(event, { "type" => "TEXT_MESSAGE_END", "messageId" => "m1" })
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::TextMessageEndEvent.new
        end
      end
    end

    context "TextMessageChunkEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::TextMessageChunkEvent.new(message_id: "m1", role: "assistant", delta: "hi")
        assert_event_payload(
          event,
          { "type" => "TEXT_MESSAGE_CHUNK", "messageId" => "m1", "role" => "assistant", "delta" => "hi" }
        )
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::TextMessageChunkEvent.new(unknown: 1)
        end
      end
    end

    context "ThinkingTextMessageStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ThinkingTextMessageStartEvent.new
        assert_event_payload(event, { "type" => "THINKING_TEXT_MESSAGE_START" })
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ThinkingTextMessageStartEvent.new(unknown: 1)
        end
      end
    end

    context "ThinkingTextMessageContentEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ThinkingTextMessageContentEvent.new(delta: "thinking")
        assert_event_payload(event, { "type" => "THINKING_TEXT_MESSAGE_CONTENT", "delta" => "thinking" })
      end

      should "raise when delta is empty" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ThinkingTextMessageContentEvent.new(delta: "")
        end
      end
    end

    context "ThinkingTextMessageEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ThinkingTextMessageEndEvent.new
        assert_event_payload(event, { "type" => "THINKING_TEXT_MESSAGE_END" })
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ThinkingTextMessageEndEvent.new(unknown: 1)
        end
      end
    end

    context "ToolCallStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ToolCallStartEvent.new(tool_call_id: "tc1", tool_call_name: "search")
        assert_event_payload(event, { "type" => "TOOL_CALL_START", "toolCallId" => "tc1", "toolCallName" => "search" })
      end

      should "raise when tool_call_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ToolCallStartEvent.new(tool_call_name: "search")
        end
      end
    end

    context "ToolCallArgsEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ToolCallArgsEvent.new(tool_call_id: "tc1", delta: "{}")
        assert_event_payload(event, { "type" => "TOOL_CALL_ARGS", "toolCallId" => "tc1", "delta" => "{}" })
      end

      should "raise when tool_call_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ToolCallArgsEvent.new(delta: "{}")
        end
      end
    end

    context "ToolCallEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ToolCallEndEvent.new(tool_call_id: "tc1")
        assert_event_payload(event, { "type" => "TOOL_CALL_END", "toolCallId" => "tc1" })
      end

      should "raise when tool_call_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ToolCallEndEvent.new
        end
      end
    end

    context "ToolCallChunkEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ToolCallChunkEvent.new(tool_call_id: "tc1", tool_call_name: "search", delta: "{}")
        assert_event_payload(
          event,
          { "type" => "TOOL_CALL_CHUNK", "toolCallId" => "tc1", "toolCallName" => "search", "delta" => "{}" }
        )
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ToolCallChunkEvent.new(unknown: 1)
        end
      end
    end

    context "ToolCallResultEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ToolCallResultEvent.new(message_id: "m1", tool_call_id: "tc1", content: "ok")
        assert_event_payload(
          event,
          { "type" => "TOOL_CALL_RESULT", "messageId" => "m1", "toolCallId" => "tc1", "content" => "ok" }
        )
      end

      should "raise when content is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ToolCallResultEvent.new(message_id: "m1", tool_call_id: "tc1")
        end
      end
    end

    context "ThinkingStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ThinkingStartEvent.new(title: "step")
        assert_event_payload(event, { "type" => "THINKING_START", "title" => "step" })
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ThinkingStartEvent.new(unknown: 1)
        end
      end
    end

    context "ThinkingEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ThinkingEndEvent.new
        assert_event_payload(event, { "type" => "THINKING_END" })
      end

      should "raise when unknown keyword is provided" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ThinkingEndEvent.new(unknown: 1)
        end
      end
    end

    context "StateSnapshotEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::StateSnapshotEvent.new(snapshot: { "a" => 1 })
        assert_event_payload(event, { "type" => "STATE_SNAPSHOT", "snapshot" => { "a" => 1 } })
      end

      should "raise when snapshot is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::StateSnapshotEvent.new
        end
      end
    end

    context "StateDeltaEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::StateDeltaEvent.new(delta: [{ "op" => "add", "path" => "/a", "value" => 1 }])
        assert_event_payload(
          event,
          { "type" => "STATE_DELTA", "delta" => [{ "op" => "add", "path" => "/a", "value" => 1 }] }
        )
      end

      should "raise when delta is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::StateDeltaEvent.new
        end
      end
    end

    context "MessagesSnapshotEvent" do
      should "serialize with type" do
        msgs = [AgUiProtocol::Core::Types::DeveloperMessage.new(id: "d1", content: "hi")]
        event = AgUiProtocol::Core::Events::MessagesSnapshotEvent.new(messages: msgs)
        assert_event_payload(
          event,
          { "type" => "MESSAGES_SNAPSHOT", "messages" => [{ "id" => "d1", "role" => "developer", "content" => "hi" }] }
        )
      end

      should "raise when messages is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::MessagesSnapshotEvent.new
        end
      end

      should "raise when messages is not an array of BaseMessage" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::MessagesSnapshotEvent.new(messages: [1])
        end
      end
    end

    context "ActivitySnapshotEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ActivitySnapshotEvent.new(message_id: "a1", activity_type: "progress", content: { "pct" => 10 })
        assert_event_payload(
          event,
          {
            "type" => "ACTIVITY_SNAPSHOT",
            "messageId" => "a1",
            "activityType" => "progress",
            "content" => { "pct" => 10 },
            "replace" => true
          }
        )
      end

      should "raise when content is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ActivitySnapshotEvent.new(message_id: "a1", activity_type: "progress")
        end
      end
    end

    context "ActivityDeltaEvent" do
      should "serialize with type" do
        patch = [{ "op" => "replace", "path" => "/pct", "value" => 20 }]
        event = AgUiProtocol::Core::Events::ActivityDeltaEvent.new(message_id: "a1", activity_type: "progress", patch: patch)
        assert_event_payload(
          event,
          { "type" => "ACTIVITY_DELTA", "messageId" => "a1", "activityType" => "progress", "patch" => patch }
        )
      end

      should "raise when patch is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ActivityDeltaEvent.new(message_id: "a1", activity_type: "progress")
        end
      end
    end

    context "RawEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::RawEvent.new(event: { "x" => 1 }, source: "sdk")
        assert_event_payload(event, { "type" => "RAW", "event" => { "x" => 1 }, "source" => "sdk" })
      end

      should "raise when event is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RawEvent.new
        end
      end
    end

    context "CustomEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::CustomEvent.new(name: "custom", value: { "x" => 1 })
        assert_event_payload(event, { "type" => "CUSTOM", "name" => "custom", "value" => { "x" => 1 } })
      end

      should "raise when value is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::CustomEvent.new(name: "custom")
        end
      end
    end

    context "RunStartedEvent" do
      should "serialize with type" do
        input = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1",
          run_id: "r1",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwarded_props: {}
        )
        event = AgUiProtocol::Core::Events::RunStartedEvent.new(thread_id: "t1", run_id: "r1", input: input)
        assert_event_payload(
          event,
          {
            "type" => "RUN_STARTED",
            "threadId" => "t1",
            "runId" => "r1",
            "input" => {
              "threadId" => "t1",
              "runId" => "r1",
              "state" => {},
              "messages" => [],
              "tools" => [],
              "context" => [],
              "forwardedProps" => {}
            }
          }
        )
      end

      should "raise when run_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunStartedEvent.new(thread_id: "t1")
        end
      end
    end

    context "RunFinishedEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::RunFinishedEvent.new(thread_id: "t1", run_id: "r1", result: { "ok" => true })
        assert_event_payload(
          event,
          { "type" => "RUN_FINISHED", "threadId" => "t1", "runId" => "r1", "result" => { "ok" => true } }
        )
      end

      should "raise when thread_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunFinishedEvent.new(run_id: "r1")
        end
      end
    end

    context "RunErrorEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::RunErrorEvent.new(message: "boom", code: "ERR")
        assert_event_payload(event, { "type" => "RUN_ERROR", "message" => "boom", "code" => "ERR" })
      end

      should "raise when message is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunErrorEvent.new
        end
      end
    end

    context "StepStartedEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::StepStartedEvent.new(step_name: "s1")
        assert_event_payload(event, { "type" => "STEP_STARTED", "stepName" => "s1" })
      end

      should "raise when step_name is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::StepStartedEvent.new
        end
      end
    end

    context "StepFinishedEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::StepFinishedEvent.new(step_name: "s1")
        assert_event_payload(event, { "type" => "STEP_FINISHED", "stepName" => "s1" })
      end

      should "raise when step_name is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::StepFinishedEvent.new
        end
      end
    end
  end

  def assert_event_payload(event, expected)
    payload = JSON.parse(event.to_json)
    assert_equal expected, payload
  end
end
