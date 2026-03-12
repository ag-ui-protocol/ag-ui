defmodule AgUi.Middleware.Pipeline do
  @moduledoc """
  AG-UI middleware pipeline for event transformation and validation.

  Middleware functions transform events as they flow through the pipeline.
  Each middleware is a function that takes an event and returns either
  `{:ok, event}` (possibly transformed), `{:skip, reason}` (drop the event),
  or `{:error, reason}`.

  ## Example

      pipeline = AgUi.Middleware.Pipeline.new()
      |> AgUi.Middleware.Pipeline.add(:timestamp, &AgUi.Middleware.Pipeline.add_timestamp/1)
      |> AgUi.Middleware.Pipeline.add(:validate, &AgUi.Middleware.Pipeline.validate_type/1)
      |> AgUi.Middleware.Pipeline.add(:log, fn event ->
        Logger.debug("AG-UI event: \#{event.type}")
        {:ok, event}
      end)

      {:ok, transformed_event} = AgUi.Middleware.Pipeline.run(pipeline, event)
  """

  @type middleware_fn :: (struct() -> {:ok, struct()} | {:skip, term()} | {:error, term()})

  @type t :: %__MODULE__{
          steps: [{atom(), middleware_fn()}]
        }

  defstruct steps: []

  @doc "Creates a new empty middleware pipeline."
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc "Adds a named middleware function to the pipeline."
  @spec add(t(), atom(), middleware_fn()) :: t()
  def add(%__MODULE__{steps: steps} = pipeline, name, fun) when is_atom(name) and is_function(fun, 1) do
    %{pipeline | steps: steps ++ [{name, fun}]}
  end

  @doc "Prepends a named middleware function to the pipeline."
  @spec prepend(t(), atom(), middleware_fn()) :: t()
  def prepend(%__MODULE__{steps: steps} = pipeline, name, fun) when is_atom(name) and is_function(fun, 1) do
    %{pipeline | steps: [{name, fun} | steps]}
  end

  @doc """
  Runs an event through the middleware pipeline.

  Returns `{:ok, event}` if all middleware pass, `{:skip, reason}` if
  any middleware skips the event, or `{:error, {step_name, reason}}` on failure.
  """
  @spec run(t(), struct()) :: {:ok, struct()} | {:skip, term()} | {:error, {atom(), term()}}
  def run(%__MODULE__{steps: steps}, event) do
    Enum.reduce_while(steps, {:ok, event}, fn {name, fun}, {:ok, evt} ->
      case fun.(evt) do
        {:ok, transformed} -> {:cont, {:ok, transformed}}
        {:skip, reason} -> {:halt, {:skip, reason}}
        {:error, reason} -> {:halt, {:error, {name, reason}}}
      end
    end)
  end

  @doc """
  Runs a batch of events through the pipeline, collecting results.
  Skipped events are excluded from the output.
  """
  @spec run_batch(t(), [struct()]) :: {[struct()], [term()]}
  def run_batch(pipeline, events) do
    {passed, errors} =
      Enum.reduce(events, {[], []}, fn event, {ok_acc, err_acc} ->
        case run(pipeline, event) do
          {:ok, transformed} -> {[transformed | ok_acc], err_acc}
          {:skip, _reason} -> {ok_acc, err_acc}
          {:error, reason} -> {ok_acc, [reason | err_acc]}
        end
      end)

    {Enum.reverse(passed), Enum.reverse(errors)}
  end

  # -- Built-in Middleware Functions ------------------------------------------

  @doc "Adds a timestamp to events that don't have one."
  @spec add_timestamp(struct()) :: {:ok, struct()}
  def add_timestamp(%{timestamp: nil} = event) do
    {:ok, %{event | timestamp: System.system_time(:millisecond)}}
  end

  def add_timestamp(event), do: {:ok, event}

  @doc "Validates that the event has a known AG-UI type."
  @spec validate_type(struct()) :: {:ok, struct()} | {:error, String.t()}
  def validate_type(%{type: type} = event) do
    if AgUi.Core.Events.EventType.valid?(type) do
      {:ok, event}
    else
      {:error, "unknown event type: #{type}"}
    end
  end

  @doc "Drops nil delta events (empty text message content, empty tool call args)."
  @spec drop_empty_delta(struct()) :: {:ok, struct()} | {:skip, :empty_delta}
  def drop_empty_delta(%{delta: delta} = event) when is_binary(delta) do
    if String.length(delta) > 0 do
      {:ok, event}
    else
      {:skip, :empty_delta}
    end
  end

  def drop_empty_delta(event), do: {:ok, event}
end
