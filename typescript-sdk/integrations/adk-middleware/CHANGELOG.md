# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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