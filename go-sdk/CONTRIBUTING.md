# Contributing to AG-UI Go SDK

Thank you for your interest in contributing to the AG-UI Go SDK! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites

- Go 1.21 or later
- Git
- Make (optional, for build automation)

### Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/ag-ui.git
   cd ag-ui/go-sdk
   ```

3. Install dependencies:
   ```bash
   go mod download
   ```

4. Verify the setup:
   ```bash
   go test ./...
   ```

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:
- `feature/add-websocket-transport`
- `fix/client-connection-leak`
- `docs/update-api-examples`
- `refactor/simplify-event-handling`

### Commit Messages

Follow conventional commit format:
```
type(scope): description

[optional body]

[optional footer]
```

Examples:
- `feat(client): add WebSocket transport support`
- `fix(server): resolve memory leak in connection pool`
- `docs(readme): update installation instructions`

### Code Style

#### Go Standards
- Follow [Effective Go](https://golang.org/doc/effective_go.html) guidelines
- Use `gofmt` for code formatting
- Use `golint` and `go vet` for code quality
- Follow the [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments)

#### Documentation
- Document all public APIs with godoc comments
- Include usage examples in documentation
- Update README.md for significant changes

#### Testing
- Write unit tests for all new functionality
- Maintain or improve test coverage
- Use table-driven tests where appropriate
- Include integration tests for end-to-end functionality

### Package Guidelines

#### Public API (pkg/)
- Keep interfaces minimal and focused
- Avoid breaking changes in public APIs
- Use semantic versioning principles
- Document all exported types and functions

#### Internal Implementation (internal/)
- Keep implementation details private
- Prefer composition over inheritance
- Use dependency injection for testability

### Code Organization

```go
// Package structure example
package client

import (
    // Standard library imports
    "context"
    "fmt"
    "net/http"

    // Third-party imports
    "github.com/gorilla/websocket"

    // Local imports
    "github.com/ag-ui/go-sdk/pkg/core"
    "github.com/ag-ui/go-sdk/internal/protocol"
)
```

## Testing

### Running Tests

```bash
# Run all tests
go test ./...

# Run tests with coverage
go test -cover ./...

# Run tests with race detection
go test -race ./...

# Run specific package tests
go test ./pkg/client
```

### Test Categories

1. **Unit Tests**: Test individual functions and methods
2. **Integration Tests**: Test component interactions
3. **End-to-End Tests**: Test complete workflows

### Mock Guidelines

- Use interfaces for dependency injection
- Generate mocks using tools like `mockgen`
- Keep mocks in `internal/testutil/mocks/`

## Documentation

### API Documentation

- Use godoc format for all public APIs
- Include examples in documentation
- Keep documentation up-to-date with code changes

### README Updates

Update the main README.md when:
- Adding new features
- Changing installation steps
- Updating examples
- Modifying project structure

## Pull Request Process

### Before Submitting

1. Ensure all tests pass
2. Run `go fmt ./...`
3. Run `go vet ./...`
4. Update documentation if needed
5. Add or update tests for new functionality

### PR Requirements

- Clear description of changes
- Reference related issues
- Include test coverage for new code
- Ensure CI passes
- Get approval from maintainers

### PR Template

```markdown
## Description
Brief description of the changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature  
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] Tests added for new functionality
```

## Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):
- `MAJOR.MINOR.PATCH`
- Major: Breaking changes
- Minor: New features (backward compatible)
- Patch: Bug fixes (backward compatible)

### Release Checklist

1. Update version in relevant files
2. Update CHANGELOG.md
3. Create release branch
4. Run full test suite
5. Create GitHub release
6. Update documentation

## Getting Help

### Communication Channels

- GitHub Issues: Bug reports and feature requests
- GitHub Discussions: General questions and ideas
- Code Reviews: Implementation feedback

### Issue Templates

When creating issues, use the appropriate template:
- Bug Report
- Feature Request
- Documentation Improvement
- Performance Issue

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the code and ideas, not the person
- Help create a welcoming environment

### Reporting Issues

Report any violations to the project maintainers via private message or email.

## Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes
- Project documentation

Thank you for contributing to the AG-UI Go SDK! 