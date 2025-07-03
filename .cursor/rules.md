# Project-Specific Rules for Cursor

## Task Management
- Always reference the current task ID when making changes
- Update task status in proompts/tasks.yaml when starting and completing work
- Commit changes with task ID in commit message: "[task-id] Description"

## Research and Information Gathering
- Use web_search for real-time research when needed
- Research current best practices before implementing new technologies
- Verify compatibility and versions of tools/libraries before use
- Document research findings in task updates or separate docs

## File Organization
- Task files go in /proompts/tasks/
- Documentation goes in /docs/ and /proompts/docs/
- Go SDK development in /go-sdk/
- Follow existing project structure patterns

## Code Standards for AG-UI Golang SDK
- Use Go 1.21+ features and best practices
- Follow golang-standards/project-layout for directory structure
- Use semantic versioning and maintain backward compatibility
- Implement comprehensive error handling with typed errors
- Design for testability with dependency injection
- Use Go modules and semantic import versioning
- Follow effective Go guidelines and common Go idioms
- Implement graceful shutdown and context cancellation
- Use structured logging and avoid global state

## Working with Tasks
1. Read proompts/tasks.yaml to find next pending task
2. Check all dependencies are completed
3. Research any unfamiliar technologies or requirements using web_search
4. Update status to 'in-progress'
5. Implement the task in go-sdk/ directory
6. Write tests with minimum 85% coverage
7. Update status to 'completed'
8. Add update entry with timestamp

## AG-UI Protocol Requirements
- Full compliance with AG-UI protocol specification
- Implement all 16 standardized event types
- Support HTTP/SSE and WebSocket transports
- JSON Patch (RFC 6902) state management
- Cross-platform support (Linux, macOS, Windows)
- Interoperability with TypeScript and Python SDKs

## Quality Standards
- Minimum 85% test coverage across all packages
- All public APIs must have comprehensive Go doc comments
- Zero tolerance for data races (use -race flag in testing)
- All linting rules must pass with golangci-lint strict configuration
- Performance benchmarks must be maintained and regression tested
- Memory usage must be profiled and optimized for production

## AI Agent Guidelines
- Reference proompts/docs/agent-guidelines.md for detailed practices
- Use proompts/docs/prompt-templates.md for common scenarios
- Consult proompts/docs/task-format-guide.md for YAML structure
- Leverage web_search for up-to-date information and verification
- Always check TypeScript SDK reference for compatibility guidance 