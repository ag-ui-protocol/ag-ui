#!/bin/bash

# AG-UI Go SDK Development Tools Installation Script
# This script installs all required development tools for the AG-UI Go SDK project

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Go is installed
check_go() {
    if ! command -v go &> /dev/null; then
        print_error "Go is not installed. Please install Go 1.21+ first."
        print_info "Visit: https://golang.org/doc/install"
        exit 1
    fi

    # Check Go version
    GO_VERSION=$(go version | cut -d' ' -f3 | sed 's/go//')
    REQUIRED_VERSION="1.21"
    
    if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$GO_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
        print_error "Go version $GO_VERSION is too old. Required: $REQUIRED_VERSION+"
        exit 1
    fi

    print_success "Go $GO_VERSION is installed"
}

# Check if protoc is installed
check_protoc() {
    if ! command -v protoc &> /dev/null; then
        print_warning "protoc (Protocol Buffers compiler) is not installed"
        print_info "Installing protoc..."
        
        # Determine OS and architecture
        OS="$(uname -s)"
        ARCH="$(uname -m)"
        
        case "$OS" in
            Linux*)
                case "$ARCH" in
                    x86_64) PROTOC_ARCH="linux-x86_64" ;;
                    aarch64) PROTOC_ARCH="linux-aarch_64" ;;
                    *) print_error "Unsupported architecture: $ARCH"; exit 1 ;;
                esac
                ;;
            Darwin*)
                case "$ARCH" in
                    x86_64) PROTOC_ARCH="osx-x86_64" ;;
                    arm64) PROTOC_ARCH="osx-aarch_64" ;;
                    *) print_error "Unsupported architecture: $ARCH"; exit 1 ;;
                esac
                ;;
            *)
                print_warning "Cannot auto-install protoc on $OS. Please install manually:"
                print_info "Visit: https://grpc.io/docs/protoc-installation/"
                return 1
                ;;
        esac

        PROTOC_VERSION="25.1"
        PROTOC_URL="https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-${PROTOC_ARCH}.zip"
        TEMP_DIR=$(mktemp -d)
        
        print_info "Downloading protoc from $PROTOC_URL"
        curl -L "$PROTOC_URL" -o "$TEMP_DIR/protoc.zip"
        
        print_info "Installing protoc to /usr/local"
        unzip -q "$TEMP_DIR/protoc.zip" -d "$TEMP_DIR"
        sudo cp "$TEMP_DIR/bin/protoc" /usr/local/bin/
        sudo cp -r "$TEMP_DIR/include"/* /usr/local/include/
        
        rm -rf "$TEMP_DIR"
        print_success "protoc installed successfully"
    else
        PROTOC_VERSION=$(protoc --version | cut -d' ' -f2)
        print_success "protoc $PROTOC_VERSION is already installed"
    fi
}

# Install Go tools
install_go_tools() {
    print_info "Installing Go development tools..."

    # List of tools to install
    tools=(
        "google.golang.org/protobuf/cmd/protoc-gen-go@latest"
        "github.com/golangci/golangci-lint/cmd/golangci-lint@latest"
        "golang.org/x/tools/cmd/goimports@latest"
        "golang.org/x/vuln/cmd/govulncheck@latest"
        "github.com/securego/gosec/v2/cmd/gosec@latest"
        "go.uber.org/mock/mockgen@latest"
    )

    for tool in "${tools[@]}"; do
        tool_name=$(basename "${tool%@*}")
        print_info "Installing $tool_name..."
        if go install "$tool"; then
            print_success "$tool_name installed"
        else
            print_error "Failed to install $tool_name"
            exit 1
        fi
    done
}

# Verify installations
verify_tools() {
    print_info "Verifying tool installations..."

    tools_to_check=(
        "protoc"
        "protoc-gen-go"
        "golangci-lint"
        "goimports"
        "govulncheck"
        "gosec"
        "mockgen"
    )

    failed_tools=()

    for tool in "${tools_to_check[@]}"; do
        if command -v "$tool" &> /dev/null; then
            version=$($tool --version 2>/dev/null || $tool version 2>/dev/null || echo "unknown")
            print_success "$tool: $version"
        else
            print_error "$tool: not found"
            failed_tools+=("$tool")
        fi
    done

    if [ ${#failed_tools[@]} -ne 0 ]; then
        print_error "Some tools failed to install: ${failed_tools[*]}"
        print_info "You may need to add \$GOPATH/bin to your PATH"
        print_info "Current GOPATH: $(go env GOPATH)"
        exit 1
    fi
}

# Setup development environment
setup_dev_env() {
    print_info "Setting up development environment..."
    
    # Check if we're in the right directory
    if [ ! -f "go.mod" ] || ! grep -q "github.com/ag-ui/go-sdk" go.mod; then
        print_warning "Not in AG-UI Go SDK directory. Changing to go-sdk/"
        if [ -d "go-sdk" ]; then
            cd go-sdk
        else
            print_error "Cannot find go-sdk directory"
            exit 1
        fi
    fi

    # Download dependencies
    print_info "Downloading Go dependencies..."
    go mod download
    go mod tidy
    go mod verify

    # Create proto directories if they don't exist
    if [ ! -d "proto" ]; then
        print_info "Creating proto directory..."
        mkdir -p proto
    fi

    if [ ! -d "pkg/proto" ]; then
        print_info "Creating pkg/proto directory..."
        mkdir -p pkg/proto
    fi

    print_success "Development environment setup complete"
}

# Main installation process
main() {
    print_info "AG-UI Go SDK Development Tools Installation"
    print_info "=========================================="

    # Check prerequisites
    check_go
    check_protoc

    # Install tools
    install_go_tools

    # Verify installations
    verify_tools

    # Setup development environment
    setup_dev_env

    print_success "All development tools installed successfully!"
    print_info ""
    print_info "Next steps:"
    print_info "1. Run 'make tools-install' to ensure all tools are available"
    print_info "2. Run 'make lint' to check code quality"
    print_info "3. Run 'make test' to run the test suite"
    print_info "4. Run 'make help' to see all available make targets"
    print_info ""
    print_info "Happy coding! 🚀"
}

# Run main function
main "$@" 