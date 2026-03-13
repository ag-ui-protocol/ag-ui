defmodule AgUiTest do
  use ExUnit.Case

  test "version returns SDK version" do
    assert AgUi.version() == "0.1.0"
  end
end
