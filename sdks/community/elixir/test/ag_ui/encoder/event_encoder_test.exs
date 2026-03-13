defmodule AgUi.Encoder.EventEncoderTest do
  use ExUnit.Case, async: true

  alias AgUi.Encoder.EventEncoder
  alias AgUi.Core.Events.{RunStarted, TextMessageContent, RunFinished, Custom}

  describe "encode/1" do
    test "encodes RunStarted to SSE format" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      result = EventEncoder.encode(event)

      assert String.starts_with?(result, "data: ")
      assert String.ends_with?(result, "\n\n")

      # Parse the JSON portion
      json = result |> String.trim_leading("data: ") |> String.trim()
      {:ok, decoded} = Jason.decode(json)

      assert decoded["type"] == "RUN_STARTED"
      assert decoded["threadId"] == "t1"
      assert decoded["runId"] == "r1"
      # nil values should be excluded
      refute Map.has_key?(decoded, "parentRunId")
      refute Map.has_key?(decoded, "timestamp")
    end

    test "encodes TextMessageContent with camelCase keys" do
      event = %TextMessageContent{message_id: "m1", delta: "Hello world"}
      result = EventEncoder.encode(event)
      json = result |> String.trim_leading("data: ") |> String.trim()
      {:ok, decoded} = Jason.decode(json)

      assert decoded["messageId"] == "m1"
      assert decoded["delta"] == "Hello world"
    end

    test "encodes RunFinished with optional result" do
      event = %RunFinished{thread_id: "t1", run_id: "r1", result: %{"summary" => "ok"}}
      result = EventEncoder.encode(event)
      json = result |> String.trim_leading("data: ") |> String.trim()
      {:ok, decoded} = Jason.decode(json)

      assert decoded["result"] == %{"summary" => "ok"}
    end

    test "encodes Custom event" do
      event = %Custom{name: "my_event", value: [1, 2, 3]}
      result = EventEncoder.encode(event)
      json = result |> String.trim_leading("data: ") |> String.trim()
      {:ok, decoded} = Jason.decode(json)

      assert decoded["type"] == "CUSTOM"
      assert decoded["name"] == "my_event"
      assert decoded["value"] == [1, 2, 3]
    end
  end

  describe "encode_json/1" do
    test "returns JSON string without SSE framing" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      result = EventEncoder.encode_json(event)

      refute String.starts_with?(result, "data: ")
      {:ok, decoded} = Jason.decode(result)
      assert decoded["type"] == "RUN_STARTED"
    end
  end

  describe "decode_json/1" do
    test "decodes camelCase JSON to snake_case map" do
      json = ~s({"type":"RUN_STARTED","threadId":"t1","runId":"r1"})
      {:ok, decoded} = EventEncoder.decode_json(json)

      assert decoded["type"] == "RUN_STARTED"
      assert decoded["thread_id"] == "t1"
      assert decoded["run_id"] == "r1"
    end

    test "returns error for invalid JSON" do
      assert {:error, _} = EventEncoder.decode_json("not json")
    end
  end

  describe "content_type/0" do
    test "returns SSE content type" do
      assert EventEncoder.content_type() == "text/event-stream"
    end
  end

  describe "media_type/0" do
    test "returns AG-UI media type" do
      assert EventEncoder.media_type() == "application/vnd.ag-ui.event+proto"
    end
  end

  describe "full event stream encoding" do
    test "encodes a complete agent run lifecycle" do
      events = [
        %RunStarted{thread_id: "t1", run_id: "r1"},
        %TextMessageContent{message_id: "m1", delta: "Hello "},
        %TextMessageContent{message_id: "m1", delta: "world!"},
        %RunFinished{thread_id: "t1", run_id: "r1"}
      ]

      stream = events |> Enum.map(&EventEncoder.encode/1) |> Enum.join()

      # Should have 4 SSE frames
      frames = stream |> String.split("\n\n", trim: true)
      assert length(frames) == 4

      # First frame is RUN_STARTED
      {:ok, first} = frames |> hd() |> String.trim_leading("data: ") |> Jason.decode()
      assert first["type"] == "RUN_STARTED"

      # Last frame is RUN_FINISHED
      {:ok, last} = frames |> List.last() |> String.trim_leading("data: ") |> Jason.decode()
      assert last["type"] == "RUN_FINISHED"
    end
  end
end
