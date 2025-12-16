# ADK-Java Middleware Architecture

This document describes the architecture and design of the ADK-Java Middleware that bridges Google ADK agents with the AG-UI Protocol.

## High-Level Architecture

```
AG-UI Protocol          ADK-Java Middleware            Google ADK
     │                        │                           │
RunAgentParameters ─> AdkIntegrationAgent.run() ─> Runner.runAsync()
     │                        │                           │
     │                 EventTranslator                    │
     │                        │                           │
  BaseEvent[] <────── translate events <─────── Event[]
```

## Core Components

### `AdkIntegrationAgent`
The main orchestrator, analogous to the Python `ADKAgent`. It will:
- Implement the `com.agui.core.agent.Agent` interface.
- Manage the lifecycle of agent executions.
- Handle the bridge between the AG-UI Protocol (`RunAgentParameters`) and the Google ADK.
- Coordinate tool execution through proxy tools.

### `EventTranslator`
A class responsible for converting between event formats:
- Google ADK `Event` objects to AG-UI `BaseEvent` objects (e.g., `TextMessageStartEvent`, `ToolCallStartEvent`, etc.).
- Will be created per-execution to ensure thread safety.
- Manages streaming text content and message boundaries.

### `SessionManager`
A singleton class for centralized session control, similar to the Python implementation. It will:
- Wrap the Google ADK `SessionService`.
- Manage session creation, retrieval, and cleanup.
- Implement session timeouts based on `last_update_time`.
- Provide a mechanism for session persistence through an optional `MemoryService`.
- Isolate sessions per user and application.

### `ClientProxyTool` and `ClientProxyToolset`
- `ClientProxyTool`: A Java class that wraps an AG-UI `Tool` to make it compatible with the Google ADK's tool system.
- `ClientProxyToolset`: Manages a collection of `ClientProxyTool` instances, created dynamically for each run based on the tools provided in `RunAgentParameters`.

## Parameter and Session Flow

1.  **Client Request**: The AG-UI server receives a request and calls the `AdkIntegrationAgent.runAgent` method with `RunAgentParameters`.
2.  **Parameter Extraction**:
    *   The `AdkIntegrationAgent` will have configurable `Function<RunAgentParameters, String>` extractors for `appName` and `userId`.
    *   By default, `appName` can be derived from the ADK agent's name, and `userId` can be derived from the `thread_id`.
    *   The `sessionId` will be the `thread_id` from `RunAgentParameters`.
3.  **Session Resolution**: The `SessionManager`'s `getOrCreateSession` method is called with the `appName`, `userId`, and `sessionId`. It returns an ADK `Session` object.
4.  **Agent Execution**: A Google ADK `Runner` instance is created and `runner.runAsync()` is called.
5.  **Tool Handling**: If the `RunAgentParameters` contain tools, they are wrapped in a `ClientProxyToolset` and passed to the `Runner`. When the ADK agent calls one of these tools, the proxy tool will emit the appropriate `ToolCall` events back to the AG-UI client.
6.  **Event Translation**: The `Flowable<Event>` stream from `runAsync` is subscribed to. Each ADK `Event` is passed to an `EventTranslator` instance, which converts it into one or more AG-UI `BaseEvent`s.
7.  **Streaming Response**: The translated `BaseEvent`s are sent to the client via the `AgentSubscriber`.

## Key Design Patterns

### Dependency Injection
The `AdkIntegrationAgent` will be configured with the necessary ADK services (e.g., `SessionService`, `ArtifactService`, `MemoryService`). For ease of use, it can default to in-memory implementations.

### Singleton `SessionManager`
A single `SessionManager` instance will manage all sessions, providing a central point of control and enabling features like session timeouts and cleanup.

### Tool Proxy Pattern
Client-supplied tools will be wrapped in a proxy layer to make them compatible with the ADK, enabling seamless integration of frontend and backend tools.

## Thread Safety

-   A new `EventTranslator` will be used for each `runAgent` execution to avoid conflicts.
-   The `SessionManager` will use thread-safe collections and proper synchronization to manage session data.
-   Each agent execution will be handled in its own `CompletableFuture`, ensuring isolation.
