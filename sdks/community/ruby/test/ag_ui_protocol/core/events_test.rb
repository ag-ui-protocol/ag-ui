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

      should "serialize Time timestamp as epoch milliseconds (Integer)" do
        t = Time.utc(2026, 5, 26, 12, 0, 0)
        event = AgUiProtocol::Core::Events::BaseEvent.new(
          type: AgUiProtocol::Core::Events::EventType::RAW, timestamp: t
        )
        payload = JSON.parse(event.to_json)
        assert_kind_of Integer, payload["timestamp"]
        assert_equal 1779796800000, payload["timestamp"]
      end

      should "serialize non-UTC Time as the equivalent epoch milliseconds" do
        t = Time.new(2026, 5, 26, 5, 0, 0, "-07:00") # equivalent to 12:00 UTC
        event = AgUiProtocol::Core::Events::BaseEvent.new(
          type: AgUiProtocol::Core::Events::EventType::RAW, timestamp: t
        )
        payload = JSON.parse(event.to_json)
        assert_equal 1779796800000, payload["timestamp"]
      end

      should "serialize timestamp on a concrete event subclass (RunStartedEvent)" do
        input = AgUiProtocol::Core::Types::RunAgentInput.new(
          thread_id: "t1", run_id: "r1", state: {},
          messages: [], tools: [], context: [], forwarded_props: {}
        )
        event = AgUiProtocol::Core::Events::RunStartedEvent.new(
          thread_id: "t1", run_id: "r1", input: input,
          timestamp: Time.utc(2026, 5, 26, 12, 0, 0)
        )
        payload = JSON.parse(event.to_json)
        assert_equal 1779796800000, payload["timestamp"]
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

      should "preserve user-supplied keys verbatim in snapshot" do
        event = AgUiProtocol::Core::Events::StateSnapshotEvent.new(
          snapshot: { "user_state" => { "agent_id" => "x", "feature_flag" => true } }
        )
        payload = JSON.parse(event.to_json)
        assert_equal "x", payload["snapshot"]["user_state"]["agent_id"]
        assert_equal true, payload["snapshot"]["user_state"]["feature_flag"]
        refute payload["snapshot"].key?("userState")
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

      should "preserve user-supplied keys verbatim inside JSON Patch op values" do
        # RFC 6902 JSON Patch ops may carry arbitrary user payloads in `value`;
        # nested keys must NOT be camelized on the wire.
        event = AgUiProtocol::Core::Events::StateDeltaEvent.new(
          delta: [
            { "op" => "replace", "path" => "/user_state", "value" => { "agent_id" => "x", "feature_flag" => true } }
          ]
        )
        payload = JSON.parse(event.to_json)
        op = payload["delta"][0]
        assert_equal "replace", op["op"]
        assert_equal "/user_state", op["path"]
        assert_equal "x", op["value"]["agent_id"]
        assert_equal true, op["value"]["feature_flag"]
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

      should "accept ActivityMessage entries alongside BaseMessage" do
        base = AgUiProtocol::Core::Types::DeveloperMessage.new(id: "d1", content: "hi")
        activity = AgUiProtocol::Core::Types::ActivityMessage.new(
          id: "a1", activity_type: "progress", content: { "pct" => 10 }
        )
        event = AgUiProtocol::Core::Events::MessagesSnapshotEvent.new(messages: [base, activity])
        payload = JSON.parse(event.to_json)
        assert_equal "MESSAGES_SNAPSHOT", payload["type"]
        assert_equal 2, payload["messages"].length
        assert_equal "d1", payload["messages"][0]["id"]
        assert_equal "a1", payload["messages"][1]["id"]
        assert_equal "activity", payload["messages"][1]["role"]
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

      should "preserve user-supplied keys verbatim in event payload" do
        event = AgUiProtocol::Core::Events::RawEvent.new(
          event: { "upstream_id" => "abc", "raw_data" => { "deep_key" => 1 } },
          source: "openai"
        )
        payload = JSON.parse(event.to_json)
        assert_equal "abc", payload["event"]["upstream_id"]
        assert_equal 1, payload["event"]["raw_data"]["deep_key"]
        refute payload["event"].key?("upstreamId")
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

      should "preserve user-supplied keys verbatim in value payload" do
        event = AgUiProtocol::Core::Events::CustomEvent.new(
          name: "my_event",
          value: { "user_data" => { "agent_id" => "x", "feature_flag" => true } }
        )
        payload = JSON.parse(event.to_json)
        assert_equal "x", payload["value"]["user_data"]["agent_id"]
        assert_equal true, payload["value"]["user_data"]["feature_flag"]
        refute payload["value"].key?("userData")
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

      should "support success outcome" do
        outcome = AgUiProtocol::Core::Events::RunFinishedSuccessOutcome.new
        event = AgUiProtocol::Core::Events::RunFinishedEvent.new(
          thread_id: "t1", run_id: "r1", outcome: outcome
        )
        assert_event_payload(
          event,
          { "type" => "RUN_FINISHED", "threadId" => "t1", "runId" => "r1", "outcome" => { "type" => "success" } }
        )
      end

      should "support interrupt outcome" do
        interrupt = AgUiProtocol::Core::Types::Interrupt.new(id: "int1", reason: "input_required")
        outcome = AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new(interrupts: [interrupt])
        event = AgUiProtocol::Core::Events::RunFinishedEvent.new(
          thread_id: "t1", run_id: "r1", outcome: outcome
        )
        payload = JSON.parse(event.to_json)
        assert_equal "interrupt", payload["outcome"]["type"]
        assert_equal "int1", payload["outcome"]["interrupts"][0]["id"]
      end

      should "omit outcome when nil" do
        event = AgUiProtocol::Core::Events::RunFinishedEvent.new(thread_id: "t1", run_id: "r1")
        payload = JSON.parse(event.to_json)
        refute payload.key?("outcome")
      end

      should "raise when both result and outcome are set" do
        outcome = AgUiProtocol::Core::Events::RunFinishedSuccessOutcome.new
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunFinishedEvent.new(
            thread_id: "t1", run_id: "r1", result: { "ok" => true }, outcome: outcome
          )
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

    context "ReasoningStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningStartEvent.new(message_id: "r1")
        assert_event_payload(event, { "type" => "REASONING_START", "messageId" => "r1" })
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningStartEvent.new
        end
      end
    end

    context "ReasoningMessageStartEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningMessageStartEvent.new(message_id: "rm1")
        assert_event_payload(
          event,
          { "type" => "REASONING_MESSAGE_START", "messageId" => "rm1", "role" => "reasoning" }
        )
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningMessageStartEvent.new
        end
      end

      should "accept role: \"reasoning\" for round-trip compatibility" do
        event = AgUiProtocol::Core::Events::ReasoningMessageStartEvent.new(message_id: "rm1", role: "reasoning")
        assert_equal "reasoning", event.role
      end

      should "raise when role is not \"reasoning\"" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningMessageStartEvent.new(message_id: "rm1", role: "user")
        end
      end
    end

    context "ReasoningMessageContentEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningMessageContentEvent.new(message_id: "rm1", delta: "step 1")
        assert_event_payload(
          event,
          { "type" => "REASONING_MESSAGE_CONTENT", "messageId" => "rm1", "delta" => "step 1" }
        )
      end

      should "raise when delta is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningMessageContentEvent.new(message_id: "rm1")
        end
      end
    end

    context "ReasoningMessageEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningMessageEndEvent.new(message_id: "rm1")
        assert_event_payload(event, { "type" => "REASONING_MESSAGE_END", "messageId" => "rm1" })
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningMessageEndEvent.new
        end
      end
    end

    context "ReasoningMessageChunkEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningMessageChunkEvent.new(message_id: "rm1", delta: "step 1")
        assert_event_payload(
          event,
          { "type" => "REASONING_MESSAGE_CHUNK", "messageId" => "rm1", "delta" => "step 1" }
        )
      end

      should "work with nil fields" do
        event = AgUiProtocol::Core::Events::ReasoningMessageChunkEvent.new
        assert_event_payload(event, { "type" => "REASONING_MESSAGE_CHUNK" })
      end
    end

    context "ReasoningEndEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningEndEvent.new(message_id: "r1")
        assert_event_payload(event, { "type" => "REASONING_END", "messageId" => "r1" })
      end

      should "raise when message_id is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningEndEvent.new
        end
      end
    end

    context "ReasoningEncryptedValueEvent" do
      should "serialize with type" do
        event = AgUiProtocol::Core::Events::ReasoningEncryptedValueEvent.new(
          subtype: "tool-call", entity_id: "tc1", encrypted_value: "enc"
        )
        assert_event_payload(
          event,
          { "type" => "REASONING_ENCRYPTED_VALUE", "subtype" => "tool-call", "entityId" => "tc1", "encryptedValue" => "enc" }
        )
      end

      should "raise when subtype is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::ReasoningEncryptedValueEvent.new(entity_id: "tc1", encrypted_value: "enc")
        end
      end
    end

    context "RunFinishedSuccessOutcome" do
      should "serialize with type" do
        outcome = AgUiProtocol::Core::Events::RunFinishedSuccessOutcome.new
        payload = JSON.parse(outcome.to_json)
        assert_equal "success", payload["type"]
      end

      should "accept type: \"success\" for round-trip compatibility" do
        outcome = AgUiProtocol::Core::Events::RunFinishedSuccessOutcome.new(type: "success")
        assert_equal "success", outcome.type
      end

      should "raise when type is not \"success\"" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunFinishedSuccessOutcome.new(type: "interrupt")
        end
      end
    end

    context "RunFinishedInterruptOutcome" do
      should "serialize with type" do
        interrupt = AgUiProtocol::Core::Types::Interrupt.new(id: "int1", reason: "input_required")
        outcome = AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new(interrupts: [interrupt])
        payload = JSON.parse(outcome.to_json)
        assert_equal "interrupt", payload["type"]
        assert_equal "int1", payload["interrupts"][0]["id"]
      end

      should "raise when interrupts is missing" do
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new
        end
      end

      should "accept type: \"interrupt\" for round-trip compatibility" do
        interrupt = AgUiProtocol::Core::Types::Interrupt.new(id: "int1", reason: "input_required")
        outcome = AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new(interrupts: [interrupt], type: "interrupt")
        assert_equal "interrupt", outcome.type
      end

      should "raise when type is not \"interrupt\"" do
        interrupt = AgUiProtocol::Core::Types::Interrupt.new(id: "int1", reason: "input_required")
        assert_raises(ArgumentError) do
          AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new(interrupts: [interrupt], type: "success")
        end
      end

      should "raise when interrupts contains non-Interrupt entries" do
        # sorbet-runtime catches T::Array[Interrupt] violations with a TypeError;
        # accept either ArgumentError (our runtime check) or TypeError (sig check).
        assert_raises(ArgumentError, TypeError) do
          AgUiProtocol::Core::Events::RunFinishedInterruptOutcome.new(interrupts: ["not_an_interrupt"])
        end
      end
    end

    context "EventType" do
      should "include reasoning constants" do
        assert_equal "REASONING_START", AgUiProtocol::Core::Events::EventType::REASONING_START
        assert_equal "REASONING_MESSAGE_START", AgUiProtocol::Core::Events::EventType::REASONING_MESSAGE_START
        assert_equal "REASONING_MESSAGE_CONTENT", AgUiProtocol::Core::Events::EventType::REASONING_MESSAGE_CONTENT
        assert_equal "REASONING_MESSAGE_END", AgUiProtocol::Core::Events::EventType::REASONING_MESSAGE_END
        assert_equal "REASONING_MESSAGE_CHUNK", AgUiProtocol::Core::Events::EventType::REASONING_MESSAGE_CHUNK
        assert_equal "REASONING_END", AgUiProtocol::Core::Events::EventType::REASONING_END
        assert_equal "REASONING_ENCRYPTED_VALUE", AgUiProtocol::Core::Events::EventType::REASONING_ENCRYPTED_VALUE
      end
    end

    context "TEXT_MESSAGE_ROLE_VALUES" do
      should "include reasoning" do
        assert_includes AgUiProtocol::Core::Events::TEXT_MESSAGE_ROLE_VALUES, "reasoning"
      end
    end

  end

  def assert_event_payload(event, expected)
    payload = JSON.parse(event.to_json)
    assert_equal expected, payload
  end
end
