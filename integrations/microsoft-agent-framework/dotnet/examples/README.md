# Microsoft Agent Framework AG-UI Integration (.NET)

This directory contains a .NET implementation of the Microsoft Agent Framework dojo server. It mirrors the sample added in [microsoft/agent-framework#1996](https://github.com/microsoft/agent-framework/pull/1996) and exposes endpoints that match the AG-UI dojo experiences.

## Prerequisites

- [.NET SDK 8.0 or later](https://dotnet.microsoft.com/download) (the sample was validated with .NET 9 preview builds)
- An Azure OpenAI endpoint with a chat deployment
- Azure credentials that can authenticate via `DefaultAzureCredential` (for example `az login`)

Set the following environment variables before running the server:

```powershell
$env:AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com/"
$env:AZURE_OPENAI_CHAT_DEPLOYMENT_NAME="gpt-4o-mini"
```

If you prefer to use `appsettings.Development.json` or user secrets you can place the same keys under the root configuration section.

## Run the dojo server

```powershell
cd integrations/microsoft-agent-framework/dotnet/examples
dotnet restore AGUIDojoServer/AGUIDojoServer.csproj
dotnet run --project AGUIDojoServer/AGUIDojoServer.csproj --urls "http://localhost:8889" --no-build
```

The server listens on `http://localhost:8889` by default. Update the port if it conflicts with another service.

## Connect from the AG-UI Dojo

Update (or create) an environment variable before starting the dojo frontend:

```powershell
$env:AGENT_FRAMEWORK_DOTNET_URL="http://localhost:8889"
```

The dojo will then display a **Microsoft Agent Framework (.NET)** entry alongside the existing Python integration. Each endpoint demonstrates a different AG-UI capability:

- `/agentic_chat`
- `/backend_tool_rendering`
- `/human_in_the_loop`
- `/agentic_generative_ui`
- `/tool_based_generative_ui`
- `/shared_state`
- `/predictive_state_updates`

## Project structure

```
AGUIDojoServer/
├── AGUIDojoServer.csproj          # Project configuration and package references
├── Program.cs                     # ASP.NET Core entry point and endpoint wiring
├── ChatClientAgentFactory.cs      # Factory that builds specialized ChatClientAgent instances
├── WeatherInfo.cs                 # DTO returned by backend tool calls
├── appsettings.json               # Baseline logging configuration
├── appsettings.Development.json   # Development logging overrides
└── Properties/
    └── launchSettings.json        # Visual Studio / `dotnet run` defaults
```

> **Note**
> The official Microsoft Agent Framework packages are still evolving. The version numbers in the project file may need to be updated to match the latest release from the upstream repository.
