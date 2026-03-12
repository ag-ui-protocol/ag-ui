defmodule AgUi.Core.EventsTest do
  use ExUnit.Case, async: true

  alias AgUi.Core.Events
  alias AgUi.Core.Events.{
    EventType,
    RunStarted, RunFinished, RunError,
    StepStarted, StepFinished,
    TextMessageStart, TextMessageContent, TextMessageEnd, TextMessageChunk,
    ThinkingTextMessageStart, ThinkingTextMessageContent, ThinkingTextMessageEnd,
    ToolCallStart, ToolCallArgs, ToolCallEnd, ToolCallResult,
    StateSnapshot, StateDelta, MessagesSnapshot,
    ActivitySnapshot, ActivityDelta,
    ReasoningStart, ReasoningMessageStart, ReasoningMessageContent,
    ReasoningMessageEnd, ReasoningMessageChunk, ReasoningEnd, ReasoningEncryptedValue,
    Raw, Custom
  }

  # -- EventType --------------------------------------------------------------

  describe "EventType" do
    test "all/0 returns 33 event types" do
      assert length(EventType.all()) == 33
    end

    test "valid?/1 recognizes known types" do
      assert EventType.valid?("RUN_STARTED")
      assert EventType.valid?("TEXT_MESSAGE_CONTENT")
      assert EventType.valid?("REASONING_ENCRYPTED_VALUE")
      refute EventType.valid?("INVALID_TYPE")
    end
  end

  # -- Lifecycle Events -------------------------------------------------------

  describe "RunStarted" do
    test "creates with required fields" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert event.type == "RUN_STARTED"
      assert event.thread_id == "t1"
      assert event.run_id == "r1"
      assert event.parent_run_id == nil
      assert event.input == nil
    end

    test "type_of/1 returns correct type" do
      assert Events.type_of(%RunStarted{thread_id: "t1", run_id: "r1"}) == "RUN_STARTED"
    end
  end

  describe "RunFinished" do
    test "creates with required fields" do
      event = %RunFinished{thread_id: "t1", run_id: "r1"}
      assert event.type == "RUN_FINISHED"
      assert event.result == nil
    end

    test "creates with optional result" do
      event = %RunFinished{thread_id: "t1", run_id: "r1", result: %{summary: "done"}}
      assert event.result == %{summary: "done"}
    end
  end

  describe "RunError" do
    test "creates with message" do
      event = %RunError{message: "something broke"}
      assert event.type == "RUN_ERROR"
      assert event.message == "something broke"
      assert event.code == nil
    end

    test "creates with optional code" do
      event = %RunError{message: "timeout", code: "TIMEOUT"}
      assert event.code == "TIMEOUT"
    end
  end

  describe "StepStarted/StepFinished" do
    test "creates step events" do
      started = %StepStarted{step_name: "planning"}
      finished = %StepFinished{step_name: "planning"}
      assert started.type == "STEP_STARTED"
      assert finished.type == "STEP_FINISHED"
      assert started.step_name == "planning"
    end
  end

  # -- Text Message Events ----------------------------------------------------

  describe "TextMessageStart" do
    test "defaults role to assistant" do
      event = %TextMessageStart{message_id: "m1"}
      assert event.role == "assistant"
      assert event.type == "TEXT_MESSAGE_START"
    end
  end

  describe "TextMessageContent" do
    test "requires message_id and delta" do
      event = %TextMessageContent{message_id: "m1", delta: "Hello"}
      assert event.delta == "Hello"
      assert event.type == "TEXT_MESSAGE_CONTENT"
    end
  end

  describe "TextMessageEnd" do
    test "requires message_id" do
      event = %TextMessageEnd{message_id: "m1"}
      assert event.type == "TEXT_MESSAGE_END"
    end
  end

  describe "TextMessageChunk" do
    test "all fields optional" do
      event = %TextMessageChunk{}
      assert event.type == "TEXT_MESSAGE_CHUNK"
      assert event.message_id == nil
      assert event.delta == nil
    end

    test "creates with all fields" do
      event = %TextMessageChunk{message_id: "m1", role: "assistant", delta: "Hi"}
      assert event.message_id == "m1"
      assert event.role == "assistant"
    end
  end

  # -- Thinking Text Events ---------------------------------------------------

  describe "ThinkingTextMessage events" do
    test "creates start/content/end" do
      assert %ThinkingTextMessageStart{}.type == "THINKING_TEXT_MESSAGE_START"
      assert %ThinkingTextMessageContent{delta: "thinking..."}.type == "THINKING_TEXT_MESSAGE_CONTENT"
      assert %ThinkingTextMessageEnd{}.type == "THINKING_TEXT_MESSAGE_END"
    end
  end

  # -- Tool Call Events -------------------------------------------------------

  describe "ToolCallStart" do
    test "creates with required fields" do
      event = %ToolCallStart{tool_call_id: "tc1", tool_call_name: "search"}
      assert event.type == "TOOL_CALL_START"
      assert event.tool_call_id == "tc1"
      assert event.tool_call_name == "search"
    end
  end

  describe "ToolCallArgs" do
    test "creates with delta" do
      event = %ToolCallArgs{tool_call_id: "tc1", delta: ~s({"q":"test"})}
      assert event.type == "TOOL_CALL_ARGS"
    end
  end

  describe "ToolCallEnd" do
    test "creates with tool_call_id" do
      event = %ToolCallEnd{tool_call_id: "tc1"}
      assert event.type == "TOOL_CALL_END"
    end
  end

  describe "ToolCallResult" do
    test "creates with required fields" do
      event = %ToolCallResult{message_id: "m1", tool_call_id: "tc1", content: "ok"}
      assert event.type == "TOOL_CALL_RESULT"
      assert event.role == nil
    end

    test "creates with tool role" do
      event = %ToolCallResult{message_id: "m1", tool_call_id: "tc1", content: "ok", role: "tool"}
      assert event.role == "tool"
    end
  end

  # -- State Management Events ------------------------------------------------

  describe "StateSnapshot" do
    test "creates with snapshot data" do
      event = %StateSnapshot{snapshot: %{count: 42}}
      assert event.type == "STATE_SNAPSHOT"
      assert event.snapshot == %{count: 42}
    end
  end

  describe "StateDelta" do
    test "creates with JSON Patch operations" do
      patch = [%{"op" => "replace", "path" => "/count", "value" => 43}]
      event = %StateDelta{delta: patch}
      assert event.type == "STATE_DELTA"
      assert length(event.delta) == 1
    end
  end

  describe "MessagesSnapshot" do
    test "creates with message list" do
      event = %MessagesSnapshot{messages: []}
      assert event.type == "MESSAGES_SNAPSHOT"
    end
  end

  # -- Activity Events --------------------------------------------------------

  describe "ActivitySnapshot" do
    test "creates with defaults" do
      event = %ActivitySnapshot{message_id: "m1", activity_type: "PLAN", content: %{}}
      assert event.type == "ACTIVITY_SNAPSHOT"
      assert event.replace == true
    end
  end

  describe "ActivityDelta" do
    test "creates with patch" do
      event = %ActivityDelta{
        message_id: "m1",
        activity_type: "PLAN",
        patch: [%{"op" => "add", "path" => "/step", "value" => "done"}]
      }
      assert event.type == "ACTIVITY_DELTA"
    end
  end

  # -- Reasoning Events -------------------------------------------------------

  describe "Reasoning events" do
    test "full reasoning lifecycle" do
      assert %ReasoningStart{message_id: "m1"}.type == "REASONING_START"
      assert %ReasoningMessageStart{message_id: "m1"}.role == "reasoning"
      assert %ReasoningMessageContent{message_id: "m1", delta: "think..."}.type == "REASONING_MESSAGE_CONTENT"
      assert %ReasoningMessageEnd{message_id: "m1"}.type == "REASONING_MESSAGE_END"
      assert %ReasoningEnd{message_id: "m1"}.type == "REASONING_END"
    end

    test "ReasoningMessageChunk all fields optional" do
      event = %ReasoningMessageChunk{}
      assert event.type == "REASONING_MESSAGE_CHUNK"
    end

    test "ReasoningEncryptedValue" do
      event = %ReasoningEncryptedValue{subtype: "message", entity_id: "m1", encrypted_value: "enc..."}
      assert event.type == "REASONING_ENCRYPTED_VALUE"
    end
  end

  # -- Special Events ---------------------------------------------------------

  describe "Raw" do
    test "wraps external event" do
      event = %Raw{event: %{"custom" => true}, source: "external"}
      assert event.type == "RAW"
      assert event.source == "external"
    end
  end

  describe "Custom" do
    test "creates extension event" do
      event = %Custom{name: "my_event", value: %{data: 1}}
      assert event.type == "CUSTOM"
      assert event.name == "my_event"
    end
  end
end
