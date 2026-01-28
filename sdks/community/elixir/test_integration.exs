#!/usr/bin/env elixir
# AG-UI Protocol Integration Tests
#
# Runs a local test server and client to validate the full protocol flow.
# Similar to the Go SDK's integration tests.
#
# Usage:
#   elixir test_integration.exs

Mix.install([
  {:ag_ui, path: "."},
  {:bandit, "~> 1.5"},
  {:plug, "~> 1.16"}
])

defmodule IntegrationTest.Server do
  @moduledoc """
  Test server that can be configured for different scenarios.
  """

  use Plug.Router
  require Logger

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    RunError,
    StepStarted,
    StepFinished,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallChunk,
    ToolCallResult,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    Custom
  }

  alias AgUI.Transport.SSE.Writer
  alias AgUI.Types.Message

  plug(:match)
  plug(Plug.Parsers, parsers: [:json], json_decoder: Jason)
  plug(:dispatch)

  # Basic happy path
  post "/agent/basic" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Hello!"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Chunk events (TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK)
  post "/agent/chunks" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Text message chunks
    {:ok, conn} =
      Writer.write_event(conn, %TextMessageChunk{
        message_id: "m1",
        role: "assistant",
        delta: "Hello "
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageChunk{message_id: "m1", delta: "World!"})

    # Tool call chunks
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallChunk{
        tool_call_id: "tc1",
        tool_call_name: "test_tool",
        delta: "{\"arg\":"
      })

    {:ok, conn} = Writer.write_event(conn, %ToolCallChunk{tool_call_id: "tc1", delta: " 42}"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Tool call flow
  post "/agent/tools" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # Assistant message with tool call
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})

    {:ok, conn} =
      Writer.write_event(conn, %TextMessageContent{
        message_id: "m1",
        delta: "I'll check the weather."
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Tool call
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallStart{
        tool_call_id: "tc1",
        tool_call_name: "get_weather",
        parent_message_id: "m1"
      })

    {:ok, conn} =
      Writer.write_event(conn, %ToolCallArgs{
        tool_call_id: "tc1",
        delta: "{\"city\": \"NYC\"}"
      })

    {:ok, conn} = Writer.write_event(conn, %ToolCallEnd{tool_call_id: "tc1"})

    # Tool result
    {:ok, conn} =
      Writer.write_event(conn, %ToolCallResult{
        message_id: "m2",
        tool_call_id: "tc1",
        content: "{\"temp\": 72, \"unit\": \"F\"}",
        role: "tool"
      })

    # Final assistant response
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m3", role: "assistant"})

    {:ok, conn} =
      Writer.write_event(conn, %TextMessageContent{
        message_id: "m3",
        delta: "It's 72F in NYC."
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m3"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # State management
  post "/agent/state" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    # State snapshot
    {:ok, conn} =
      Writer.write_event(conn, %StateSnapshot{
        snapshot: %{"counter" => 0, "items" => ["a", "b"]}
      })

    # State delta (JSON Patch)
    {:ok, conn} =
      Writer.write_event(conn, %StateDelta{
        delta: [
          %{"op" => "replace", "path" => "/counter", "value" => 1},
          %{"op" => "add", "path" => "/items/-", "value" => "c"}
        ]
      })

    # Another delta
    {:ok, conn} =
      Writer.write_event(conn, %StateDelta{
        delta: [
          %{"op" => "replace", "path" => "/counter", "value" => 2}
        ]
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Messages snapshot
  post "/agent/messages_snapshot" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "First"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})

    # Messages snapshot replaces all messages
    {:ok, conn} =
      Writer.write_event(conn, %MessagesSnapshot{
        messages: [
          %{"id" => "snapshot-m1", "role" => "user", "content" => "Hello"},
          %{"id" => "snapshot-m2", "role" => "assistant", "content" => "Hi there!"}
        ]
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Steps (thinking, tool_use, etc.)
  post "/agent/steps" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} = Writer.write_event(conn, %StepStarted{step_name: "thinking"})
    Process.sleep(10)
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Hmm..."})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %StepFinished{step_name: "thinking"})

    {:ok, conn} = Writer.write_event(conn, %StepStarted{step_name: "tool_use"})
    {:ok, conn} = Writer.write_event(conn, %StepFinished{step_name: "tool_use"})

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  # Error scenario
  post "/agent/error" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} =
      Writer.write_event(conn, %RunError{
        message: "Something went wrong",
        code: "INTERNAL_ERROR"
      })

    conn
  end

  # Multiple sequential runs
  post "/agent/multi_run" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"

    # First run
    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: "run-1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m1", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m1", delta: "Run 1"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m1"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-1"})

    # Second run
    {:ok, conn} =
      Writer.write_event(conn, %RunStarted{
        thread_id: thread_id,
        run_id: "run-2",
        parent_run_id: "run-1"
      })

    {:ok, conn} = Writer.write_event(conn, %TextMessageStart{message_id: "m2", role: "assistant"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageContent{message_id: "m2", delta: "Run 2"})
    {:ok, conn} = Writer.write_event(conn, %TextMessageEnd{message_id: "m2"})
    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: "run-2"})

    conn
  end

  # Custom event
  post "/agent/custom" do
    conn = Writer.prepare_conn(conn)
    input = conn.body_params
    thread_id = input["threadId"] || "t1"
    run_id = input["runId"] || "r1"

    {:ok, conn} = Writer.write_event(conn, %RunStarted{thread_id: thread_id, run_id: run_id})

    {:ok, conn} =
      Writer.write_event(conn, %Custom{
        name: "my_custom_event",
        value: %{"custom_field" => "custom_value", "count" => 42}
      })

    {:ok, conn} = Writer.write_event(conn, %RunFinished{thread_id: thread_id, run_id: run_id})
    conn
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end
end

defmodule IntegrationTest.Runner do
  @moduledoc """
  Runs integration tests against the test server.
  """

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUI.Types.Message
  alias AgUI.Verify

  alias AgUI.Events.{
    RunStarted,
    RunFinished,
    RunError,
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    ToolCallStart,
    ToolCallEnd,
    ToolCallResult,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    Custom
  }

  def run_all(base_url) do
    tests = [
      {"Basic happy path", "/agent/basic", &test_basic/1},
      {"Chunk expansion", "/agent/chunks", &test_chunks/1},
      {"Tool call flow", "/agent/tools", &test_tools/1},
      {"State management", "/agent/state", &test_state/1},
      {"Messages snapshot", "/agent/messages_snapshot", &test_messages_snapshot/1},
      {"Steps", "/agent/steps", &test_steps/1},
      {"Error handling", "/agent/error", &test_error/1},
      {"Multiple runs", "/agent/multi_run", &test_multi_run/1},
      {"Custom events", "/agent/custom", &test_custom/1}
    ]

    results =
      Enum.map(tests, fn {name, path, test_fn} ->
        IO.puts("\n--- #{name} ---")
        url = "#{base_url}#{path}"
        agent = HttpAgent.new(url: url, timeout: 10_000)

        result =
          try do
            test_fn.(agent)
          rescue
            e ->
              IO.puts("  EXCEPTION: #{Exception.message(e)}")
              :error
          end

        {name, result}
      end)

    # Summary
    IO.puts("\n" <> String.duplicate("=", 50))
    IO.puts("SUMMARY")
    IO.puts(String.duplicate("=", 50))

    {passed, failed} = Enum.split_with(results, fn {_, r} -> r == :ok end)

    Enum.each(results, fn {name, result} ->
      status = if result == :ok, do: "[PASS]", else: "[FAIL]"
      IO.puts("  #{status} #{name}")
    end)

    IO.puts("")
    IO.puts("Passed: #{length(passed)}/#{length(results)}")

    if length(failed) > 0 do
      IO.puts("Failed: #{length(failed)}")
      System.halt(1)
    else
      IO.puts("\nAll tests passed!")
      :ok
    end
  end

  defp make_input do
    RunAgentInput.new("test-thread", "test-run",
      messages: [
        %Message.User{id: "u1", role: :user, content: "Hello"}
      ]
    )
  end

  defp test_basic(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    assert(length(events) >= 4, "Expected at least 4 events, got #{length(events)}")
    assert(match?(%RunStarted{}, hd(events)), "First event should be RUN_STARTED")
    assert(match?(%RunFinished{}, List.last(events)), "Last event should be RUN_FINISHED")

    text_content = Enum.filter(events, &match?(%TextMessageContent{}, &1))
    assert(length(text_content) > 0, "Should have text content")

    verify_events(events)
  end

  defp test_chunks(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    # After normalization, there should be no chunk events
    chunk_events =
      Enum.filter(events, fn e ->
        e.type in [:text_message_chunk, :tool_call_chunk]
      end)

    assert(length(chunk_events) == 0, "Chunks should be expanded")

    # Should have start/content/end
    assert(Enum.any?(events, &match?(%TextMessageStart{}, &1)), "Should have TEXT_MESSAGE_START")
    assert(Enum.any?(events, &match?(%TextMessageEnd{}, &1)), "Should have TEXT_MESSAGE_END")
    assert(Enum.any?(events, &match?(%ToolCallStart{}, &1)), "Should have TOOL_CALL_START")
    assert(Enum.any?(events, &match?(%ToolCallEnd{}, &1)), "Should have TOOL_CALL_END")

    verify_events(events)
  end

  defp test_tools(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # Should have tool message
    tool_msgs = Enum.filter(result.new_messages, &match?(%Message.Tool{}, &1))
    assert(length(tool_msgs) > 0, "Should have tool result message")

    # Should have assistant messages with tool calls
    assistant_msgs =
      Enum.filter(result.new_messages, fn m ->
        match?(%Message.Assistant{}, m) and length(m.tool_calls || []) > 0
      end)

    assert(length(assistant_msgs) > 0, "Should have assistant message with tool calls")

    :ok
  end

  defp test_state(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # State should be updated via snapshot + delta
    assert(result.session.state["counter"] == 2, "Counter should be 2")
    assert(result.session.state["items"] == ["a", "b", "c"], "Items should have 'c' added")

    :ok
  end

  defp test_messages_snapshot(agent) do
    {:ok, result} = HttpAgent.run_agent(agent, make_input())

    # Messages should be replaced by snapshot
    msg_ids = Enum.map(result.session.messages, & &1.id)
    assert("snapshot-m1" in msg_ids, "Should have snapshot message 1")
    assert("snapshot-m2" in msg_ids, "Should have snapshot message 2")

    :ok
  end

  defp test_steps(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    step_started = Enum.filter(events, &match?(%AgUI.Events.StepStarted{}, &1))
    step_finished = Enum.filter(events, &match?(%AgUI.Events.StepFinished{}, &1))

    assert(length(step_started) == 2, "Should have 2 STEP_STARTED events")
    assert(length(step_finished) == 2, "Should have 2 STEP_FINISHED events")

    verify_events(events)
  end

  defp test_error(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    error_events = Enum.filter(events, &match?(%RunError{}, &1))
    assert(length(error_events) == 1, "Should have RUN_ERROR")

    error = hd(error_events)
    assert(error.message == "Something went wrong", "Error message should match")
    assert(error.code == "INTERNAL_ERROR", "Error code should match")

    :ok
  end

  defp test_multi_run(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    run_started = Enum.filter(events, &match?(%RunStarted{}, &1))
    run_finished = Enum.filter(events, &match?(%RunFinished{}, &1))

    assert(length(run_started) == 2, "Should have 2 RUN_STARTED events")
    assert(length(run_finished) == 2, "Should have 2 RUN_FINISHED events")

    # Second run should have parent_run_id
    second_run = Enum.at(run_started, 1)
    assert(second_run.parent_run_id == "run-1", "Second run should reference first")

    verify_events(events)
  end

  defp test_custom(agent) do
    {:ok, stream} = HttpAgent.stream_canonical(agent, make_input())
    events = Enum.to_list(stream)

    custom_events = Enum.filter(events, &match?(%Custom{}, &1))
    assert(length(custom_events) == 1, "Should have CUSTOM event")

    custom = hd(custom_events)
    assert(custom.name == "my_custom_event", "Custom event name should match")
    assert(custom.value["count"] == 42, "Custom event value should match")

    verify_events(events)
  end

  defp verify_events(events) do
    case Verify.verify_events(events) do
      :ok ->
        IO.puts("  Events verified OK")
        :ok

      {:error, reason} ->
        IO.puts("  VERIFICATION FAILED: #{inspect(reason)}")
        :error
    end
  end

  defp assert(true, _msg), do: :ok

  defp assert(false, msg) do
    IO.puts("  ASSERTION FAILED: #{msg}")
    throw(:assertion_failed)
  end
end

# Main execution
IO.puts("""
============================================
AG-UI Protocol Integration Tests
============================================
""")

port = 4002

# Start test server
{:ok, _} = Bandit.start_link(plug: IntegrationTest.Server, port: port)
IO.puts("Test server started on port #{port}\n")

# Give server time to start
Process.sleep(100)

# Run tests
base_url = "http://localhost:#{port}"
IntegrationTest.Runner.run_all(base_url)
