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

1.  **Client Request**: The AG-UI server receives a request and calls `AguiAdkRunnerAdapter.runAgent(RunAgentParameters, Single<String> userId)`. The reactive userId signature lets the caller derive the value from any async source (Spring Security, auth service, DB lookup) without blocking; sync callers wrap a known value with `Single.just(uid)`.
2.  **Parameter Extraction**:
    *   The `userId` is supplied by the caller per request — typically resolved from the authenticated principal in a Spring WebFlux handler (see `INTEGRATION_GUIDE.md` § 1.4). The adapter itself does not source the `userId`.
    *   The `sessionId` will be the `thread_id` from `RunAgentParameters`.
3.  **Session Resolution**: The `SessionManager`'s `getOrCreateSession` method is called with the `appName` (from ADK `Runner`), `userId`, and `sessionId`. It returns an ADK `Session` object.
4.  **Agent Execution**: A Google ADK `Runner` instance (typically pre-configured and injected) is used, and its `runAsync()` method is called. This method processes the parameters against the configured ADK agent.
5.  **Event Translation**: The `Flowable<Event>` stream from `runAsync` is obtained. Each ADK `Event` is passed to a new `EventTranslator` instance (created per run), which converts it into one or more AG-UI `BaseEvent`s.
6.  **Streaming Response**: The translated `BaseEvent`s are emitted as a reactive stream (e.g., `Flowable` or `Flux`) to the calling client.

## Key Design Patterns

### Dependency Injection
Core ADK services (`Runner`, `SessionManager`, `RunConfig`) are injected into `AguiAdkRunnerAdapter`, promoting modularity and testability. The `userId` is not an injected dependency — it is supplied by the caller on every `runAgent(...)` invocation so it can carry per-request authenticated identity.

### Reactive Programming
The middleware leverages RxJava's `Flowable` to handle asynchronous event streams from the Google ADK, providing a non-blocking and efficient way to process and transform events. This also naturally supports Server-Sent Events (SSE).

### Singleton `SessionManager`
A single `SessionManager` instance will manage all sessions, providing a central point of control and enabling features like session timeouts and cleanup.

## Thread Safety

-   A new `EventTranslator` is created for each `runAgent` execution to avoid conflicts between concurrent runs.
-   Each agent execution is handled inside a reactive stream (RxJava `Flowable`/`Single`), which isolates subscriber state across runs.
-   The `SessionManager` uses thread-safe collections (`ConcurrentHashMap`) for its internal state and an explicit **per-session monitor** to serialize read-modify-write of mutable session state (the `processedMessageIds` and `pendingToolCallIds` entries).

### Per-session write lock

The session state held by Google ADK (`Session.state()`) is updated via the event API (`BaseSessionService.appendEvent`). That API takes a full `stateDelta` and **does not merge** at the key-level for collection values: writing `processedMessageIds = {A, B}` overwrites whatever was there. Two concurrent runs for the **same session** would therefore race:

```
T1: read {A}  → compute {A, B} → appendEvent({A, B})
T2: read {A}  → compute {A, C} → appendEvent({A, C})   ← B is lost
```

To prevent this, `SessionManager` keeps a `ConcurrentMap<String, Object> sessionWriteLocks` indexed by `session.id()` and serializes the read-modify-write pair under that monitor:

```java
synchronized (writeLockFor(session)) {
    Set<String> updated = getUpdatedProcessedIds(session);   // read
    updated.addAll(ids);                                     // mutate
    sessionService.appendEvent(session, event).blockingAwait(); // write — completes under lock
}
```

The mutating Completable runs on `Schedulers.io()` so the blocking call never sits on a Netty event loop. Distinct sessions are unaffected: their reads/writes still execute in parallel.

The lock entry is removed when the session is permanently deleted (`deleteSession` callback), bounding the registry to the set of active sessions.

### Scope of guarantee

This serialization is **JVM-local**. If the middleware is deployed in a cluster and requests for the same session can land on different instances, the per-session lock does not protect across JVMs. Sticky session routing (e.g. by `threadId` at the load balancer) is the simplest mitigation. A distributed lock or an ADK-side optimistic-concurrency mechanism would be needed for a true multi-instance guarantee.