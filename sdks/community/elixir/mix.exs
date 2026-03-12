defmodule AgUi.MixProject do
  use Mix.Project

  @version "0.1.0"
  @source_url "https://github.com/peguesj/ag_ui_ex"

  def project do
    [
      app: :ag_ui_ex,
      version: @version,
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      name: "AG-UI",
      description: "Elixir SDK for the AG-UI (Agent-User Interaction) protocol",
      source_url: @source_url,
      homepage_url: "https://peguesj.github.io/ag_ui_ex",
      package: package(),
      docs: docs(),
      dialyzer: [plt_add_apps: [:plug, :phoenix, :phoenix_pubsub]]
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:plug, "~> 1.14", optional: true},
      {:phoenix, "~> 1.7", optional: true},
      {:phoenix_pubsub, "~> 2.1", optional: true},
      {:ex_doc, "~> 0.31", only: :dev, runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false}
    ]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url,
        "AG-UI Protocol" => "https://github.com/ag-ui-protocol/ag-ui"
      },
      maintainers: ["Jeremiah Pegues"],
      files: ~w(lib .formatter.exs mix.exs README.md LICENSE CONTRIBUTING.md)
    ]
  end

  defp docs do
    [
      main: "AgUi",
      extras: ["README.md", "CONTRIBUTING.md", "LICENSE"],
      source_ref: "v#{@version}",
      groups_for_modules: [
        Core: [AgUi, AgUi.Core.Events, AgUi.Core.Types],
        "Event Types": ~r/AgUi\.Core\.Events\..*/,
        "Message Types": ~r/AgUi\.Core\.Types\..*/,
        Encoding: [AgUi.Encoder.EventEncoder],
        Transport: [AgUi.Transport.SSE, AgUi.Transport.Channel],
        State: [AgUi.State.Manager],
        Middleware: [AgUi.Middleware.Pipeline],
        Client: [AgUi.Client.HttpAgent]
      ]
    ]
  end
end
