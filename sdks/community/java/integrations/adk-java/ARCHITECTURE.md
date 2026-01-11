# ADK-Java Middleware Architecture

This document describes the architecture and design of the ADK-Java Middleware that bridges Google ADK agents with the AG-UI Protocol.

## High-Level Architecture

```
AG-UI Protocol          ADK-Java Middleware            Google ADK
     │                        │                           │
RunAgentParameters ─> AguiAdkRunnerAdapter.runAgent() ─> Runner.runAsync()
     │                        │                           │
     │                 EventTranslator                    │
     │                        │                           │
  BaseEvent[] <────── translate events <─────── Event[]
```

## Core Components

### `AguiAdkRunnerAdapter`
The main orchestrator, implementing a similar role to the conceptual `AdkIntegrationAgent` mentioned previously. It will:
- Implement the `com.agui.core.agent.Agent` interface conceptually by adapting its methods.
- Manage the lifecycle of agent executions, coordinating between ADK and AG-UI.
- Handle the bridge between the AG-UI Protocol (`RunAgentParameters`) and the Google ADK's `Runner`.
- Coordinates tool execution through proxy tools (if implemented).

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

## Parameter and Session Flow

1.  **Client Request**: The AG-UI server receives a request and calls the `AguiAdkRunnerAdapter.runAgent` method with `RunAgentParameters`.
2.  **Parameter Extraction**:
    *   The `AguiAdkRunnerAdapter` uses a configurable `Function<RunAgentParameters, String>` to extract `userId`.
    *   The `sessionId` will be the `thread_id` from `RunAgentParameters`.
3.  **Session Resolution**: The `SessionManager`'s `getOrCreateSession` method is called with the `appName` (from ADK `Runner`), `userId`, and `sessionId`. It returns an ADK `Session` object.
4.  **Agent Execution**: A Google ADK `Runner` instance (typically pre-configured and injected) is used, and its `runAsync()` method is called. This method processes the parameters against the configured ADK agent.
5.  **Event Translation**: The `Flowable<Event>` stream from `runAsync` is obtained. Each ADK `Event` is passed to a new `EventTranslator` instance (created per run), which converts it into one or more AG-UI `BaseEvent`s.
6.  **Streaming Response**: The translated `BaseEvent`s are emitted as a reactive stream (e.g., `Flowable` or `Flux`) to the calling client.

## Key Design Patterns

### Dependency Injection
Core ADK services (`Runner`, `SessionManager`, `RunConfig`, `userIdExtractor`) are injected into `AguiAdkRunnerAdapter`, promoting modularity and testability.

### Reactive Programming
The middleware leverages RxJava's `Flowable` to handle asynchronous event streams from the Google ADK, providing a non-blocking and efficient way to process and transform events. This also naturally supports Server-Sent Events (SSE).

### Singleton `SessionManager`
A single `SessionManager` instance will manage all sessions, providing a central point of control and enabling features like session timeouts and cleanup.

## Thread Safety

-   A new `EventTranslator` will be used for each `runAgent` execution to avoid conflicts.
-   The `SessionManager` will use thread-safe collections and proper synchronization to manage session data.
-   Each agent execution is handled within the context of reactive streams, which inherently manage concurrency and isolation for each stream.