# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **NEW**: Streaming function call arguments support for Gemini 3+ models via Vertex AI (#822)
  - Enables real-time streaming of `TOOL_CALL_ARGS` events as the model generates function call arguments incrementally
  - Activated via `streaming_function_call_arguments=True` on `ADKAgent` / `ADKAgent.from_app()`
  - Requires `google-adk >= 1.24.0` (version-gated; emits a warning and disables on older versions)
  - Requires `stream_function_call_arguments=True` in the model's `GenerateContentConfig` and SSE streaming mode
  - JSON deltas are emitted as concatenable fragments: clients join all `TOOL_CALL_ARGS.delta` values to reconstruct the complete arguments JSON
  - Integrates with predictive state updates: `PredictState` CustomEvents are emitted before `TOOL_CALL_START` for configured tools
  - New `stream_tool_call` field on `PredictStateMapping` defers `TOOL_CALL_END` for LRO/HITL workflows
  - Final aggregated (non-partial) events are automatically suppressed to prevent duplicate tool call emissions
  - Confirmed function call IDs are remapped to the streaming ID so `TOOL_CALL_RESULT` uses a consistent ID
  - No upstream monkey-patches or workarounds required (google/adk-python#4311 is fixed in ADK 1.24.0)

### Deprecated

- **DEPRECATED**: Non-resumable (fire-and-forget) HITL flow via `ADKAgent(adk_agent=...)` with client-side tools
  - A `DeprecationWarning` is now emitted at runtime when the old-style HITL early-return path is triggered
  - Use `ADKAgent.from_app()` with `ResumabilityConfig(is_resumable=True)` for human-in-the-loop workflows
  - The direct constructor remains fully supported for agents without client-side tools (chat-only, backend-tool-only)
  - See [USAGE.md](./USAGE.md#migrating-to-resumable-hitl) for migration instructions

### Breaking Changes

- **BREAKING**: AG-UI client tools are no longer automatically included in the root agent's toolset (#903)
  - You must now explicitly add `AGUIToolset` to your agent's tools list to access AG-UI client tools
  - Tool name conflicts are no longer automatically resolved by removing AG-UI tools
  - New `AGUIToolset` class provides explicit control over tool inclusion with `tool_filter` and `tool_name_prefix` parameters
  - This change enables proper support for Orchestrator-style ADK agents where sub-agents need access to client tools
  - **See the [Migration Guide](./README.md#migrating-from-v04x) in README.md for upgrade instructions**
  - Huge thanks to **@jplikesbikes** for this contribution!

### Security

- Upgrade vulnerable transitive dependencies: aiohttp (3.13.3), urllib3 (2.6.3), authlib (1.6.6), pyasn1 (0.6.2), mcp (1.25.0), fastapi (0.128.0), starlette (0.49.3)

### Fixed

- **FIXED**: Thought parts separated from text in message history (#1110, #1118, #1124)
  - `adk_events_to_messages()` was concatenating thought parts (Part.thought=True) with regular text into a single AssistantMessage.content string, causing internal model reasoning to leak into the visible chat when users reloaded sessions
  - Thought parts are now emitted as ReasoningMessage (role="reasoning") before the AssistantMessage, matching the live streaming behavior where THINKING_* events are already separated from TEXT_MESSAGE events
  - Thanks to **@lakshminarasimmanv** for identifying and fixing this issue!
- **FIXED**: Duplicate function_response events when using LongRunningFunctionTool (#1074, #1075)
  - Eliminated duplicate function_response events that were persisted to session database with different invocation_ids
  - Fix works for all agent types (simple LlmAgent and composite SequentialAgent/LoopAgent)
  - Maintains correct invocation_id from client's run_id for DatabaseSessionService compatibility
  - Preserves HITL resumption functionality for composite agents
  - Supports stateless client patterns that re-send full message history
  - Thanks to **@bajayo** for identifying the issue, providing comprehensive tests (529 lines!), and implementing the initial fix
  - Regression fix ensures compatibility across all agent types and usage patterns

- **FIXED**: Invocation ID handling for HITL resumption with composite agents (#1080)
  - Fixed "No agent to transfer to" errors when resuming after HITL pauses by conditionally passing `invocation_id` based on root agent type
  - Composite orchestrators (SequentialAgent, LoopAgent) now correctly receive `invocation_id` in `run_async()` to restore internal state on HITL resumption
  - Standalone LlmAgents and LlmAgents with transfer targets no longer receive `invocation_id`, preventing ValueError in `_get_subagent_to_resume()`
  - Deferred `invocation_id` storage to post-run lifecycle to avoid stale session errors with DatabaseSessionService
  - Tool result submissions with trailing user messages now work correctly without causing ADK resumption errors
  - Thanks to **@lakshminarasimmanv** for this comprehensive fix!
- **FIXED**: Reload session on cache miss to populate events (#1021)
  - `_find_session_by_thread_id()` uses `list_sessions()` which returns metadata only; now reloads via `get_session()` after a cache miss so that session events are available
  - Thanks to **@lakshminarasimmanv** for this fix!
- **FIXED**: Duplicate TOOL_CALL event emission for client-side tools with ResumabilityConfig
  - With `ResumabilityConfig(is_resumable=True)`, ADK emits the same function call from up to
    three sources (LRO event, confirmed event with a different ID, and ClientProxyTool execution),
    causing the frontend to render tool call results (e.g., HITL task lists) multiple times
  - EventTranslator now accepts `client_tool_names` to skip emission for tools owned by
    `ClientProxyTool`, letting the proxy be the sole emitter for client-side tools
  - Bidirectional ID tracking between EventTranslator and ClientProxyTool prevents duplicates
    regardless of execution order
  - Added 12 regression tests covering LRO, confirmed, partial, and mixed tool call scenarios
- **FIXED**: Relax Python version constraint to allow Python 3.14 (#973)
  - Changed `requires-python` from `>=3.9, <3.14` to `>=3.10, <3.15`
  - Fixed `asyncio.get_event_loop()` deprecation in tests for Python 3.14 compatibility
  - Added `asyncio.timeout` compatibility shim for Python 3.10 in tests
- **FIXED**: LRO tool call events now emitted for resumable agents on all ADK versions
  - Previously, `_is_adk_resumable()` skipped `translate_lro_function_calls` entirely, expecting client_proxy_tool to emit events — this didn't work on ADK < 1.22.0
  - Now always emits TOOL_CALL_START/ARGS/END for LRO tools; only the early loop exit is gated on non-resumable agents
- **FIXED**: Stale `pending_tool_calls` no longer block session cleanup after middleware restart (#1051)
  - When a middleware instance restarts, the in-memory `_session_lookup_cache` is lost but `pending_tool_calls` persists in the database, causing sessions to accumulate indefinitely
  - Now clears `pending_tool_calls` when resuming a session after a cache miss (indicating middleware restart or failover)
  - **Note**: This fix assumes sticky sessions (session affinity) are configured at the load balancer level for multi-pod deployments with `DatabaseSessionService`. Without sticky sessions, cache misses are frequent and could prematurely clear valid pending tool calls from active HITL workflows.
  - Thanks to **@lakshminarasimmanv** for identifying and fixing this issue!
- **FIXED**: Agent events not persisted to session with `LongRunningFunctionTool` in SSE streaming mode (#1059)
  - With SSE streaming enabled (default), ADK yields `partial=True` events (not persisted) then `partial=False` events (persisted)
  - Previously, the middleware returned early when detecting LRO tools, abandoning the runner's async generator before the final non-partial event was consumed, causing ADK to never persist the agent's response
  - Now continues consuming events until a non-partial event is received, allowing ADK's natural persistence mechanism to complete
  - Thanks to **@bajayo** for reporting and fixing this issue!

## [0.4.2] - 2026-01-22

### Added
- **NEW**: Native support for `RunAgentInput.context` in ADK agents (#959)
  - Context from AG-UI is automatically stored in session state under `_ag_ui_context` key
  - Accessible in tools via `tool_context.state.get(CONTEXT_STATE_KEY, [])`
  - Accessible in instruction providers via `ctx.state.get(CONTEXT_STATE_KEY, [])`
  - For ADK 1.22.0+, context is also available via `RunConfig.custom_metadata['ag_ui_context']`
  - Follows the pattern established by LangGraph's context handling for cross-framework consistency
  - `CONTEXT_STATE_KEY` constant exported from package for easy access
  - See `examples/other/context_usage.py` for usage examples
- **NEW**: Convert Gemini thought summaries to AG-UI THINKING events (#951)
  - When using `ThinkingConfig(include_thoughts=True)` with Gemini 2.5+ models, thought summaries are now emitted as THINKING events
  - Backwards-compatible: gracefully degrades on older google-genai SDK versions without the `part.thought` attribute
  - No dependency version bumps required - works with existing `google-adk>=1.14.0`
  - Emits proper event sequence: `THINKING_START` → `THINKING_TEXT_MESSAGE_START/CONTENT/END` → `THINKING_END`
  - Thinking streams are properly closed when transitioning to regular text output
- **NEW**: Fine-grained session cleanup configuration via `delete_session_on_cleanup` and `save_session_to_memory_on_cleanup` parameters (#927)
  - Splits the previous `auto_cleanup` behavior into two independent controls
  - `delete_session_on_cleanup`: Controls whether sessions are deleted from ADK SessionService during cleanup (default: `True`)
  - `save_session_to_memory_on_cleanup`: Controls whether sessions are saved to MemoryService before cleanup (default: `True`)
  - Sessions with `pending_tool_calls` are preserved even when `delete_session_on_cleanup=True`
  - Parameters exposed on `ADKAgent` constructor and `ADKAgent.from_app()` classmethod
  - Thanks to @jplikesbikes for the contribution
- **NEW**: Flexible request state extraction in FastAPI endpoints (#925)
  - Added `extract_state` parameter to `add_adk_fastapi_endpoint()` and `create_adk_app()` for custom state extraction from requests
  - Enables extraction of request attributes beyond just headers (e.g., cookies, query params, authentication info)
  - `extract_headers` parameter has been marked for deprecation in favor of `extract_state`
  - Thanks to @jplikesbikes for the contribution
- **NEW**: `add_adk_fastapi_endpoint()` now accepts both `FastAPI` and `APIRouter` objects (#932)
  - Enables better organization of large FastAPI codebases by allowing routes to be added to APIRouters
  - The `app` parameter now accepts `FastAPI | APIRouter` types
  - Note: Using APIRouter may result in different validation error response codes (500 instead of 422 in some edge cases)
  - Thanks to @jplikesbikes for the contribution

### Fixed
- **FIXED**: Duplicate `TOOL_CALL_START` events with google-adk >= 1.22.0 (issue #968)
  - google-adk 1.22.0 enables `PROGRESSIVE_SSE_STREAMING` by default, which sends function call "previews" in partial events
  - The middleware now skips function calls from `partial=True` events, only processing confirmed calls (`partial=False`)
  - Backwards-compatible: uses `getattr(adk_event, 'partial', False)` for older google-adk versions without the attribute
- **FIXED**: `DatabaseSessionService` compatibility for HITL (human-in-the-loop) tool workflows (issue #957)
  - Added `invocation_id` to FunctionResponse events - required by `DatabaseSessionService` for event tracking
  - Session is now refreshed after `update_session_state` to prevent "stale session" errors from optimistic locking
  - Both code paths (tool results with user message, and tool results only) now properly persist events
  - Thanks to @lakshminarasimmanv for the contribution
- **FIXED**: Text message events not emitted when non-streaming response includes client function call (issue #906)
  - In non-streaming mode, when an ADK event contained both text and an LRO (long-running) tool call, text was skipped entirely
  - Added `translate_text_only()` method to EventTranslator to handle text extraction for LRO events
  - Modified LRO routing in ADKAgent to emit TEXT_MESSAGE events before TOOL_CALL events
- **FIXED**: `adk_events_to_messages()` not converting assistant messages from DatabaseSessionService (issue #905)
  - ADK agents set `author` to the agent's name (e.g., "my_agent"), not "model"
  - Previous check for `author == "model"` caused assistant messages to be silently dropped
  - Now treats any non-"user" author as an assistant message

## [0.4.1] - 2026-01-06

### Added
- **NEW**: Multimodal message support for user messages with inline base64-encoded binary data (#864)
  - `convert_message_content_to_parts()` function converts AG-UI `TextInputContent` and `BinaryInputContent` to ADK `types.Part` objects
  - Supports `image/png`, `image/jpeg`, and other MIME types via `inline_data` with base64-decoded bytes
  - Gracefully ignores unsupported binary content (URL-only, id-only references) with warnings
  - Invalid base64 data is logged and skipped without crashing
- **NEW**: Integration tests for multimodal input handling (`test_from_app_with_valid_mime_type`, `test_from_app_with_unsupported_mime_type`)
- **NEW**: Unit tests for multimodal content conversion in `test_utils_converters.py`
- **NEW**: `ADKAgent.from_app()` classmethod for creating agents from ADK App instances (#844)
  - Enables access to App-level features: plugins, resumability, context caching, events compaction
  - Creates per-request App copies with modified agents using `model_copy()` to preserve all configs
  - Includes `plugin_close_timeout` parameter (requires ADK 1.19+, silently ignored on older versions)
  - Runtime detection of ADK version capabilities for forward compatibility
- **NEW**: Integration tests for `from_app()` functionality (`test_from_app_integration.py`)
- **DOCUMENTATION**: Added "Using App for Full ADK Features" section to USAGE.md

### Changed
- **IMPROVED**: Message content conversion now uses `convert_message_content_to_parts()` for multimodal support in `_convert_latest_user_message()` and `convert_ag_ui_messages_to_adk()`

### Fixed
- **FIXED**: Thread ID to Session ID mapping for VertexAI session services (#870)
  - AG-UI `thread_id` is now transparently mapped to ADK `session_id` (which may differ, e.g., VertexAI generates numeric IDs)
  - Backend session IDs never leak to frontend AG-UI events - all events use the original `thread_id`
  - Session state stores metadata (`_ag_ui_thread_id`, `_ag_ui_app_name`, `_ag_ui_user_id`) for recovery after middleware restarts
  - `/agents/state` endpoint now accepts optional `appName` and `userId` parameters for explicit session lookup
  - Processed message tracking now uses `thread_id` as key for consistency

## [0.4.0] - 2025-12-14

### Added
- **NEW**: Message history retrieval via `adk_events_to_messages()` function to convert ADK session events to AG-UI messages (#640)
- **NEW**: `emit_messages_snapshot` flag on ADKAgent for optional MESSAGES_SNAPSHOT emission at run end (default: false)
- **NEW**: Experimental `/agents/state` POST endpoint for on-demand thread state and message history retrieval (#640)
- **NEW**: HTTP header extraction support in FastAPI endpoint via `extract_headers` parameter (#740)
- **NEW**: Predictive state updates support for ADK middleware
- **NEW**: Agentic generative UI agent example (`agentic_generative_ui`)
- **NEW**: Comprehensive live server integration tests using uvicorn

### Fixed
- **FIXED**: Client-side tool results now persist to ADK session database for proper history tracking
- **FIXED**: Improved duplicate detection for Claude and accumulated text streams
- **FIXED**: Historical tool results no longer re-processed on replay
- **FIXED**: Skip consolidated text during streaming to prevent duplicates (issue #742)
- **FIXED**: Route `skip_summarization` events through `translate()` for proper ToolCallResult emission (issue #765)
- **FIXED**: Emit final text response after backend tool completion
- **FIXED**: Filter synthetic `confirm_changes` tool results in ADK middleware
- **FIXED**: Improved event handling and HITL tool processing
- **FIXED**: Prevent duplicate tool calls when processing tool results
- **FIXED**: Multi-turn conversation failure with None user_message (issue #769)
- **FIXED**: Filter empty text events to prevent frontend crash

### Enhanced
- **TESTING**: Added multi-turn conversation tests (issue #769)
- **TESTING**: Added comprehensive tests for message history features including live server tests
- **DOCUMENTATION**: Document thread_id to session_id mapping and initial state handling

## [0.3.6] - 2025-11-20

### Fixed
- Version bump for PyPI publishing

## [0.3.5] - 2025-11-18

### Fixed
- Multi-turn conversation failure with None user_message (issue #769)

## [0.3.4] - 2025-11-15

### Fixed
- Event handling and HITL tool processing improvements
- Duplicate tool call prevention when processing tool results

## [0.3.3] - 2025-11-14

### Added
- **Transcript tracking**: ADKAgent now replays unseen transcript messages sequentially and keeps per-session ledgers of processed message IDs so system/user/assistant content is never dropped when HITL tool results arrive out of order.
- **Tool result validation**: Tool result batches are now checked against pending tool call IDs before being forwarded, and skipped batches are marked processed to prevent repeated replays.
- **State snapshots**: EventTranslator surfaces ADK `state_snapshot` payloads as AG-UI `StateSnapshotEvent`s so clients receive full session dumps alongside deltas.

### Changed
- **Message conversion**: `flatten_message_content()` now flattens `TextInputContent`/`BinaryInputContent` payloads before building ADK `Content` objects, allowing complex UI messages to flow through unchanged.
- **Protocol dependency**: Minimum `ag-ui-protocol` version was bumped to `0.1.10` to align with the new event surface area.
- **Noise reduction**: Removed verbose diagnostic logging around event translation and stream handling while adding duplicate tool call detection to keep logs actionable.

### Fixed
- **Tool flows**: Guarding tool batches that have no matching pending tool calls eliminates spurious run errors and keeps processed message IDs consistent; regression tests cover combined tool-result/user-message submissions and state snapshot passthrough.

---

## Historical Releases (from previous repository)

> **Note**: The releases below were versioned when this code resided in a separate repository.
> Version numbers were reset when the code was integrated into the ag-ui-protocol monorepo.
> These entries are preserved for historical reference.

---

## [0.6.0] - 2025-08-07

### Changed
- **CONFIG**: Made ADK middleware base URL configurable via `ADK_MIDDLEWARE_URL` environment variable in dojo app
- **CONFIG**: Added `adkMiddlewareUrl` configuration to environment variables (defaults to `http://localhost:8000`)
- **DEPENDENCIES**: Upgraded Google ADK from 1.6.1 to 1.9.0 - all 271 tests pass without modification
- **DOCUMENTATION**: Extensive documentation restructuring for improved organization and clarity

## [0.5.0] - 2025-08-05

### Breaking Changes
- **BREAKING**: ADKAgent constructor now requires `adk_agent` parameter instead of `agent_id` for direct agent embedding
- **BREAKING**: Removed AgentRegistry dependency - agents are now directly embedded in middleware instances
- **BREAKING**: Removed `agent_id` parameter from `ADKAgent.run()` method
- **BREAKING**: Endpoint registration no longer extracts agent_id from URL path
- **BREAKING**: AgentRegistry class removed from public API

### Architecture Improvements
- **ARCHITECTURE**: Eliminated AgentRegistry entirely - simplified architecture by embedding ADK agents directly
- **ARCHITECTURE**: Cleaned up agent registration/instantiation redundancy (issue #24)
- **ARCHITECTURE**: Removed confusing indirection where endpoint agent didn't determine execution
- **ARCHITECTURE**: Each ADKAgent instance now directly holds its ADK agent instance
- **ARCHITECTURE**: Simplified method signatures and removed agent lookup overhead

### Fixed
- **FIXED**: All 271 tests now pass with new simplified architecture
- **TESTS**: Updated all test fixtures to match new ADKAgent.run(input_data) signature without agent_id parameter
- **TESTS**: Fixed test expectations in test_endpoint.py to work with direct agent embedding architecture
- **TESTS**: Updated all test fixtures to work with new agent embedding pattern
- **EXAMPLES**: Updated examples to demonstrate direct agent embedding pattern

### Added
- **NEW**: SystemMessage support for ADK agents (issue #22) - SystemMessages as first message are now appended to agent instructions
- **NEW**: Comprehensive tests for SystemMessage functionality including edge cases
- **NEW**: Long running tools can be defined in backend side as well
- **NEW**: Predictive state demo is added in dojo App

### Fixed  
- **FIXED**: Race condition in tool result processing causing "No pending tool calls found" warnings
- **FIXED**: Tool call removal now happens after pending check to prevent race conditions
- **IMPROVED**: Better handling of empty tool result content with graceful JSON parsing fallback
- **FIXED**: Pending tool call state management now uses SessionManager methods (issue #25)
- **FIXED**: Pending tools issue for normal backend tools is now fixed (issue #32)
- **FIXED**: TestEventTranslatorComprehensive unit test cases fixed

### Enhanced
- **LOGGING**: Added debug logging for tool result processing to aid in troubleshooting
- **ARCHITECTURE**: Consolidated agent copying logic to avoid creating multiple unnecessary copies
- **CLEANUP**: Removed unused toolset parameter from `_run_adk_in_background` method
- **REFACTOR**: Replaced direct session service access with SessionManager state management methods for pending tool calls

## [0.4.1] - 2025-07-13

### Fixed
- **CRITICAL**: Fixed memory persistence across sessions by ensuring consistent user ID extraction
- **CRITICAL**: Fixed ADK tool call ID mapping to prevent mismatch between ADK and AG-UI protocols

### Enhanced  
- **ARCHITECTURE**: Simplified SessionManager._delete_session() to accept session object directly, eliminating redundant lookups
- **TESTING**: Added comprehensive memory integration test suite (8 tests) for memory service functionality without requiring API keys
- **DOCUMENTATION**: Updated README with memory tools integration guidance and testing configuration instructions

### Added
- Memory integration tests covering service initialization, sharing, and cross-session persistence
- PreloadMemoryTool import support in FastAPI server examples
- Documentation for proper tool placement on ADK agents vs middleware

### Technical Improvements
- Consistent user ID generation for memory testing ("test_user" instead of dynamic anonymous IDs)
- Optimized session deletion to use session objects directly
- Enhanced tool call ID extraction from ADK context for proper protocol bridging
- Cleaned up debug logging statements throughout codebase


## [0.4.0] - 2025-07-11

### Bug Fixes
- **CRITICAL**: Fixed tool result accumulation causing Gemini API errors about function response count mismatch
- **FIXED**: `_extract_tool_results()` now only extracts the most recent tool message instead of all tool messages from conversation history
- **RELIABILITY**: Prevents multiple tool responses being passed to Gemini when only one function call is expected

### Major Architecture Change
- **BREAKING**: Simplified to all-long-running tool execution model, removing hybrid blocking/long-running complexity
- **REMOVED**: Eliminated blocking tool execution mode - all tools now use long-running behavior for consistency
- **REMOVED**: Removed tool futures, execution resumption, and hybrid execution state management
- **REMOVED**: Eliminated per-tool execution mode configuration (`tool_long_running_config`)

### Simplified Architecture
- **SIMPLIFIED**: `ClientProxyTool` now always returns `None` immediately after emitting events, wrapping `LongRunningFunctionTool` for proper ADK behavior
- **SIMPLIFIED**: `ClientProxyToolset` constructor simplified - removed `is_long_running` and `tool_futures` parameters
- **SIMPLIFIED**: `ExecutionState` cleaned up - removed tool future resolution and hybrid execution logic
- **SIMPLIFIED**: `ADKAgent.run()` method streamlined - removed commented hybrid model code
- **IMPROVED**: Agent tool combination now uses `model_copy()` to avoid mutating original agent instances

### Human-in-the-Loop (HITL) Support
- **NEW**: Session-based pending tool call tracking for HITL scenarios using ADK session state
- **NEW**: Sessions with pending tool calls are preserved during cleanup (no timeout for HITL workflows)
- **NEW**: Automatic tool call tracking when tools emit events and tool response tracking when results are received
- **NEW**: Standalone tool result handling - tool results without active executions start new executions
- **IMPROVED**: Session cleanup logic now checks for pending tool calls before deletion, enabling indefinite HITL workflows

### Enhanced Testing
- **TESTING**: Comprehensive test suite refactored for all-long-running architecture
- **TESTING**: 272 tests passing with 93% overall code coverage (increased from previous 269 tests)
- **TESTING**: Added comprehensive HITL tool call tracking tests (`test_tool_tracking_hitl.py`)
- **TESTING**: Removed obsolete test files for hybrid functionality (`test_hybrid_flow_integration.py`, `test_execution_resumption.py`)
- **TESTING**: Fixed all integration tests to work with simplified architecture and HITL support
- **TESTING**: Updated tool result flow tests to handle new standalone tool result behavior

### Performance & Reliability
- **PERFORMANCE**: Eliminated complex execution state tracking and tool future management overhead
- **RELIABILITY**: Removed potential deadlocks and race conditions from hybrid execution model
- **CONSISTENCY**: All tools now follow the same execution pattern, reducing cognitive load and bugs

### Technical Architecture (HITL)
- **Session State**: Pending tool calls tracked in ADK session state via `session.state["pending_tool_calls"]` array
- **Event-Driven Tracking**: `ToolCallEndEvent` events automatically add tool calls to pending list via `append_event()` with `EventActions.stateDelta`
- **Result Processing**: `ToolMessage` responses automatically remove tool calls from pending list with proper ADK session persistence
- **Session Persistence**: Sessions with pending tool calls bypass timeout-based cleanup for indefinite HITL workflows
- **Standalone Results**: Tool results without active executions start new ADK executions for proper session continuity
- **State Persistence**: Uses ADK's `append_event()` with `EventActions(stateDelta={})` for proper session state persistence

### Breaking Changes
- **API**: `ClientProxyToolset` constructor no longer accepts `is_long_running`, `tool_futures`, or `tool_long_running_config` parameters
- **BEHAVIOR**: All tools now behave as long-running tools - emit events and return `None` immediately
- **BEHAVIOR**: Standalone tool results now start new executions instead of being silently ignored
- **TESTING**: Test expectations updated for all-long-running behavior and HITL support

### Merged from adk-middleware (PR #7)
- **TESTING**: Comprehensive test coverage improvements - fixed all failing tests across the test suite
- **MOCK CONTEXT**: Added proper mock_tool_context fixtures to fix pydantic validation errors in test files
- **TOOLSET CLEANUP**: Fixed ClientProxyToolset.close() to properly cancel pending futures and clear resources
- **EVENT STREAMING**: Updated tests to expect RUN_FINISHED events that are now automatically emitted by enhanced _stream_events method
- **TEST SIGNATURES**: Fixed mock function signatures to match updated _stream_events method parameters (execution, run_id)
- **TOOL RESULT FLOW**: Updated tests to account for RunStartedEvent being emitted for tool result submissions
- **ERROR HANDLING**: Fixed malformed tool message test to correctly expect graceful handling of empty content (not errors)
- **ARCHITECTURE**: Enhanced toolset resource management - toolsets now properly clean up blocking tool futures on close
- **TEST RELIABILITY**: Improved test isolation and mock context consistency across all test files
- **TESTING**: Improved test coverage to 93% overall with comprehensive unit tests for previously untested modules
- **COMPLIANCE**: Tool execution now fully compliant with ADK behavioral expectations
- **OBSERVABILITY**: Enhanced logging for tool call ID tracking and validation throughout execution flow

### Error Handling Improvements
- **ENHANCED**: Better tool call ID mismatch detection with warnings when tool results don't match pending tools
- **ENHANCED**: Improved JSON parsing error handling with detailed error information including line/column numbers
- **ENHANCED**: More specific error codes for better debugging and error reporting
- **ENHANCED**: Better error messages in tool result processing with specific failure reasons

## [0.3.3] - 2025-11-14

### Added
- **Transcript tracking**: ADKAgent now replays unseen transcript messages sequentially and keeps per-session ledgers of processed message IDs so system/user/assistant content is never dropped when HITL tool results arrive out of order.
- **Tool result validation**: Tool result batches are now checked against pending tool call IDs before being forwarded, and skipped batches are marked processed to prevent repeated replays.
- **State snapshots**: EventTranslator surfaces ADK `state_snapshot` payloads as AG-UI `StateSnapshotEvent`s so clients receive full session dumps alongside deltas.

### Changed
- **Message conversion**: `flatten_message_content()` now flattens `TextInputContent`/`BinaryInputContent` payloads before building ADK `Content` objects, allowing complex UI messages to flow through unchanged.
- **Protocol dependency**: Minimum `ag-ui-protocol` version was bumped to `0.1.10` to align with the new event surface area.
- **Noise reduction**: Removed verbose diagnostic logging around event translation and stream handling while adding duplicate tool call detection to keep logs actionable.

### Fixed
- **Tool flows**: Guarding tool batches that have no matching pending tool calls eliminates spurious run errors and keeps processed message IDs consistent; regression tests cover combined tool-result/user-message submissions and state snapshot passthrough.

## [0.3.2] - 2025-07-08

### Added
- **NEW**: Hybrid tool execution model bridging AG-UI's stateless runs with ADK's stateful execution
- **NEW**: Per-tool execution mode configuration via `tool_long_running_config` parameter in `ClientProxyToolset`
- **NEW**: Mixed execution mode support - combine long-running and blocking tools in the same toolset
- **NEW**: Execution resumption functionality using `ToolMessage` for paused executions
- **NEW**: 13 comprehensive execution resumption tests covering hybrid model core functionality
- **NEW**: 13 integration tests for complete hybrid flow with minimal mocking
- **NEW**: Comprehensive documentation for hybrid tool execution model in README.md and CLAUDE.md
- **NEW**: `test_toolset_mixed_execution_modes()` - validates per-tool configuration functionality

### Enhanced
- **ARCHITECTURE**: `ClientProxyToolset` now supports per-tool `is_long_running` configuration
- **TESTING**: Expanded test suite to 185 tests with comprehensive coverage of both execution modes
- **DOCUMENTATION**: Added detailed hybrid execution flow examples and technical implementation guides
- **FLEXIBILITY**: Tools can now be individually configured for different execution behaviors within the same toolset

### Fixed
- **BEHAVIOR**: Improved timeout behavior for mixed execution modes
- **INTEGRATION**: Enhanced integration test reliability for complex tool scenarios
- **RESOURCE MANAGEMENT**: Better cleanup of tool futures and execution state across execution modes

### Technical Architecture
- **Hybrid Model**: Solves architecture mismatch between AG-UI's stateless runs and ADK's stateful execution
- **Tool Futures**: Enhanced `asyncio.Future` management for execution resumption across runs
- **Per-Tool Config**: `Dict[str, bool]` mapping enables granular control over tool execution modes
- **Execution State**: Improved tracking of paused executions and tool result resolution
- **Event Flow**: Maintains proper AG-UI protocol compliance during execution pause/resume cycles

### Breaking Changes
- **API**: `ClientProxyToolset` constructor now accepts `tool_long_running_config` parameter
- **BEHAVIOR**: Default tool execution mode remains `is_long_running=True` for backward compatibility

## [0.3.1] - 2025-07-08

### Added
- **NEW**: Tool-based generative UI demo for ADK in dojo application
- **NEW**: Multiple ADK agent support via `add_adk_fastapi_endpoint()` with proper agent_id handling
- **NEW**: Human-in-the-loop (HITL) support for long-running tools - `ClientProxyTool` with `is_long_running=True` no longer waits for tool responses
- **NEW**: Comprehensive test coverage for `is_long_running` functionality in `ClientProxyTool`
- **NEW**: `test_client_proxy_tool_long_running_no_timeout()` - verifies long-running tools ignore timeout settings
- **NEW**: `test_client_proxy_tool_long_running_vs_regular_timeout_behavior()` - compares timeout behavior between regular and long-running tools
- **NEW**: `test_client_proxy_tool_long_running_cleanup_on_error()` - ensures proper cleanup on event emission errors
- **NEW**: `test_client_proxy_tool_long_running_multiple_concurrent()` - tests multiple concurrent long-running tools
- **NEW**: `test_client_proxy_tool_long_running_event_emission_sequence()` - validates correct event emission order
- **NEW**: `test_client_proxy_tool_is_long_running_property()` - tests property access and default values

### Fixed
- **CRITICAL**: Fixed `agent_id` handling in `ADKAgent` wrapper to support multiple ADK agents properly
- **BEHAVIOR**: Disabled automatic tool response waiting in `ClientProxyTool` when `is_long_running=True` for HITL workflows

### Enhanced
- **ARCHITECTURE**: Long-running tools now properly support human-in-the-loop patterns where responses are provided by users
- **SCALABILITY**: Multiple ADK agents can now be deployed simultaneously with proper isolation
- **TESTING**: Enhanced test suite with 6 additional test cases specifically covering long-running tool behavior

### Technical Architecture
- **HITL Support**: Long-running tools emit events and return immediately without waiting for tool execution completion
- **Multi-Agent**: Proper agent_id management enables multiple ADK agents in single FastAPI application
- **Tool Response Flow**: Regular tools wait for responses, long-running tools delegate response handling to external systems
- **Event Emission**: All tools maintain proper AG-UI protocol compliance regardless of execution mode

## [0.3.0] - 2025-07-07

### Added
- **NEW**: Complete bidirectional tool support enabling AG-UI Protocol tools to execute within Google ADK agents
- **NEW**: `ExecutionState` class for managing background ADK execution with tool futures and event queues
- **NEW**: `ClientProxyTool` class that bridges AG-UI tools to ADK tools with proper event emission
- **NEW**: `ClientProxyToolset` class for dynamic toolset creation from `RunAgentInput.tools`
- **NEW**: Background execution support via asyncio tasks with proper timeout management
- **NEW**: Tool future management system for asynchronous tool result delivery
- **NEW**: Comprehensive timeout configuration: execution-level (600s default) and tool-level (300s default)
- **NEW**: Concurrent execution limits with configurable maximum concurrent executions and automatic cleanup
- **NEW**: 138+ comprehensive tests covering all tool support scenarios with 100% pass rate
- **NEW**: Advanced test coverage for tool timeouts, concurrent limits, error handling, and integration flows
- **NEW**: Production-ready error handling with proper resource cleanup and timeout management

### Enhanced
- **ARCHITECTURE**: ADK agents now run in background asyncio tasks while client handles tools asynchronously
- **OBSERVABILITY**: Enhanced logging throughout tool execution flow with detailed event tracking
- **SCALABILITY**: Configurable concurrent execution limits prevent resource exhaustion

### Technical Architecture
- **Tool Execution Flow**: AG-UI RunAgentInput → ADKAgent.run() → Background execution → ClientProxyTool → Event emission → Tool result futures
- **Event Communication**: Asynchronous event queues for communication between background execution and tool handler
- **Tool State Management**: ExecutionState tracks asyncio tasks, event queues, tool futures, and execution timing
- **Protocol Compliance**: All tool events follow AG-UI protocol specifications (TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END)
- **Resource Management**: Automatic cleanup of expired executions, futures, and background tasks
- **Error Propagation**: Comprehensive error handling with proper exception propagation and resource cleanup

### Breaking Changes
- **BEHAVIOR**: `ADKAgent.run()` now supports background execution when tools are provided
- **API**: Added `submit_tool_result()` method for delivering tool execution results
- **API**: Added `get_active_executions()` method for monitoring background executions
- **TIMEOUTS**: Added `tool_timeout_seconds` and `execution_timeout_seconds` parameters to ADKAgent constructor

## [0.2.1] - 2025-07-06

### Changed
- **SIMPLIFIED**: Converted from custom component logger system to standard Python logging
- **IMPROVED**: Logging configuration now uses Python's built-in `logging.getLogger()` pattern
- **STREAMLINED**: Removed proprietary `logging_config.py` module and related complexity
- **STANDARDIZED**: All modules now follow Python community best practices for logging
- **UPDATED**: Documentation (LOGGING.md) with standard Python logging examples

### Removed
- Custom `logging_config.py` module (replaced with standard Python logging)
- `configure_logging.py` interactive tool (no longer needed)
- `test_logging.py` (testing standard Python logging is unnecessary)

## [0.2.0] - 2025-07-06

### Added
- **NEW**: Automatic session memory option - expired sessions automatically preserved in ADK memory service
- **NEW**: Optional `memory_service` parameter in `SessionManager` for seamless session history preservation  
- **NEW**: 7 comprehensive unit tests for session memory functionality (61 total tests, up from 54)
- **NEW**: Updated default app name to "AG-UI ADK Agent" for better branding

### Changed
- **PERFORMANCE**: Enhanced session management to better leverage ADK's native session capabilities

### Added (Previous Release Features)
- **NEW**: Full pytest compatibility with standard pytest commands (`pytest`, `pytest --cov=src`)
- **NEW**: Pytest configuration (pytest.ini) with proper Python path and async support  
- **NEW**: Async test support with `@pytest.mark.asyncio` for all async test functions
- **NEW**: Test isolation with proper fixtures and session manager resets
- **NEW**: 54 comprehensive automated tests with 67% code coverage (100% pass rate)
- **NEW**: Organized all tests into dedicated tests/ directory for better project structure
- **NEW**: Default `app_name` behavior using agent name from registry when not explicitly specified
- **NEW**: Added `app_name` as required first parameter to `ADKAgent` constructor for clarity
- **NEW**: Comprehensive logging system with component-specific loggers (adk_agent, event_translator, endpoint)
- **NEW**: Configurable logging levels per component via `logging_config.py`
- **NEW**: `SessionLifecycleManager` singleton pattern for centralized session management
- **NEW**: Session encapsulation - session service now embedded within session manager
- **NEW**: Proper error handling in HTTP endpoints with specific error types and SSE fallback
- **NEW**: Thread-safe event translation with per-session `EventTranslator` instances
- **NEW**: Automatic session cleanup with configurable timeouts and limits
- **NEW**: Support for `InMemoryCredentialService` with intelligent defaults
- **NEW**: Proper streaming implementation based on ADK `finish_reason` detection
- **NEW**: Force-close mechanism for unterminated streaming messages
- **NEW**: User ID extraction system with multiple strategies (static, dynamic, fallback)
- **NEW**: Complete development environment setup with virtual environment support
- **NEW**: Test infrastructure with `run_tests.py` and comprehensive test coverage

### Changed
- **BREAKING**: `app_name` and `app_name_extractor` parameters are now optional - defaults to using agent name from registry
- **BREAKING**: `ADKAgent` constructor now requires `app_name` as first parameter
- **BREAKING**: Removed `session_service`, `session_timeout_seconds`, `cleanup_interval_seconds`, `max_sessions_per_user`, and `auto_cleanup` parameters from `ADKAgent` constructor (now managed by singleton session manager)
- **BREAKING**: Renamed `agent_id` parameter to `app_name` throughout session management for consistency
- **BREAKING**: `SessionInfo` dataclass now uses `app_name` field instead of `agent_id`
- **BREAKING**: Updated method signatures: `get_or_create_session()`, `_track_session()`, `track_activity()` now use `app_name`
- **BREAKING**: Replaced deprecated `TextMessageChunkEvent` with `TextMessageContentEvent`
- **MAJOR**: Refactored session lifecycle to use singleton pattern for global session management
- **MAJOR**: Improved event translation with proper START/CONTENT/END message boundaries
- **MAJOR**: Enhanced error handling with specific error codes and proper fallback mechanisms
- **MAJOR**: Updated dependency management to use proper package installation instead of path manipulation
- **MAJOR**: Removed hardcoded sys.path manipulations for cleaner imports

### Fixed
- **CRITICAL**: Fixed EventTranslator concurrency issues by creating per-session instances
- **CRITICAL**: Fixed session deletion to include missing `user_id` parameter
- **CRITICAL**: Fixed TEXT_MESSAGE_START ordering to ensure proper event sequence
- **CRITICAL**: Fixed session creation parameter consistency (app_name vs agent_id mismatch)
- **CRITICAL**: Fixed "SessionInfo not subscriptable" errors in session cleanup
- Fixed broad exception handling in endpoints that was silencing errors
- Fixed test validation logic for message event patterns
- Fixed runtime session creation errors with proper parameter passing
- Fixed logging to use proper module loggers instead of print statements
- Fixed event bookending to ensure messages have proper START/END boundaries

### Removed
- **DEPRECATED**: Removed custom `run_tests.py` test runner in favor of standard pytest commands

### Enhanced
- **Project Structure**: Moved all tests to tests/ directory with proper import resolution and PYTHONPATH configuration
- **Usability**: Simplified agent creation - no longer need to specify app_name in most cases
- **Performance**: Session management now uses singleton pattern for better resource utilization
- **Testing**: Comprehensive test suite with 54 automated tests and 67% code coverage (100% pass rate)
- **Observability**: Implemented structured logging with configurable levels per component
- **Error Handling**: Proper error propagation with specific error types and user-friendly messages
- **Development**: Complete development environment with virtual environment and proper dependency management
- **Documentation**: Updated README with proper setup instructions and usage examples
- **Streaming**: Improved streaming behavior based on ADK finish_reason for better real-time responses

### Technical Architecture Changes
- Implemented singleton `SessionLifecycleManager` for centralized session control
- Session service encapsulation within session manager (no longer exposed in ADKAgent)
- Per-session EventTranslator instances for thread safety
- Proper streaming detection using ADK event properties (`partial`, `turn_complete`, `finish_reason`)
- Enhanced error handling with fallback mechanisms and specific error codes
- Component-based logging architecture with configurable levels

## [0.1.0] - 2025-07-04

### Added
- Initial implementation of ADK Middleware for AG-UI Protocol
- Core `ADKAgent` class for bridging Google ADK agents with AG-UI
- Agent registry for managing multiple ADK agents
- Event translation between ADK and AG-UI protocols
- Session lifecycle management with configurable timeouts
- FastAPI integration with streaming SSE support
- Comprehensive test suite with 7 passing tests
- Example FastAPI server implementation
- Support for both in-memory and custom service implementations
- Automatic session cleanup and user session limits
- State management with JSON Patch support
- Tool call translation between protocols

### Fixed
- Import paths changed from relative to absolute for cleaner code
- RUN_STARTED event now emitted at the beginning of run() method
- Proper async context handling with auto_cleanup parameter

### Dependencies
- google-adk >= 0.1.0
- ag-ui (python-sdk)
- pydantic >= 2.0
- fastapi >= 0.100.0
- uvicorn >= 0.27.0
