defmodule AgUi.State.ManagerTest do
  use ExUnit.Case, async: true

  alias AgUi.State.Manager
  alias AgUi.Core.Events.{StateSnapshot, StateDelta}

  setup do
    {:ok, pid} = Manager.start_link(initial_state: %{"count" => 0, "name" => "test"})
    %{mgr: pid}
  end

  describe "get/1" do
    test "returns initial state", %{mgr: mgr} do
      assert Manager.get(mgr) == %{"count" => 0, "name" => "test"}
    end
  end

  describe "set/2" do
    test "replaces state and returns snapshot event", %{mgr: mgr} do
      new_state = %{"count" => 5, "status" => "active"}
      {:ok, %StateSnapshot{snapshot: ^new_state}} = Manager.set(mgr, new_state)
      assert Manager.get(mgr) == new_state
    end
  end

  describe "patch/2" do
    test "applies replace operation", %{mgr: mgr} do
      ops = [%{"op" => "replace", "path" => "/count", "value" => 42}]
      {:ok, %StateDelta{delta: ^ops}} = Manager.patch(mgr, ops)
      assert Manager.get(mgr)["count"] == 42
    end

    test "applies add operation", %{mgr: mgr} do
      ops = [%{"op" => "add", "path" => "/status", "value" => "running"}]
      {:ok, _event} = Manager.patch(mgr, ops)
      assert Manager.get(mgr)["status"] == "running"
    end

    test "applies remove operation", %{mgr: mgr} do
      ops = [%{"op" => "remove", "path" => "/name"}]
      {:ok, _event} = Manager.patch(mgr, ops)
      refute Map.has_key?(Manager.get(mgr), "name")
    end

    test "applies multiple operations atomically", %{mgr: mgr} do
      ops = [
        %{"op" => "replace", "path" => "/count", "value" => 10},
        %{"op" => "add", "path" => "/active", "value" => true}
      ]

      {:ok, _event} = Manager.patch(mgr, ops)
      state = Manager.get(mgr)
      assert state["count"] == 10
      assert state["active"] == true
    end

    test "returns error for invalid path", %{mgr: mgr} do
      ops = [%{"op" => "replace", "path" => "/nonexistent/deep", "value" => 1}]
      {:error, _reason} = Manager.patch(mgr, ops)
      # State unchanged
      assert Manager.get(mgr)["count"] == 0
    end

    test "test operation validates value", %{mgr: mgr} do
      ops = [%{"op" => "test", "path" => "/count", "value" => 0}]
      {:ok, _event} = Manager.patch(mgr, ops)

      bad_ops = [%{"op" => "test", "path" => "/count", "value" => 999}]
      {:error, _reason} = Manager.patch(mgr, bad_ops)
    end

    test "move operation", %{mgr: mgr} do
      ops = [%{"op" => "move", "from" => "/name", "path" => "/label"}]
      {:ok, _event} = Manager.patch(mgr, ops)
      state = Manager.get(mgr)
      refute Map.has_key?(state, "name")
      assert state["label"] == "test"
    end

    test "copy operation", %{mgr: mgr} do
      ops = [%{"op" => "copy", "from" => "/name", "path" => "/alias"}]
      {:ok, _event} = Manager.patch(mgr, ops)
      state = Manager.get(mgr)
      assert state["name"] == "test"
      assert state["alias"] == "test"
    end
  end

  describe "version/1" do
    test "starts at 0", %{mgr: mgr} do
      assert Manager.version(mgr) == 0
    end

    test "increments on set", %{mgr: mgr} do
      Manager.set(mgr, %{"a" => 1})
      assert Manager.version(mgr) == 1
    end

    test "increments on successful patch", %{mgr: mgr} do
      Manager.patch(mgr, [%{"op" => "replace", "path" => "/count", "value" => 1}])
      assert Manager.version(mgr) == 1
    end

    test "does not increment on failed patch", %{mgr: mgr} do
      Manager.patch(mgr, [%{"op" => "replace", "path" => "/bad/path", "value" => 1}])
      assert Manager.version(mgr) == 0
    end
  end

  describe "snapshot/1" do
    test "returns current state as snapshot event", %{mgr: mgr} do
      %StateSnapshot{snapshot: snap} = Manager.snapshot(mgr)
      assert snap == %{"count" => 0, "name" => "test"}
    end
  end

  describe "apply_patch/2 (static)" do
    test "nested path operations" do
      state = %{"a" => %{"b" => %{"c" => 1}}}
      ops = [%{"op" => "replace", "path" => "/a/b/c", "value" => 2}]
      {:ok, result} = Manager.apply_patch(state, ops)
      assert result["a"]["b"]["c"] == 2
    end

    test "escaped path characters" do
      state = %{"a/b" => 1, "c~d" => 2}
      ops = [%{"op" => "replace", "path" => "/a~1b", "value" => 10}]
      {:ok, result} = Manager.apply_patch(state, ops)
      assert result["a/b"] == 10
    end

    test "array operations" do
      state = %{"items" => ["a", "b", "c"]}
      ops = [%{"op" => "replace", "path" => "/items/1", "value" => "B"}]
      {:ok, result} = Manager.apply_patch(state, ops)
      assert result["items"] == ["a", "B", "c"]
    end

    test "array append with dash" do
      state = %{"items" => ["a", "b"]}
      ops = [%{"op" => "add", "path" => "/items/-", "value" => "c"}]
      {:ok, result} = Manager.apply_patch(state, ops)
      assert result["items"] == ["a", "b", "c"]
    end
  end
end
