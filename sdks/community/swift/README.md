# AGUISwift

[![CI](https://github.com/paduh/ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/paduh/ag-ui/actions/workflows/ci.yml)

The AG-UI Swift SDK is a Swift library for building AI agent user interfaces that implement the Agent User Interaction Protocol (AG-UI). It provides real-time streaming communication between Swift applications and AI agents.

## Protocol compatibility

This SDK targets the pre-1.0 AG-UI contract: lifecycle, text, tool-call,
state snapshot/delta, and legacy thinking events over HTTP/SSE. It does not
claim full AG-UI 1.0 schema or stream conformance. In particular, 1.0 multimodal
content shapes and complete 1.0 event coverage are not guaranteed; unknown or
unsupported events follow the configured decoder strategy. Full 1.0 support
and conformance validation will follow separately.

## Architecture

The SDK follows a modular architecture with four main components:

### AGUIAgentSDK
High-level APIs for common agent interaction patterns.
- **AgUiAgent**: Stateless client for cases where no ongoing context is needed or the agent manages all state server-side
- **StatefulAgUiAgent**: Stateful client that maintains conversation history and sends it with each request
- **Builders**: Convenient builder patterns for agent configuration

### AGUIClient
Low-level client infrastructure and transport implementations.
- **HttpAgent**: Low-level HTTP transport implementation
- **AbstractAgent**: Base class for custom agent implementations
- **SseParser**: Server-Sent Events parser for streaming responses
- **EventStreamManager**: Event stream management and processing

#### HTTP streaming responses

`HttpTransport` applies configured request headers to both the default client and
injected `HTTPClient` implementations. Explicit headers override the default
`Accept` and `Content-Type` values; a supplied resume cursor overrides a configured
`Last-Event-ID` header.

A streaming run must return a 2xx status with `Content-Type: text/event-stream`.
Media type matching ignores case and accepts parameters such as `charset=utf-8`.
Non-2xx responses throw `ClientError.httpError(statusCode:)`; missing or incorrect
media types throw `ClientError.invalidResponse`.

### AGUICore
Protocol types, events, and message definitions.
- **Events**: All AG-UI protocol event types and serialization
- **Types**: Protocol message types and state management
- **Domain Layer**: Pure domain value objects and domain events
- **Infrastructure Layer**: Serialization and adapters

### AGUITools
Tool execution framework for extending agent capabilities.
- **ToolExecutor**: Protocol for implementing custom tools
- **ToolRegistry**: Tool registration and management
- **ToolExecutionManager**: Tool execution with circuit breaker patterns

## Requirements

- Swift 5.9+
- iOS 16.0+ / macOS 13.0+

## Installation with Swift Package Manager

The monorepo root exposes all four libraries through `Package.swift`. Add the
repository URL in Xcode, or declare it in your app's package manifest:

```swift
.package(url: "https://github.com/ag-ui-protocol/ag-ui.git", from: "0.1.0")
```

Then add the products you need to your target dependencies, for example:

```swift
.product(name: "AGUIAgentSDK", package: "ag-ui")
```

Version-based installation requires a published Swift release tag. Swift releases
use plain semantic version tags such as `0.1.0` on commits containing the root
manifest; reserve these tags for the Swift SDK. Until the first tag is published,
use a revision containing the manifest instead of a version requirement.

SwiftPM fetches the monorepo and caches the checkout. The initial download includes
the rest of the repository; targets compile only the Swift SDK sources.

Run `swift build` and `swift test` from the repository root to validate the public
package entry point. The manifest in this SDK directory remains available for
local development. Keep both manifests' products, dependencies, and targets aligned.

## Documentation

API documentation can be generated locally using the Swift-DocC plugin:

```bash
swift package generate-documentation
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


## Contributing

We welcome contributions! Please follow our development workflow:

### Quick Start

1. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make Changes & Test**:
   ```bash
   swift test
   swiftlint lint
   ```

4. **Create Pull Request**:
   ```bash
   git push -u origin feature/your-feature-name
   gh pr create
   ```

### Development Workflow

- **No direct commits to `main`** - All changes must go through pull requests
- **Code review required** - PRs must be approved by designated reviewers before merging
- **Branch naming**: `feature/`, `fix/`, `refactor/`, `docs/`
- **Follow TDD**: Write tests first, then implement
- **Code quality**: Format with SwiftFormat, lint with SwiftLint

See detailed guides:
- [Contributing Guide](CONTRIBUTING.md) - Full workflow and standards
- [Workflow Quick Reference](docs/WORKFLOW.md) - Common tasks and commands
- [Project Standards](CLAUDE.md) - Code conventions and architecture

### Before Submitting PR

- [ ] Tests pass: `swift test`
- [ ] Code formatted: `swift package plugin swiftformat`
- [ ] Linting passes: `swiftlint lint`
- [ ] Documentation updated
- [ ] Commit messages follow conventions

