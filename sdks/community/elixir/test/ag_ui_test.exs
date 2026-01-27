defmodule AgUiTest do
  use ExUnit.Case
  doctest AgUi

  test "greets the world" do
    assert AgUi.hello() == :world
  end
end
