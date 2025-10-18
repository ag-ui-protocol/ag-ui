# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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