# Contributing to AG-UI Elixir SDK

We welcome contributions from the community. This document provides guidelines and information for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ag_ui_ex.git`
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Install dependencies: `mix deps.get`
5. Run tests: `mix test`

## Development Setup

**Requirements:**
- Elixir >= 1.15
- Erlang/OTP >= 25

```bash
# Install dependencies
mix deps.get

# Run tests
mix test

# Run formatter
mix format

# Generate documentation
mix docs

# Run all checks (before submitting PR)
mix format --check-formatted && mix compile --warnings-as-errors && mix test
```

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready releases |
| `develop` | Integration branch for next release |
| `feature/*` | New features |
| `fix/*` | Bug fixes |
| `release/*` | Release preparation |

**Workflow:**
1. Branch from `develop`
2. Make your changes
3. Submit PR against `develop`
4. After review and merge, `develop` is periodically merged into `main` for releases

## Pull Request Process

1. Ensure your code compiles without warnings: `mix compile --warnings-as-errors`
2. Ensure all tests pass: `mix test`
3. Ensure code is formatted: `mix format --check-formatted`
4. Update documentation if you changed public APIs
5. Add tests for new functionality
6. Write a clear PR description explaining what and why

## Code Style

- Follow standard Elixir conventions
- Use `mix format` for consistent formatting
- Write typespecs (`@spec`) for all public functions
- Write `@moduledoc` and `@doc` for public modules and functions
- Use pattern matching in function heads over conditionals
- Prefer pipe operator chains for data transformation

## Testing

- Write tests for all new functionality
- Use `ExUnit` and follow existing test patterns
- Aim for comprehensive coverage of edge cases
- Run `mix test` before submitting PRs

## Commit Messages

Use conventional commit format:

```
type(scope): description

[optional body]
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

Examples:
- `feat(events): add ThinkingTextMessage event type`
- `fix(sse): handle empty event data gracefully`
- `docs: update README installation instructions`
- `test(state): add JSON Patch edge case tests`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include Elixir/OTP version information
- Provide a minimal reproduction case when possible
- Check existing issues before creating a new one

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
