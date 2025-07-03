# Dependencies

This document provides comprehensive information about the dependencies used in the AG-UI Go SDK project, including their purposes, version requirements, and management strategies.

## Overview

The AG-UI Go SDK has been designed with a careful selection of dependencies that provide essential functionality while maintaining security, performance, and maintainability. We follow a "minimal dependencies" philosophy, only including libraries that provide significant value.

## Core Runtime Dependencies

### Communication & Transport

#### Gorilla WebSocket
- **Package**: `github.com/gorilla/websocket`
- **Purpose**: WebSocket transport implementation for real-time bidirectional communication
- **Why chosen**: Industry-standard WebSocket library with excellent performance and RFC compliance
- **Version strategy**: Minor and patch updates automatically, major updates reviewed manually

#### gRPC
- **Package**: `google.golang.org/grpc`
- **Purpose**: High-performance gRPC transport for future protocol extensions
- **Why chosen**: Google's official gRPC implementation with strong ecosystem support
- **Version strategy**: Conservative updates due to protocol compatibility requirements

### Protocol & Serialization

#### Protocol Buffers
- **Package**: `google.golang.org/protobuf`
- **Purpose**: Protocol buffer runtime for efficient serialization and schema evolution
- **Why chosen**: Industry standard for efficient binary serialization with strong typing
- **Version strategy**: Major updates require careful testing with existing proto definitions

#### JSON Patch
- **Package**: `github.com/evanphx/json-patch/v5`
- **Purpose**: RFC 6902 compliant JSON Patch implementation for state synchronization
- **Why chosen**: Complete RFC 6902 implementation with excellent performance
- **Version strategy**: Regular updates, testing focused on patch operation correctness

### Utilities

#### UUID Generation
- **Package**: `github.com/google/uuid`
- **Purpose**: RFC 4122 compliant UUID generation for event IDs and correlation
- **Why chosen**: Google's well-maintained UUID library with crypto-secure random generation
- **Version strategy**: Regular updates, low risk due to stable API

#### Structured Logging
- **Package**: `github.com/sirupsen/logrus`
- **Purpose**: Structured logging with configurable levels and formatters
- **Why chosen**: Mature logging library with extensive formatter and hook ecosystem
- **Version strategy**: Regular updates, focus on maintaining log format compatibility

#### Extended Golang Libraries
- **Package**: `golang.org/x/sync`
- **Purpose**: Extended synchronization primitives (errgroup, semaphore, etc.)
- **Why chosen**: Official Go extended libraries with advanced concurrency patterns
- **Version strategy**: Regular updates, thoroughly tested due to concurrency sensitivity

- **Package**: `golang.org/x/net`
- **Purpose**: Extended network libraries and HTTP/2 support
- **Why chosen**: Official Go extended libraries required for advanced networking features
- **Version strategy**: Regular updates, coordinated with Go runtime updates

## Development Dependencies

### Testing Framework

#### Testify
- **Package**: `github.com/stretchr/testify`
- **Purpose**: Rich testing framework with assertions, mocks, and suites
- **Why chosen**: De facto standard testing library in Go ecosystem
- **Version strategy**: Regular updates, backward compatibility typically maintained

#### Mock Generation
- **Package**: `go.uber.org/mock`
- **Purpose**: Interface mock generation for testing
- **Why chosen**: Modern, well-maintained mock library with excellent Go 1.18+ generics support
- **Version strategy**: Regular updates, regenerate mocks after updates

### Code Quality & Security

#### golangci-lint
- **Package**: `github.com/golangci/golangci-lint`
- **Purpose**: Comprehensive static analysis and linting
- **Why chosen**: Industry standard linter aggregator with extensive rule set
- **Version strategy**: Regular updates to get latest linting rules and performance improvements

#### gosec
- **Package**: `github.com/securego/gosec/v2`
- **Purpose**: Security vulnerability scanning
- **Why chosen**: Specialized security scanner for Go code
- **Version strategy**: Regular updates to receive latest security rule definitions

#### govulncheck
- **Package**: `golang.org/x/vuln/cmd/govulncheck`
- **Purpose**: Known vulnerability checking against Go vulnerability database
- **Why chosen**: Official Go security scanning tool
- **Version strategy**: Regular updates to receive latest vulnerability data

### Code Generation

#### protoc-gen-go
- **Package**: `google.golang.org/protobuf/cmd/protoc-gen-go`
- **Purpose**: Protocol buffer code generation for Go
- **Why chosen**: Official protobuf code generator for Go
- **Version strategy**: Updates coordinated with protobuf runtime library

#### goimports
- **Package**: `golang.org/x/tools/cmd/goimports`
- **Purpose**: Import statement organization and formatting
- **Why chosen**: Official Go tool for import management
- **Version strategy**: Regular updates for improved formatting algorithms

## Dependency Management Strategy

### Version Pinning Strategy
- **Patch versions**: Automatically updated via Dependabot
- **Minor versions**: Automatically updated with comprehensive testing
- **Major versions**: Manual review required due to potential breaking changes
- **Security updates**: Automatically applied regardless of version type

### Update Schedule
- **Automated updates**: Weekly via Dependabot on Mondays
- **Manual reviews**: As needed for major version updates
- **Security patches**: Immediate application when available
- **Tool updates**: Weekly alongside dependency updates

### Compatibility Requirements
- **Go version**: Minimum Go 1.21+
- **Operating systems**: Linux, macOS, Windows
- **Architectures**: amd64, arm64
- **Network protocols**: HTTP/1.1, HTTP/2, WebSocket, gRPC

## Security Considerations

### Vulnerability Management
1. **Automated scanning**: govulncheck runs on every CI build
2. **Dependency scanning**: gosec analyzes all dependencies for known issues
3. **Update notifications**: Dependabot creates PRs for security updates
4. **Manual review**: Security-sensitive updates receive additional scrutiny

### Supply Chain Security
1. **Checksum verification**: go.sum ensures dependency integrity
2. **Source verification**: All dependencies from trusted sources
3. **Regular audits**: Quarterly review of all dependencies
4. **Minimal attack surface**: Keep dependency count minimal

## Development Workflow

### Adding New Dependencies
1. **Justification**: Document why the dependency is needed
2. **Alternatives**: Consider if existing dependencies or stdlib can provide the functionality
3. **Evaluation**: Assess maintenance status, security history, and community support
4. **Testing**: Comprehensive testing with the new dependency
5. **Documentation**: Update this file with the new dependency information

### Removing Dependencies
1. **Deprecation notice**: Announce intent to remove with timeline
2. **Migration path**: Provide alternative solutions
3. **Testing**: Ensure all functionality still works without the dependency
4. **Cleanup**: Remove from go.mod, update documentation, update CI/CD

### Troubleshooting Dependency Issues

#### Common Issues and Solutions

**Version Conflicts**
```bash
# Clean module cache and re-download
go clean -modcache
go mod download
go mod tidy
```

**Build Failures After Updates**
```bash
# Check for breaking changes
go mod graph | grep problematic-package
# Revert to previous version if needed
go get package@v1.2.3
```

**Security Vulnerabilities**
```bash
# Check for vulnerabilities
govulncheck ./...
# Update vulnerable packages
go get -u vulnerable-package
```

## Tool Installation

### Automated Installation
```bash
# Install all development tools
make tools-install

# Or use the installation script
./scripts/install-tools.sh
```

### Manual Installation
```bash
# Core tools
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install golang.org/x/tools/cmd/goimports@latest
go install golang.org/x/vuln/cmd/govulncheck@latest
go install github.com/securecodewarrior/gosec/v2/cmd/gosec@latest
```

### Verification
```bash
# Verify all tools are installed
make deps-verify
protoc --version
golangci-lint version
goimports -version
govulncheck -version
gosec -version
```

## CI/CD Integration

### Automated Checks
- **Dependency verification**: `go mod verify`
- **Vulnerability scanning**: `govulncheck ./...`
- **Security analysis**: `gosec ./...`
- **License compliance**: Automated license checking
- **Update testing**: Full test suite on dependency updates

### Performance Impact
- **Build time**: Dependencies add ~30s to clean builds
- **Binary size**: Runtime dependencies add ~15MB to binary
- **Memory usage**: Minimal runtime overhead (<5MB)
- **Startup time**: <100ms additional startup time

## Future Considerations

### Planned Additions
- **OpenTelemetry**: For distributed tracing and metrics
- **Prometheus client**: For metrics collection
- **Additional transport**: NATS or Apache Kafka support

### Potential Removals
- **logrus**: May migrate to slog in Go 1.21+ for better performance

### Migration Planning
- **Go version updates**: Plan for Go 1.22+ features
- **Dependency lifecycle**: Monitor for deprecation notices
- **Performance optimization**: Regular benchmarking and optimization

## Support and Resources

### Documentation Links
- [Go Modules Reference](https://golang.org/ref/mod)
- [Dependabot Documentation](https://docs.github.com/en/code-security/dependabot)
- [Go Security Best Practices](https://golang.org/security)

### Community Resources
- [Go Security Mailing List](https://groups.google.com/g/golang-security)
- [Dependency Security Tools](https://github.com/golang/go/wiki/Security)

### Internal Resources
- Dependency update scripts: `scripts/update-deps.sh`
- Installation automation: `scripts/install-tools.sh`
- Makefile targets: `make help` for full list 