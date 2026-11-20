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
- iOS 15.0+ / macOS 13.0+

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


## Protocol 1.0 additions

The package also includes typed definitions checked against `spec/1.0/schema.json`,
lossless `AGUIJSON`, and the `agui-dojo-chat` command. All four upstream libraries
remain available. See [DERIVATION.md](DERIVATION.md) for provenance.

Media parts encode as `source: { type, value, mimeType }`. The
`InputContentSource` enum supports `.url`, `.data`, and opaque `.file` sources.
Existing URL/data initializers remain supported; new encodings use the 1.0
shape. Optional legacy `detail`, `format`, and `title` hints become metadata.
Empty run state encodes as `{}`, rather than the invalid 1.0 `null` sentinel.

The XCTest suite includes schema fixtures, runtime event-decoder fixtures,
client regressions, and offline HTTP/SSE conformance. The stream lane explicitly
skips six optional peer-era fixtures and the documented TypeScript enum gap;
SHOULD-level warning text is not asserted. Modern media decoding is tested
independently, including the canonical multimodal user-message fixture. All
previously parked client test files now compile and run under SwiftPM.

From this package directory:

```bash
swift build
swift test
# With a running local dojo (optional):
AGUI_DOJO_BASE_URL=http://127.0.0.1:18000 swift test --filter DojoIntegrationTests
swift run agui-dojo-chat "Hello"
```

The dojo command defaults to `http://127.0.0.1:18000`; set `AGUI_DOJO_BASE_URL`
to use a different local server. Live dojo tests skip unless that variable is set.
The production networking and UI targets require an Apple platform; Linux
core-only or mock-transport checks do not replace the macOS CI suite.
