# Changelog

All notable changes to ag-ui-4k will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-09

### Added
- `StatefulAgUiAgent` records `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` and `TOOL_CALL_RESULT` events into per-thread conversation history. The next run's `RunAgentInput.messages` now carries assistant tool calls and matching tool results, which servers (e.g. `ag_ui_adk`) need to pair pending-tool-call bookkeeping across turns.

### Changed
- Upgrade Ktor from 3.1.3 to 3.2.4 (latest compatible with Kotlin 2.1.x)
- `ToolExecutionManager` silently skips tools that are not in the local registry instead of emitting an `Error: Tool 'X' is not available` `ToolMessage`. Lets server- or middleware-injected tool specs (e.g. the `@ag-ui/a2ui-middleware` `render_a2ui` tool, when not registered locally) flow through without poisoning history.

### Fixed
- Repair chatapp-swiftui XCFramework build: remove stale composite-build substitution for deleted kotlin-a2ui module, add missing a2ui-4k catalog entry, and align kotlinx-datetime on the 0.7.1-0.6.x-compat artifact for iOS compatibility

### Examples
- Update a2ui-4k dependency from 0.8.0 to 0.8.1 in chatapp examples
- Remove unnecessary core library desugaring from chatapp-shared (minSdk is 26)
- Migrate chatapp to `a2ui-4k 0.9.3` to render A2UI v0.9 surfaces.
- `ChatController` handles two new `ActivitySnapshotEvent` content shapes alongside the existing v0.8 wrap: (a) a single v0.9 envelope (`content.version == "v0.9"`), and (b) an `a2ui_operations` array emitted by the `@ag-ui/a2ui-middleware` Node bridge.
- Register `render_a2ui` as a client-side tool via the new `RenderA2UiToolExecutor` adapter wrapping `com.contextable.a2ui4k.agent.A2UiRenderTool`. The executor drives the local `SurfaceStateManager` directly and closes the AG-UI tool-call round-trip locally, so the middleware no longer has to synthesise a `TOOL_CALL_RESULT`.
- Send A2UI action results inline in the next user message (filtered from the chat transcript) for parity with stacks that do not honour `forwardedProps`.

## [0.2.6] - 2026-01-14

### Changed
- Lower minimum Android SDK from 26 to 24
- Lower Kotlin version from 2.2.20 to 2.1.20
- Update Android Gradle Plugin from 8.10.1 to 8.12.0
- Fix artifact group ID references from `com.agui:` to `com.ag-ui.community:`

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