defmodule AgUiDemoWeb.PageController do
  use AgUiDemoWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
