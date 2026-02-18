# Langroid Integration Architecture

This document explains how the Langroid integration inside `integrations/langroid/` is implemented today. It covers the Python adapter that speaks the AG-UI protocol and the FastAPI transport helpers.

---

## System Overview

```
┌─────────────┐      RunAgentInput        ┌──────────────────────────┐
│  AG-UI UI   │ ────────────────► │ AG-UI HttpAgent (standard) │
└─────────────┘   (messages,      │  e.g., @ag-ui/client       │
                   tools, state)  └──────────────────────────┬──────┘
                                                             │ HTTP(S) POST + SSE
                                                             ▼
                                                ┌────────────────────────────┐
                                                │ FastAPI endpoint (Python)  │
                                                │ create_langroid_app        │
                                                └─────────────┬──────────────┘
                                                              │
                                                              ▼
                                                 ┌─────────────────────────┐
                                                 │ LangroidAgent adapter   │
                                                 │ (src/ag_ui_langroid/...)│
                                                 └─────────────┬───────────┘
                                                              │
                                                              ▼
                                                langroid.ChatAgent.llm_response()
```

1. The browser (or any AG-UI client) instantiates the standard AG-UI `HttpAgent` (or equivalent) and targets the Langroid endpoint URL; there is no Langroid-specific SDK on the client.
2. The client sends a `RunAgentInput` payload that contains the current thread state, previously executed tools, shared UI state, and the latest user message(s).
3. `create_langroid_app` (or `add_langroid_fastapi_endpoint`) registers a POST route that deserializes `RunAgentInput`, instantiates an `EventEncoder`, and streams whatever the Python `LangroidAgent` yields.
4. `LangroidAgent.run` wraps a concrete `langroid.ChatAgent` or `langroid.Task` instance, forwards the derived user prompt into `llm_response()`, and translates tool calls and responses into AG-UI protocol events (text deltas, tool invocations, snapshots, etc.).
5. The encoded stream is delivered back to the client over `text/event-stream` (or JSON chunked mode) and rendered by AG-UI without any Langroid-specific code on the frontend.

---

## Python Adapter Components

### `LangroidAgent` (`src/ag_ui_langroid/agent.py`)

`LangroidAgent` is the heart of the integration. It encapsulates a Langroid agent and implements the AG-UI event contract:

- **Lifecycle framing**
  - Emits `RunStartedEvent` before processing.
  - Always emits `RunFinishedEvent` unless an exception occurs, in which case it emits `RunErrorEvent` with `code="LANGROID_ERROR"`.
- **State priming**
  - If `RunAgentInput.state` is provided, it immediately publishes a `StateSnapshotEvent`, filtering out any `messages` field so the frontend remains the source of truth for the timeline.
  - Optionally rewrites the outgoing user prompt via `LangroidAgentConfig.state_context_builder`.
- **User message derivation**
  - The adapter inspects `input_data.messages` from newest-to-oldest, picks the most recent `"user"` message, and defaults to `"Hello"` if none exist.
  - Applies `state_context_builder` if configured to inject current state into the prompt.
- **Tool call detection**
  - Langroid adds `ToolMessage` instances to `message_history` after `llm_response()` when tools are requested.
  - The adapter checks `message_history` for `ToolMessage` instances (identified by `request` and `purpose` attributes).
  - Falls back to parsing tool calls from response content if not found in `message_history`.
  - Detects tool results in `message_history` to prevent infinite loops.
- **Tool execution flow**
  - **Frontend tools**: Identified by matching tool names in `input_data.tools`. The adapter:
    - Emits `ToolCallStartEvent`, `ToolCallArgsEvent`, and `ToolCallEndEvent`.
    - Emits `RunFinishedEvent` and returns, allowing CopilotKit to execute the tool in the browser.
  - **Backend tools**: Tools with handler methods on the agent. The adapter:
    - Emits `ToolCallStartEvent` and `ToolCallArgsEvent`.
    - Executes the tool method (matching the tool's `request` field name).
    - Emits `ToolCallResultEvent` with the tool result.
    - Emits `ToolCallEndEvent`.
    - Generates a conversational text response based on the tool result.
    - Emits `TextMessageStartEvent`, `TextMessageContentEvent`, and `TextMessageEndEvent`.
- **State management**
  - Supports `ToolBehavior.state_from_args` to emit `StateSnapshotEvent` when tool is called with arguments.
  - Supports `ToolBehavior.state_from_result` to emit state updates after tool execution.
  - Uses `state_context_builder` to inject current state into user prompts for shared state patterns.
- **Loop prevention**
  - Checks `message_history` for tool results to prevent re-executing the same tool.
  - Tracks executed tool calls per thread.
  - Detects pending tool results in `input_data.messages` to skip tool detection.
  - Clears placeholder text when tool calls are detected.
- **Text response generation**
  - For backend tools, generates conversational responses directly from tool result data.
  - Special handling for specific tools (e.g., `get_weather`, `render_chart`, `generate_recipe`) to format responses naturally.
  - Streams text in chunks via `TextMessageContentEvent`.

### Configuration Layer (`src/ag_ui_langroid/types.py`)

`LangroidAgentConfig` allows each tool to define bespoke behavior without editing the adapter:

| Primitive | Purpose |
| --- | --- |
| `tool_behaviors: Dict[str, ToolBehavior]` | Per-tool overrides keyed by the Langroid tool name. |
| `state_context_builder` | Callable that enriches the outgoing prompt with the current shared state. |

`ToolBehavior` captures how the adapter should react:

- `state_from_args`: Hook that builds `StateSnapshotEvent` from tool inputs, enabling instant UI updates when tool is called.
- `state_from_result`: Hook that builds `StateSnapshotEvent` from tool outputs, enabling reactive UI updates after tool execution.

Helper utilities:

- `ToolCallContext` exposes the `RunAgentInput`, tool identifiers, and arguments to hook functions.
- `ToolResultContext` extends `ToolCallContext` with result data and message ID.
- `maybe_await` awaits either coroutines or plain values, simplifying user-defined hooks.

### Transport Helpers (`src/ag_ui_langroid/endpoint.py`)

The transport layer is intentionally lightweight:

- `add_langroid_fastapi_endpoint(app, agent, path)` registers a POST route that:
  - Accepts a `RunAgentInput` body.
  - Instantiates `EventEncoder` using the requester's `Accept` header to choose between SSE (`text/event-stream`) and newline-delimited JSON.
  - Streams whatever `LangroidAgent.run` yields, automatically encoding every AG-UI event.
  - Sends a `RunErrorEvent` with `code="ENCODING_ERROR"` if serialization fails mid-stream.
- `create_langroid_app(agent, path="/")` bootstraps a FastAPI application, adds permissive CORS middleware (allowing any origin/method/header so AG-UI localhost builds can connect), and mounts the agent route.

### Packaging Surface (`src/ag_ui_langroid/__init__.py`)

The package exposes only what downstream callers need:

```
LangroidAgent
create_langroid_app / add_langroid_fastapi_endpoint
LangroidAgentConfig / ToolBehavior / ToolCallContext / ToolResultContext
```

This mirrors other AG-UI integrations (AWS Strands, LangGraph, etc.), so documentation and examples can follow the same mental model.

---

## Example Entry Points (`python/examples/server/api/*.py`)

The repository includes four runnable FastAPI apps that showcase different features. Each example builds a Langroid agent, wraps it with `LangroidAgent`, and exposes it via `create_langroid_app`:

| Module | Focus | Relevant Configuration |
| --- | --- | --- |
| `agentic_chat.py` | Baseline text generation with a frontend-only `change_background` tool. | No custom config; demonstrates automatic text streaming and frontend tool handling. |
| `backend_tool_rendering.py` | Backend-executed tools (`render_chart`, `get_weather`). | Shows how tool results are formatted into conversational responses and rendered in the UI. |
| `shared_state.py` | Collaborative recipe editor that streams server-side state. | Uses `state_context_builder`, `state_from_args` to keep the UI's recipe object synchronized. |
| `agentic_generative_ui.py` | Multi-step workflows with state management. | Demonstrates complex tool execution with state updates. |

These examples double as integration tests: they exercise every built-in hook so regressions surface quickly during manual QA.

---

## Event Semantics Recap

| Langroid Signal | Adapter Reaction | AG-UI Consumer Impact |
| --- | --- | --- |
| `llm_response()` returns text | Emit text start/content/end | Updates conversational transcript incrementally. |
| `ToolMessage` found in `message_history` | Emit tool call events, optional state snapshots | Shows tool invocation cards and, when configured, optimistic UI updates. |
| Tool method executed | Publish tool result, generate text response | Renders backend tool outputs and conversational responses without additional frontend logic. |
| Frontend tool detected | Emit tool call events, halt stream | CopilotKit executes tool in browser, UI updates immediately. |
| Run completes or error occurs | Close text envelope (if needed) and emit `RunFinishedEvent` or `RunErrorEvent` | Signals the UI that the run ended; frontends may start follow-up runs or show idle states. |

---

## Deployment & Runtime Characteristics

- **HTTP/SSE transport**: The adapter currently supports only HTTP POST requests plus streaming responses. Longer-lived transports (WebSockets, queues) are not part of the implemented surface.
- **Thread-based state management**: Each conversation thread gets its own agent instance stored in `_agents_by_thread`. This maintains conversation history per thread.
- **Model compatibility**: The examples use `langroid.language_models.OpenAIGPTConfig`, but `LangroidAgent` works with any Langroid `ChatAgent` configured with compatible tools and prompts because it only relies on `llm_response()` and `message_history`.
- **Error isolation**: Failures inside tool hooks (`state_from_args`, etc.) are swallowed so the main run can continue. Only uncaught exceptions in the core loop trigger `RunErrorEvent`.
- **Loop prevention**: Multiple mechanisms prevent infinite tool call loops:
  - Checking `message_history` for tool results before executing tools.
  - Detecting pending tool results in `input_data.messages`.
  - Tracking executed tool calls per thread.
  - Clearing placeholder text when tool calls are detected.

---

## Summary

The Langroid integration adapts Langroid agents to the AG-UI protocol by:

1. Wrapping `langroid.ChatAgent` or `langroid.Task` with `LangroidAgent`, which understands AG-UI events, tool semantics, and shared-state conventions.
2. Exposing a trivial FastAPI transport layer that handles encoding and CORS while remaining stateless.
3. Letting any existing AG-UI HTTP client connect directly to the endpoint—no Langroid-specific frontend package is required.

All current behavior lives in `integrations/langroid/python/src/ag_ui_langroid`. There are no hidden services or background workers; what is described above is the complete, production-ready implementation that powers today's Langroid integration.

