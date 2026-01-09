# Changelog

All notable changes to ag-ui-4k will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] - 2025-12-29

### Added
- Agent subscriber system for opt-in lifecycle and event interception.
- Text message role fidelity in chunk transformation and state application.

### Changed
- Default apply pipeline now routes every event through subscribers before mutating state.
- State application respects developer/system/user roles when constructing streaming messages.

### Tests
- Expanded chunk transformation and state application coverage for role propagation and subscriber behavior.

### Performance Improvements
- Up to 2x faster compilation with K2 compiler
- Reduced memory usage in streaming scenarios
- Smaller binary sizes due to better optimization
- Improved coroutine performance with latest kotlinx.coroutines

## [0.1.0] - 2025-06-14

### Added
- Initial release of ag-ui-4k client library
- Core AG-UI protocol implementation for Kotlin Multiplatform
- HttpAgent client with SSE support for connecting to AG-UI agents
- Event-driven streaming architecture using Kotlin Flows
- Full type safety with sealed classes for events and messages
- Support for Android, iOS, and JVM platforms
- Comprehensive event types (lifecycle, messages, tools, state)
- State management with snapshots and deltas
- Tool integration for human-in-the-loop workflows
- Cancellation support through coroutines
- Built with Kotlin 2.1.21 and K2 compiler
- Powered by Ktor 3.1.3 for networking
- Uses kotlinx.serialization 1.8.1 for JSON handling
- Comprehensive documentation and examples
- GitHub Actions CI/CD workflow
- Detekt static code analysis