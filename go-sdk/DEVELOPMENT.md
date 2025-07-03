# Development Guide

Welcome to the AG-UI Go SDK development environment! This guide serves as your central hub for all development resources, tools, and workflows.

## 🚀 Quick Start

```bash
# Clone and setup
git clone https://github.com/ag-ui/go-sdk.git
cd go-sdk

# Install all development tools
make tools-install
# OR use the automated script
./scripts/install-tools.sh

# Verify everything is working
make full-check
```

## 📋 Development Resources

### Core Documentation
- **[README.md](README.md)** - Project overview and getting started
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution guidelines and development workflow
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System architecture and design decisions
- **[Dependencies](docs/dependencies.md)** - Complete dependency documentation and management strategy

### Configuration Files
- **[.golangci.yml](.golangci.yml)** - Comprehensive linting configuration (25+ enabled linters)
- **[.github/dependabot.yml](.github/dependabot.yml)** - Automated dependency updates with security focus
- **[Makefile](Makefile)** - 15+ development targets for streamlined workflow

### Automation Scripts
- **[scripts/install-tools.sh](scripts/install-tools.sh)** - Cross-platform development tool installation
- **[scripts/update-deps.sh](scripts/update-deps.sh)** - Safe dependency update automation

## 🛠️ Development Tools

### Required Tools
All tools can be installed with `make tools-install`:

| Tool | Purpose | Install Command |
|------|---------|-----------------|
| **protoc** | Protocol buffer compiler | Auto-installed by script |
| **protoc-gen-go** | Go protobuf code generation | `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest` |
| **golangci-lint** | Comprehensive static analysis | `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest` |
| **goimports** | Import management | `go install golang.org/x/tools/cmd/goimports@latest` |
| **govulncheck** | Vulnerability scanning | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| **gosec** | Security analysis | `go install github.com/securego/gosec/v2/cmd/gosec@latest` |
| **mockgen** | Mock generation | `go install go.uber.org/mock/mockgen@latest` |

### Tool Verification
```bash
make deps-verify  # Verify dependencies and security
protoc --version  # Check protocol buffer compiler
golangci-lint version  # Check linter
```

## 🎯 Development Workflow

### Essential Make Targets

#### Development Cycle
```bash
make dev          # Quick development cycle: format, vet, test
make pre-commit   # Pre-commit checks: format, lint-fix, test
make ci           # Full CI pipeline: format, vet, lint, test, build
```

#### Code Quality
```bash
make fmt          # Format code with gofmt
make lint         # Run golangci-lint
make lint-fix     # Run linter with auto-fix
make vet          # Run go vet
make test         # Run tests with coverage
make security     # Run security analysis
make full-check   # Comprehensive quality validation
```

#### Build & Install
```bash
make build        # Build binary
make build-all    # Cross-platform builds (Linux, macOS, Windows)
make install      # Install binary to GOPATH
make clean        # Clean build artifacts
```

#### Dependencies
```bash
make deps         # Download and tidy dependencies
make deps-update  # Update all dependencies
make deps-verify  # Verify integrity and security
```

#### Protocol Buffers
```bash
make proto-gen    # Generate Go code from .proto files
make proto-clean  # Clean generated protobuf files
```

### Protocol Buffer Development

The AG-UI Go SDK uses Protocol Buffers for efficient cross-platform message serialization. Protocol definitions are maintained in the `proto/` directory and Go code is automatically generated.

#### Setup Requirements
- `protoc` compiler (3.21+)
- `protoc-gen-go` plugin

#### Generation Workflow
```bash
# Install tools (if not already done)
make tools-install

# Generate Go code from proto files
make proto-gen

# Verify compatibility with other SDKs
go run scripts/verify-proto-compatibility.go

# Clean generated files (if needed)
make proto-clean
```

#### Protocol Files
- `proto/events.proto` - Core AG-UI event definitions (16 event types)
- `proto/types.proto` - Common message types (Message, ToolCall)
- `proto/patch.proto` - JSON Patch operations for state deltas

Generated Go code is placed in `pkg/proto/generated/` and includes:
- Proper Go naming conventions (PascalCase)
- JSON serialization tags (camelCase for web compatibility)
- Cross-SDK compatibility with TypeScript and Python implementations

For detailed information, see [proto/README.md](proto/README.md).

### Development Best Practices

#### Before Committing
```bash
make pre-commit   # Ensures code quality
```

#### Before Pushing
```bash
make full-check   # Comprehensive validation
```

#### Regular Maintenance
```bash
make deps-update  # Keep dependencies current
make security     # Check for vulnerabilities
```

## 🏗️ Project Structure

```
go-sdk/
├── cmd/                 # CLI applications
│   └── ag-ui-cli/      # Main CLI tool
├── pkg/                 # Public packages
│   ├── client/         # Client implementation
│   ├── core/           # Core types and interfaces
│   ├── encoding/       # Message encoding
│   ├── middleware/     # Middleware components
│   ├── proto/          # Generated protobuf code
│   │   └── generated/  # Auto-generated Go code from .proto files
│   ├── server/         # Server implementation
│   ├── state/          # State management
│   ├── tools/          # Development tools
│   └── transport/      # Transport implementations
├── internal/           # Private packages
├── proto/              # Protocol buffer definitions
│   ├── events.proto    # Core AG-UI event definitions
│   ├── types.proto     # Common message types
│   └── patch.proto     # JSON Patch operations
├── scripts/            # Automation scripts
├── test/               # Test data and integration tests
└── tools/              # Development tools
```

## 🔒 Security & Quality Assurance

### Automated Security Checks
- **govulncheck**: Scans for known vulnerabilities
- **gosec**: Static security analysis
- **dependabot**: Automated dependency updates with security priority
- **golangci-lint**: Includes security-focused linters

### Quality Standards
- **Test Coverage**: Aim for >80% coverage
- **Linting**: 25+ enabled linters with strict rules
- **Documentation**: Comprehensive GoDoc for all public APIs
- **Error Handling**: Explicit error handling throughout

## 📚 Additional Resources

### Go Development
- [Effective Go](https://golang.org/doc/effective_go.html)
- [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments)
- [100 Go Mistakes](https://100go.co/) - Common pitfalls to avoid

### Project-Specific
- [AG-UI Protocol Specification](https://github.com/ag-ui/protocol) (coming soon)
- [Example Applications](examples/) - Reference implementations
- [Integration Guides](../typescript-sdk/integrations/) - Framework integrations

### Community
- [Go Security Mailing List](https://groups.google.com/g/golang-security)
- [AG-UI Discussions](https://github.com/ag-ui/ag-ui/discussions)

## 🐛 Troubleshooting

### Common Issues

#### Tool Installation Failures
```bash
# Check Go version (requires 1.21+)
go version

# Verify GOPATH/bin is in PATH
echo $PATH | grep $(go env GOPATH)/bin

# Reinstall tools
make tools-install
```

#### Dependency Issues
```bash
# Clean and rebuild
go clean -modcache
make deps
```

#### Build Failures
```bash
# Check for breaking changes
go mod graph
make clean build
```

#### Linting Errors
```bash
# Auto-fix where possible
make lint-fix

# Check specific linter rules
golangci-lint linters
```

### Getting Help
1. Check this guide and linked documentation
2. Search existing [GitHub Issues](https://github.com/ag-ui/go-sdk/issues)
3. Create a new issue with:
   - Go version (`go version`)
   - Operating system
   - Error messages
   - Steps to reproduce

## 🎉 Next Steps

After setting up your development environment:

1. **Explore the codebase**: Start with `pkg/core/` for core types
2. **Run tests**: `make test` to ensure everything works
3. **Try the CLI**: `make run` to test the CLI tool
4. **Read CONTRIBUTING.md**: Understand our contribution process
5. **Check the roadmap**: See what features are planned

Happy coding! 🚀

---

**Need help?** Check our [Contributing Guide](CONTRIBUTING.md) or open an issue. 