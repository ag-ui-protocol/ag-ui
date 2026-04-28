# AGUISwift

[![CI](https://github.com/paduh/ag-ui-swift/actions/workflows/ci.yml/badge.svg)](https://github.com/paduh/ag-ui-swift/actions/workflows/ci.yml)
[![Documentation](https://github.com/paduh/ag-ui-swift/actions/workflows/docs.yml/badge.svg)](https://github.com/paduh/ag-ui-swift/actions/workflows/docs.yml)

The AG-UI Swift SDK is a Swift library for building AI agent user interfaces that implement the Agent User Interaction Protocol (AG-UI). It provides real-time streaming communication between Swift applications and AI agents.

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

API documentation is automatically generated and published to [GitHub Pages](https://paduh.github.io/ag-ui-swift/).

For local documentation generation, see the [Documentation README](docs/README.md).

### Local Testing Setup

To test documentation generation locally before pushing:

**1. Generate documentation:**
```bash
./test-docs-local.sh
```

This generates documentation for all targets in the `docs-test/` directory, matching the CI workflow.

**2. Verify structure:**
```bash
./verify-docs-structure.sh
```

**3. Serve locally:**

Choose one of these methods:

```bash
# Python 3 (Recommended)
python3 -m http.server 8000 --directory docs-test

# Node.js
npx serve docs-test

# PHP
php -S localhost:8000 -t docs-test
```

Then open `http://localhost:8000` in your browser.

**Note:** When testing locally, the base path `/ag-ui-swift/$target` won't match exactly because you're serving from `localhost:8000`. However, you can verify:
- All files are generated correctly
- The structure matches GitHub Pages expectations
- Links between pages work
- The landing page navigation functions properly

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


## Contributing

We welcome contributions! Please follow our development workflow:

### Quick Start

1. **Install Git Hooks** (prevents direct commits to main):
   ```bash
   ./scripts/install-git-hooks.sh
   ```

2. **Create a Feature Branch**:
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

