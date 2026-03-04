# AWS Strands Integration Architecture

This document explains how the AWS Strands integration inside `integrations/aws-strands/` is implemented today. It covers the Python adapter that speaks the AG-UI protocol and the FastAPI transport helpers. 

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
                                                │ add_strands_fastapi_endpoint│
                                                └─────────────┬──────────────┘
                                                              │
                                                              ▼
                                                 ┌─────────────────────────┐
                                                 │ StrandsAgent adapter    │
                                                 │ (src/ag_ui_strands/...) │
                                                 └─────────────┬───────────┘
                                                              │
                                                              ▼
                                                strands.Agent.stream_async()
```

1. The browser (or any AG-UI client) instantiates the standard AG-UI `HttpAgent` (or equivalent) and targets the Strands endpoint URL; there is no Strands-specific SDK on the client.
2. The client sends a `RunAgentInput` payload that contains the current thread state, previously executed tools, shared UI state, and the latest user message(s).
3. `add_strands_fastapi_endpoint` (or `create_strands_app`) registers a POST route that deserializes `RunAgentInput`, instantiates an `EventEncoder`, and streams whatever the Python `StrandsAgent` yields.
4. `StrandsAgent.run` wraps a concrete `strands.Agent` instance, forwards the derived user prompt into `stream_async`, and translates every event into AG-UI protocol events (text deltas, tool invocations, snapshots, etc.).
5. The encoded stream is delivered back to the client over `text/event-stream` (or JSON chunked mode) and rendered by AG-UI without any Strands-specific code on the frontend.

---

## Python Adapter Components

### `StrandsAgent` (`src/ag_ui_strands/agent.py`)

`StrandsAgent` is the heart of the integration. It encapsulates a Strands SDK agent and implements the AG-UI event contract:

- **Lifecycle framing**
  - Emits `RunStartedEvent` before touching Strands.
  - Always emits `RunFinishedEvent` unless an exception occurs, in which case it emits `RunErrorEvent` with `code="STRANDS_ERROR"`.
- **State priming**
  - If `RunAgentInput.state` is provided, it immediately publishes a `StateSnapshotEvent`, filtering out any `messages` field so the frontend remains the source of truth for the timeline.
  - Optionally rewrites the outgoing user prompt via `StrandsAgentConfig.state_context_builder`.
- **User message derivation**
  - The adapter inspects `input_data.messages` from newest-to-oldest, picks the most recent `"user"` message, and defaults to `"Hello"` if none exist.
- **Streaming text**
  - When Strands yields events with a `"data"` field, the adapter opens a new `TextMessageStartEvent` (once per turn), forwards every chunk as `TextMessageContentEvent`, and closes with `TextMessageEndEvent` when the Strands stream completes or is halted.
  - `stop_text_streaming` is toggled when certain tool behaviors demand ending narration as soon as a backend tool result arrives.
- **Tool call fan-out**
  - Strands emits tool usage metadata via `event["current_tool_use"]`. The adapter:
    - Records `tool_use_id`, arguments, and normalized JSON for replay.
    - Emits optional `StateSnapshotEvent` via `ToolBehavior.state_from_args`.
    - Translates declarative `PredictStateMapping` entries into a `CustomEvent(name="PredictState")`.
    - Streams arguments through an optional async generator (`args_streamer`) so large payloads can be revealed progressively.
    - Emits `ToolCallStartEvent`, zero or more `ToolCallArgsEvent`, and `ToolCallEndEvent`.
    - Automatically halts streaming when the call corresponds to a frontend-only tool (identified by matching `RunAgentInput.tools`) unless the configured behavior flips `continue_after_frontend_call`.
- **Tool result handling**
  - Strands encodes tool results inside `"message"` events whose role is `"user"` and whose contents include `toolResult`. The adapter:
    - Parses the blob into Python objects, tolerating single quotes or malformed JSON.
    - Reconstructs a short-lived pair of `AssistantMessage` (carrying the `tool_calls` array) and `ToolMessage`, then publishes a `MessagesSnapshotEvent` so the AG-UI timeline includes the function call and result (unless a pending backend tool result already exists or `skip_messages_snapshot` is set).
    - Executes `ToolBehavior.state_from_result` to hydrate shared state and `custom_result_handler` to emit additional AG-UI events (e.g., simulated progress via `StateDeltaEvent` in the generative UI example).
    - Honors `stop_streaming_after_result` by closing any active text message and halting the Strands stream early.
- **Frontend tool awareness**
  - `input_data.tools` supplies the frontend tool registry. Their names are used to (a) avoid double-invoking tool results that were literally produced by the UI, and (b) stop the Strands run after the LLM has issued a UI-only instruction.

### Configuration Layer (`src/ag_ui_strands/config.py`)

`StrandsAgentConfig` allows each tool to define bespoke behavior without editing the adapter:

| Primitive | Purpose |
| --- | --- |
| `tool_behaviors: Dict[str, ToolBehavior]` | Per-tool overrides keyed by the Strands tool name. |
| `state_context_builder` | Callable that enriches the outgoing prompt with the current shared state (useful for reiterating plan steps, recipes, etc.). |

`ToolBehavior` captures how the adapter should react:

- `skip_messages_snapshot`: Prevents helper messages from being appended when the UI is already in sync.
- `continue_after_frontend_call`: Keeps the stream alive after emitting a frontend tool call.
- `stop_streaming_after_result`: Cuts off text streaming when the backend produced a decisive result.
- `predict_state`: Iterable of `PredictStateMapping` objects that inform the UI how to project tool arguments into shared state before results arrive.
- `args_streamer`: Async generator that controls how tool arguments are leaked into the transcript (e.g., chunk large JSON payloads).
- `state_from_args` / `state_from_result`: Hooks that build `StateSnapshotEvent`s from tool inputs or outputs, enabling instant UI updates.
- `custom_result_handler`: Async iterator that can emit arbitrary AG-UI events (state deltas, confirmation messages, etc.).

Helper utilities:

- `ToolCallContext` / `ToolResultContext` expose the `RunAgentInput`, tool identifiers, arguments, and parsed results to hook functions.
- `maybe_await` awaits either coroutines or plain values, simplifying user-defined hooks.
- `normalize_predict_state` ensures the adapter can iterate predictably over mappings.

### Transport Helpers (`src/ag_ui_strands/endpoint.py` & `utils.py`)

The transport layer is intentionally lightweight:

- `add_strands_fastapi_endpoint(app, agent, path)` registers a POST route that:
  - Accepts a `RunAgentInput` body.
  - Instantiates `EventEncoder` using the requester’s `Accept` header to choose between SSE (`text/event-stream`) and newline-delimited JSON.
  - Streams whatever `StrandsAgent.run` yields, automatically encoding every AG-UI event.
  - Sends a `RunErrorEvent` with `code="ENCODING_ERROR"` if serialization fails mid-stream.
- `create_strands_app(agent, path="/")` bootstraps a FastAPI application, adds permissive CORS middleware (allowing any origin/method/header so AG-UI localhost builds can connect), and mounts the agent route.

### Packaging Surface (`src/ag_ui_strands/__init__.py`)

The package exposes only what downstream callers need:

```
StrandsAgent
create_strands_app / add_strands_fastapi_endpoint
StrandsAgentConfig / ToolBehavior / ToolCallContext / ToolResultContext / PredictStateMapping
```

This mirrors other AG-UI integrations (Agno, LangGraph, etc.), so documentation and examples can follow the same mental model.

---

## Example Entry Points (`python/examples/server/api/*.py`)

The repository includes four runnable FastAPI apps that showcase different features. Each example builds a Strands SDK agent, wraps it with `StrandsAgent`, and exposes it via `create_strands_app`:

| Module | Focus | Relevant Configuration |
| --- | --- | --- |
| `agentic_chat.py` | Baseline text generation with a frontend-only `change_background` tool. | No custom config; demonstrates automatic text streaming and frontend tool short-circuiting. |
| `backend_tool_rendering.py` | Backend-executed tools (`render_chart`, `get_weather`). | Shows how tool results become `MessagesSnapshotEvent`s and can be rendered directly in the UI. |
| `shared_state.py` | Collaborative recipe editor that streams server-side state. | Uses `state_context_builder`, `state_from_args`, and `state_from_result` to keep the UI’s recipe object synchronized. |
| `agentic_generative_ui.py` | Predictive and reactive state updates for generative UI surfaces. | Demonstrates `PredictStateMapping`, `custom_result_handler` emitting `StateDeltaEvent`s, and the `stop_streaming_after_result` flag. |

These examples double as integration tests: they exercise every built-in hook so regressions surface quickly during manual QA.

---

## Event Semantics Recap

| Strands Signal | Adapter Reaction | AG-UI Consumer Impact |
| --- | --- | --- |
| `stream_async` yields `{"data": ...}` | Emit text start/content/end | Updates conversational transcript incrementally. |
| `current_tool_use` announced | Emit tool call events, optional PredictState/state snapshots | Shows tool invocation cards and, when configured, optimistic UI updates. |
| `toolResult` packaged within `message.content[].toolResult` | Publish timeline snapshot, tool result hooks, optional halt | Renders backend tool outputs and state changes without additional frontend logic. |
| Stream sends `complete` or adapter decides to halt | Close text envelope (if needed) and emit `RunFinishedEvent` | Signals the UI that the run ended; frontends may start follow-up runs or show idle states. |
| Exceptions anywhere in the stack | Emit `RunErrorEvent` with the exception message | Frontend surfaces the failure and can offer retries. |

---

## Deployment & Runtime Characteristics

- **HTTP/SSE transport**: The adapter currently supports only HTTP POST requests plus streaming responses. Longer-lived transports (WebSockets, queues) are not part of the implemented surface.
- **Stateless server layer**: Every request is independent. All persistent context flows through `RunAgentInput.state` and `messages`, which the AG-UI runtime maintains.
- **Model compatibility**: The examples use `strands.models.gemini.GeminiModel`, but `StrandsAgent` works with any `strands.Agent` configured with compatible tools and prompts because it only relies on `stream_async`.
- **Error isolation**: Failures inside tool hooks (`state_from_args`, etc.) are swallowed so the main run can continue. Only uncaught exceptions in the core loop trigger `RunErrorEvent`.

---

## Summary

The AWS Strands integration adapts the Strands SDK to the AG-UI protocol by:

1. Wrapping `strands.Agent.stream_async` with `StrandsAgent`, which understands AG-UI events, tool semantics, and shared-state conventions.
2. Exposing a trivial FastAPI transport layer that handles encoding and CORS while remaining stateless.
3. Letting any existing AG-UI HTTP client connect directly to the endpoint—no Strands-specific frontend package is required.

All current behavior lives in `integrations/aws-strands/python/src/ag_ui_strands`. There are no hidden services or background workers; what is described above is the complete, production-ready implementation that powers today’s Strands integration.


