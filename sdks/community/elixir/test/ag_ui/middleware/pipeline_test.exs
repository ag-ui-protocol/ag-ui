defmodule AgUi.Middleware.PipelineTest do
  use ExUnit.Case, async: true

  alias AgUi.Middleware.Pipeline
  alias AgUi.Core.Events.{RunStarted, TextMessageContent, Custom}

  describe "new/0" do
    test "creates empty pipeline" do
      pipeline = Pipeline.new()
      assert pipeline.steps == []
    end
  end

  describe "add/3" do
    test "appends middleware to pipeline" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:first, fn e -> {:ok, e} end)
        |> Pipeline.add(:second, fn e -> {:ok, e} end)

      assert length(pipeline.steps) == 2
      [{:first, _}, {:second, _}] = pipeline.steps
    end
  end

  describe "prepend/3" do
    test "prepends middleware to pipeline" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:first, fn e -> {:ok, e} end)
        |> Pipeline.prepend(:zero, fn e -> {:ok, e} end)

      [{:zero, _}, {:first, _}] = pipeline.steps
    end
  end

  describe "run/2" do
    test "passes event through empty pipeline" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:ok, ^event} = Pipeline.new() |> Pipeline.run(event)
    end

    test "transforms event through middleware" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:stamp, &Pipeline.add_timestamp/1)

      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      {:ok, stamped} = Pipeline.run(pipeline, event)
      assert is_integer(stamped.timestamp)
    end

    test "skips event when middleware returns :skip" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:dropper, fn _e -> {:skip, :test_skip} end)

      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:skip, :test_skip} = Pipeline.run(pipeline, event)
    end

    test "returns error with step name" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:validator, fn _e -> {:error, "bad event"} end)

      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:error, {:validator, "bad event"}} = Pipeline.run(pipeline, event)
    end

    test "short-circuits on first error" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:fail, fn _e -> {:error, "stop"} end)
        |> Pipeline.add(:never, fn _e -> raise "should not reach here" end)

      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:error, {:fail, "stop"}} = Pipeline.run(pipeline, event)
    end
  end

  describe "run_batch/2" do
    test "processes batch and separates results" do
      pipeline =
        Pipeline.new()
        |> Pipeline.add(:validate, &Pipeline.validate_type/1)

      events = [
        %RunStarted{thread_id: "t1", run_id: "r1"},
        %Custom{name: "test", value: 1},
        %{type: "INVALID_TYPE", __struct__: :fake}
      ]

      {passed, errors} = Pipeline.run_batch(pipeline, events)
      assert length(passed) == 2
      assert length(errors) == 1
    end
  end

  describe "add_timestamp/1" do
    test "adds timestamp when nil" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      {:ok, stamped} = Pipeline.add_timestamp(event)
      assert is_integer(stamped.timestamp)
    end

    test "preserves existing timestamp" do
      event = %RunStarted{thread_id: "t1", run_id: "r1", timestamp: 12345}
      {:ok, result} = Pipeline.add_timestamp(event)
      assert result.timestamp == 12345
    end
  end

  describe "validate_type/1" do
    test "accepts valid event types" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:ok, ^event} = Pipeline.validate_type(event)
    end

    test "rejects invalid event types" do
      event = %{type: "NOT_A_TYPE"}
      assert {:error, "unknown event type: NOT_A_TYPE"} = Pipeline.validate_type(event)
    end
  end

  describe "drop_empty_delta/1" do
    test "passes non-empty delta" do
      event = %TextMessageContent{message_id: "m1", delta: "hello"}
      assert {:ok, ^event} = Pipeline.drop_empty_delta(event)
    end

    test "passes events without delta field" do
      event = %RunStarted{thread_id: "t1", run_id: "r1"}
      assert {:ok, ^event} = Pipeline.drop_empty_delta(event)
    end
  end
end
