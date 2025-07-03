#!/bin/bash

# AG-UI Go SDK Dependency Update Script
# This script automates the process of updating Go dependencies safely

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

# Configuration
BACKUP_FILE="go.mod.backup.$(date +%Y%m%d_%H%M%S)"
TEST_TIMEOUT="5m"

# Create backup of current dependencies
backup_dependencies() {
    print_info "Creating backup of current dependencies..."
    cp go.mod "$BACKUP_FILE"
    if [ -f "go.sum" ]; then
        cp go.sum "${BACKUP_FILE%.mod}.sum"
    fi
    print_success "Backup created: $BACKUP_FILE"
}

# Restore from backup
restore_backup() {
    print_warning "Restoring from backup..."
    cp "$BACKUP_FILE" go.mod
    if [ -f "${BACKUP_FILE%.mod}.sum" ]; then
        cp "${BACKUP_FILE%.mod}.sum" go.sum
    fi
    print_info "Dependencies restored from backup"
}

# Clean up backup files
cleanup_backup() {
    if [ -f "$BACKUP_FILE" ]; then
        rm "$BACKUP_FILE"
    fi
    if [ -f "${BACKUP_FILE%.mod}.sum" ]; then
        rm "${BACKUP_FILE%.mod}.sum"
    fi
}

# Update dependencies
update_dependencies() {
    print_info "Updating Go dependencies..."
    
    # Update all dependencies to latest minor/patch versions
    print_info "Updating to latest patch/minor versions..."
    go get -u=patch ./...
    
    # Optionally update to latest major versions (more risky)
    if [ "${1:-}" = "--major" ]; then
        print_warning "Updating to latest major versions (may introduce breaking changes)..."
        go get -u ./...
    fi
    
    # Clean up and verify
    go mod tidy
    go mod verify
    
    print_success "Dependencies updated successfully"
}

# Check for vulnerabilities
check_vulnerabilities() {
    print_info "Checking for known vulnerabilities..."
    
    if command -v govulncheck &> /dev/null; then
        if govulncheck ./...; then
            print_success "No known vulnerabilities found"
        else
            print_error "Vulnerabilities detected! Review the output above."
            return 1
        fi
    else
        print_warning "govulncheck not found. Install with: go install golang.org/x/vuln/cmd/govulncheck@latest"
        return 1
    fi
}

# Run tests to ensure nothing is broken
run_tests() {
    print_info "Running tests to verify compatibility..."
    
    # Run tests with timeout
    if timeout "$TEST_TIMEOUT" go test ./...; then
        print_success "All tests passed"
    else
        print_error "Tests failed! Dependencies may be incompatible."
        return 1
    fi
}

# Run linting to check for issues
run_linting() {
    print_info "Running linter to check for issues..."
    
    if command -v golangci-lint &> /dev/null; then
        if golangci-lint run; then
            print_success "Linting passed"
        else
            print_warning "Linting found issues. Review the output above."
            # Don't fail on linting issues during dependency updates
        fi
    else
        print_warning "golangci-lint not found. Install with: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest"
    fi
}

# Show dependency changes
show_changes() {
    print_info "Dependency changes:"
    
    if [ -f "$BACKUP_FILE" ]; then
        echo "==================="
        echo "Previous dependencies:"
        grep -E "^\s*(github|golang|google)" "$BACKUP_FILE" | head -10
        echo ""
        echo "Current dependencies:"
        grep -E "^\s*(github|golang|google)" go.mod | head -10
        echo "==================="
        
        # Show detailed diff if available
        if command -v diff &> /dev/null; then
            echo ""
            print_info "Detailed changes:"
            diff "$BACKUP_FILE" go.mod || true
        fi
    fi
}

# Update development tools
update_tools() {
    print_info "Updating development tools..."
    
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
        print_info "Updating $tool_name..."
        if go install "$tool"; then
            print_success "$tool_name updated"
        else
            print_warning "Failed to update $tool_name"
        fi
    done
}

# Generate summary report
generate_report() {
    local report_file="dependency-update-report-$(date +%Y%m%d_%H%M%S).txt"
    
    print_info "Generating update report: $report_file"
    
    cat > "$report_file" << EOF
AG-UI Go SDK Dependency Update Report
Generated: $(date)
========================================

Go Version: $(go version)

Dependencies Before Update:
$(cat "$BACKUP_FILE" 2>/dev/null || echo "Backup not available")

Dependencies After Update:
$(cat go.mod)

Update Summary:
- Update Type: ${UPDATE_TYPE:-patch}
- Tests: ${TEST_RESULT:-unknown}
- Vulnerabilities: ${VULN_RESULT:-unknown}
- Linting: ${LINT_RESULT:-unknown}

EOF

    print_success "Report generated: $report_file"
}

# Main update process
main() {
    print_info "AG-UI Go SDK Dependency Update"
    print_info "=============================="
    
    # Parse arguments
    UPDATE_TYPE="patch"
    SKIP_TESTS=false
    TOOLS_ONLY=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --major)
                UPDATE_TYPE="major"
                shift
                ;;
            --skip-tests)
                SKIP_TESTS=true
                shift
                ;;
            --tools-only)
                TOOLS_ONLY=true
                shift
                ;;
            --help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --major      Update to latest major versions (risky)"
                echo "  --skip-tests Skip running tests after update"
                echo "  --tools-only Only update development tools"
                echo "  --help       Show this help message"
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Check if we're in the right directory
    if [ ! -f "go.mod" ] || ! grep -q "github.com/ag-ui/go-sdk" go.mod; then
        print_error "Not in AG-UI Go SDK directory. Please run from the go-sdk/ directory."
        exit 1
    fi
    
    # If tools-only, just update tools and exit
    if [ "$TOOLS_ONLY" = true ]; then
        update_tools
        print_success "Development tools updated successfully!"
        exit 0
    fi
    
    # Create backup
    backup_dependencies
    
    # Track results for report
    TEST_RESULT="not run"
    VULN_RESULT="not checked"
    LINT_RESULT="not run"
    
    # Update dependencies
    if update_dependencies "$UPDATE_TYPE"; then
        print_success "Dependencies updated"
    else
        print_error "Dependency update failed"
        restore_backup
        cleanup_backup
        exit 1
    fi
    
    # Check vulnerabilities
    if check_vulnerabilities; then
        VULN_RESULT="pass"
    else
        VULN_RESULT="fail"
        print_error "Vulnerability check failed. Consider reverting updates."
        restore_backup
        cleanup_backup
        exit 1
    fi
    
    # Run tests unless skipped
    if [ "$SKIP_TESTS" = false ]; then
        if run_tests; then
            TEST_RESULT="pass"
        else
            TEST_RESULT="fail"
            print_error "Tests failed. Reverting dependencies..."
            restore_backup
            cleanup_backup
            exit 1
        fi
    fi
    
    # Run linting
    if run_linting; then
        LINT_RESULT="pass"
    else
        LINT_RESULT="warning"
    fi
    
    # Show changes
    show_changes
    
    # Update tools
    update_tools
    
    # Generate report
    generate_report
    
    # Clean up backup (keep if there were issues)
    if [ "$TEST_RESULT" = "pass" ] && [ "$VULN_RESULT" = "pass" ]; then
        cleanup_backup
        print_success "Dependency update completed successfully!"
        print_info "You may want to commit the updated go.mod and go.sum files."
    else
        print_warning "Some issues detected. Backup files preserved for manual review."
    fi
    
    print_info ""
    print_info "Next steps:"
    print_info "1. Review the changes: git diff go.mod go.sum"
    print_info "2. Test your application thoroughly"
    print_info "3. Commit the changes: git add go.mod go.sum && git commit -m 'Update dependencies'"
    print_info ""
}

# Run main function
main "$@" 