defmodule AgUi.State.Manager do
  @moduledoc """
  AG-UI state management with snapshot/delta support.

  Implements the AG-UI state synchronization pattern:
  - `STATE_SNAPSHOT` delivers the full agent state
  - `STATE_DELTA` delivers JSON Patch (RFC 6902) operations

  ## Example

      {:ok, mgr} = AgUi.State.Manager.start_link(name: :my_agent)
      AgUi.State.Manager.set(mgr, %{"count" => 0, "status" => "idle"})
      AgUi.State.Manager.patch(mgr, [%{"op" => "replace", "path" => "/count", "value" => 1}])
      state = AgUi.State.Manager.get(mgr)
      #=> %{"count" => 1, "status" => "idle"}
  """

  use GenServer

  alias AgUi.Core.Events.{StateSnapshot, StateDelta}

  @type patch_op :: %{
          required(String.t()) => String.t(),
          optional(String.t()) => term()
        }

  # -- Public API -------------------------------------------------------------

  @doc "Starts the state manager."
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name)
    initial = Keyword.get(opts, :initial_state, %{})
    GenServer.start_link(__MODULE__, initial, name: name)
  end

  @doc "Returns the current state."
  @spec get(GenServer.server()) :: map()
  def get(server), do: GenServer.call(server, :get)

  @doc "Replaces the entire state (emits snapshot event)."
  @spec set(GenServer.server(), map()) :: {:ok, %StateSnapshot{}}
  def set(server, state) when is_map(state) do
    GenServer.call(server, {:set, state})
  end

  @doc "Applies JSON Patch operations to the state (emits delta event)."
  @spec patch(GenServer.server(), [patch_op()]) :: {:ok, %StateDelta{}} | {:error, term()}
  def patch(server, operations) when is_list(operations) do
    GenServer.call(server, {:patch, operations})
  end

  @doc "Returns the current state version (number of mutations applied)."
  @spec version(GenServer.server()) :: non_neg_integer()
  def version(server), do: GenServer.call(server, :version)

  @doc "Returns a snapshot event for the current state."
  @spec snapshot(GenServer.server()) :: %StateSnapshot{}
  def snapshot(server), do: GenServer.call(server, :snapshot)

  # -- GenServer Callbacks ----------------------------------------------------

  @impl true
  def init(initial_state) do
    {:ok, %{state: initial_state, version: 0}}
  end

  @impl true
  def handle_call(:get, _from, %{state: state} = data) do
    {:reply, state, data}
  end

  def handle_call({:set, new_state}, _from, %{version: v} = data) do
    event = %StateSnapshot{snapshot: new_state}
    {:reply, {:ok, event}, %{data | state: new_state, version: v + 1}}
  end

  def handle_call({:patch, operations}, _from, %{state: state, version: v} = data) do
    case apply_patch(state, operations) do
      {:ok, new_state} ->
        event = %StateDelta{delta: operations}
        {:reply, {:ok, event}, %{data | state: new_state, version: v + 1}}

      {:error, reason} ->
        {:reply, {:error, reason}, data}
    end
  end

  def handle_call(:version, _from, %{version: v} = data) do
    {:reply, v, data}
  end

  def handle_call(:snapshot, _from, %{state: state} = data) do
    {:reply, %StateSnapshot{snapshot: state}, data}
  end

  # -- JSON Patch (RFC 6902) --------------------------------------------------

  @doc """
  Applies a list of JSON Patch operations to a map.

  Supported operations: add, remove, replace, move, copy, test.
  """
  @spec apply_patch(map(), [patch_op()]) :: {:ok, map()} | {:error, term()}
  def apply_patch(state, operations) do
    Enum.reduce_while(operations, {:ok, state}, fn op, {:ok, current} ->
      case apply_operation(current, op) do
        {:ok, updated} -> {:cont, {:ok, updated}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp apply_operation(state, %{"op" => "add", "path" => path, "value" => value}) do
    put_at_path(state, parse_path(path), value)
  end

  defp apply_operation(state, %{"op" => "remove", "path" => path}) do
    remove_at_path(state, parse_path(path))
  end

  defp apply_operation(state, %{"op" => "replace", "path" => path, "value" => value}) do
    case get_at_path(state, parse_path(path)) do
      {:ok, _} -> put_at_path(state, parse_path(path), value)
      {:error, _} = err -> err
    end
  end

  defp apply_operation(state, %{"op" => "move", "from" => from, "path" => path}) do
    with {:ok, value} <- get_at_path(state, parse_path(from)),
         {:ok, removed} <- remove_at_path(state, parse_path(from)),
         {:ok, result} <- put_at_path(removed, parse_path(path), value) do
      {:ok, result}
    end
  end

  defp apply_operation(state, %{"op" => "copy", "from" => from, "path" => path}) do
    with {:ok, value} <- get_at_path(state, parse_path(from)),
         {:ok, result} <- put_at_path(state, parse_path(path), value) do
      {:ok, result}
    end
  end

  defp apply_operation(state, %{"op" => "test", "path" => path, "value" => expected}) do
    case get_at_path(state, parse_path(path)) do
      {:ok, ^expected} -> {:ok, state}
      {:ok, actual} -> {:error, "test failed: expected #{inspect(expected)}, got #{inspect(actual)}"}
      {:error, _} = err -> err
    end
  end

  defp apply_operation(_state, op) do
    {:error, "unsupported operation: #{inspect(op)}"}
  end

  # -- Path Helpers -----------------------------------------------------------

  defp parse_path(""), do: []
  defp parse_path("/"), do: [""]

  defp parse_path("/" <> path) do
    path
    |> String.split("/")
    |> Enum.map(fn segment ->
      segment
      |> String.replace("~1", "/")
      |> String.replace("~0", "~")
    end)
  end

  defp parse_path(path), do: {:error, "invalid path: #{path}"}

  defp get_at_path(state, []), do: {:ok, state}

  defp get_at_path(state, [key | rest]) when is_map(state) do
    case Map.fetch(state, key) do
      {:ok, value} -> get_at_path(value, rest)
      :error -> {:error, "path not found: #{key}"}
    end
  end

  defp get_at_path(state, [key | rest]) when is_list(state) do
    case Integer.parse(key) do
      {idx, ""} when idx >= 0 and idx < length(state) ->
        get_at_path(Enum.at(state, idx), rest)

      _ ->
        {:error, "invalid array index: #{key}"}
    end
  end

  defp get_at_path(_state, _path), do: {:error, "cannot traverse non-container"}

  defp put_at_path(_state, [], value), do: {:ok, value}

  defp put_at_path(state, [key | rest], value) when is_map(state) do
    case put_at_path(Map.get(state, key, %{}), rest, value) do
      {:ok, updated} -> {:ok, Map.put(state, key, updated)}
      {:error, _} = err -> err
    end
  end

  defp put_at_path(state, ["-" | rest], value) when is_list(state) do
    case put_at_path(%{}, rest, value) do
      {:ok, updated} -> {:ok, state ++ [updated]}
      {:error, _} = err -> err
    end
  end

  defp put_at_path(state, [key | rest], value) when is_list(state) do
    case Integer.parse(key) do
      {idx, ""} when idx >= 0 and idx <= length(state) ->
        case put_at_path(Enum.at(state, idx, %{}), rest, value) do
          {:ok, updated} -> {:ok, List.replace_at(state, idx, updated)}
          {:error, _} = err -> err
        end

      _ ->
        {:error, "invalid array index: #{key}"}
    end
  end

  defp put_at_path(_state, _path, _value), do: {:error, "cannot set on non-container"}

  defp remove_at_path(state, [key]) when is_map(state) do
    if Map.has_key?(state, key) do
      {:ok, Map.delete(state, key)}
    else
      {:error, "path not found: #{key}"}
    end
  end

  defp remove_at_path(state, [key | rest]) when is_map(state) do
    case Map.fetch(state, key) do
      {:ok, child} ->
        case remove_at_path(child, rest) do
          {:ok, updated} -> {:ok, Map.put(state, key, updated)}
          {:error, _} = err -> err
        end

      :error ->
        {:error, "path not found: #{key}"}
    end
  end

  defp remove_at_path(state, [key]) when is_list(state) do
    case Integer.parse(key) do
      {idx, ""} when idx >= 0 and idx < length(state) ->
        {:ok, List.delete_at(state, idx)}

      _ ->
        {:error, "invalid array index: #{key}"}
    end
  end

  defp remove_at_path(_state, _path), do: {:error, "cannot remove from non-container"}
end
