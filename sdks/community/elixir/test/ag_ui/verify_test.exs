defmodule AgUI.VerifyTest do
  use ExUnit.Case, async: true

  alias AgUI.Verify
  alias AgUI.Events

  test "valid sequence passes" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.TextMessageStart{message_id: "m1", role: "assistant"},
      %Events.TextMessageContent{message_id: "m1", delta: "hi"},
      %Events.TextMessageEnd{message_id: "m1"},
      %Events.ToolCallStart{tool_call_id: "c1", tool_call_name: "tool"},
      %Events.ToolCallArgs{tool_call_id: "c1", delta: "{}"},
      %Events.ToolCallEnd{tool_call_id: "c1"},
      %Events.StepStarted{step_name: "step-1"},
      %Events.StepFinished{step_name: "step-1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]

    assert :ok = Verify.verify_events(events)
  end

  test "run must start before finish" do
    events = [%Events.RunFinished{thread_id: "t1", run_id: "r1"}]
    assert {:error, {:first_event_must_be_run_started, _}} = Verify.verify_events(events)
  end

  test "second run cannot start before first finishes" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.RunStarted{thread_id: "t1", run_id: "r2"}
    ]

    assert {:error, {:run_already_started, _}} = Verify.verify_events(events)
  end

  test "run_error is allowed as the first event" do
    events = [%Events.RunError{message: "boom"}]
    assert :ok = Verify.verify_events(events)
  end

  test "run_error is allowed after run_finished" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"},
      %Events.RunError{message: "late error"}
    ]

    assert :ok = Verify.verify_events(events)
  end

  test "text content requires start" do
    events = [%Events.TextMessageContent{message_id: "m1", delta: "hi"}]
    assert {:error, {:text_not_started, _}} = Verify.verify_events(events)
  end

  test "tool args require start" do
    events = [%Events.ToolCallArgs{tool_call_id: "c1", delta: "{}"}]
    assert {:error, {:tool_not_started, _}} = Verify.verify_events(events)
  end

  test "text events require matching message id while active" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.TextMessageStart{message_id: "m1", role: "assistant"},
      %Events.TextMessageContent{message_id: "m2", delta: "hi"}
    ]

    assert {:error, {:message_id_mismatch, _}} = Verify.verify_events(events)
  end

  test "tool events require matching tool_call_id while active" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.ToolCallStart{tool_call_id: "c1", tool_call_name: "tool"},
      %Events.ToolCallArgs{tool_call_id: "c2", delta: "{}"}
    ]

    assert {:error, {:tool_call_id_mismatch, _}} = Verify.verify_events(events)
  end

  test "run must be finished" do
    events = [%Events.RunStarted{thread_id: "t1", run_id: "r1"}]
    assert {:error, {:run_not_finished, _}} = Verify.verify_events(events)
  end

  test "no new run after run_finished" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"},
      %Events.RunStarted{thread_id: "t1", run_id: "r2"}
    ]

    assert {:error, {:run_already_finished, _}} = Verify.verify_events(events)
  end

  test "text must be ended" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.TextMessageStart{message_id: "m1", role: "assistant"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]

    assert {:error, {:text_not_ended, _}} = Verify.verify_events(events)
  end

  test "steps must be finished" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.StepStarted{step_name: "step-1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]

    assert {:error, {:step_not_finished, _}} = Verify.verify_events(events)
  end

  test "thinking events require correct sequence" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.ThinkingEnd{type: :thinking_end}
    ]

    assert {:error, {:thinking_not_started, _}} = Verify.verify_events(events)
  end

  test "thinking text message requires start" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.ThinkingTextMessageContent{type: :thinking_text_message_content, delta: "x"}
    ]

    assert {:error, {:thinking_message_not_started, _}} = Verify.verify_events(events)
  end

  test "tool must be ended" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.ToolCallStart{tool_call_id: "c1", tool_call_name: "tool"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]

    assert {:error, {:tool_not_ended, _}} = Verify.verify_events(events)
  end

  test "verify_stream passes valid sequences" do
    events = [
      %Events.RunStarted{thread_id: "t1", run_id: "r1"},
      %Events.TextMessageStart{message_id: "m1", role: "assistant"},
      %Events.TextMessageEnd{message_id: "m1"},
      %Events.RunFinished{thread_id: "t1", run_id: "r1"}
    ]

    assert Enum.to_list(Verify.verify_stream(events)) == events
  end

  test "verify_stream raises on invalid sequence" do
    events = [%Events.RunFinished{thread_id: "t1", run_id: "r1"}]

    assert_raise ArgumentError, ~r/Invalid event sequence/, fn ->
      Verify.verify_stream(events) |> Enum.to_list()
    end
  end
end
