package tools

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SecureFileOptions defines security options for file operations
type SecureFileOptions struct {
	// AllowedPaths defines paths that are allowed for file operations
	// If empty, all paths are allowed (not recommended for production)
	AllowedPaths []string

	// MaxFileSize is the maximum allowed file size in bytes
	// Default is 100MB
	MaxFileSize int64

	// DenyPaths defines paths that are explicitly denied
	// Takes precedence over AllowedPaths
	DenyPaths []string

	// AllowSymlinks determines if symbolic links can be followed
	AllowSymlinks bool
}

// DefaultSecureFileOptions returns secure default options
func DefaultSecureFileOptions() *SecureFileOptions {
	return &SecureFileOptions{
		MaxFileSize:   100 * 1024 * 1024, // 100MB
		AllowSymlinks: false,
		DenyPaths: []string{
			"/etc",
			"/sys",
			"/proc",
			"~/.ssh",
			"~/.aws",
			"~/.config",
		},
	}
}

// SecureFileExecutor wraps file operations with security checks
type SecureFileExecutor struct {
	options       *SecureFileOptions
	executor      ToolExecutor
	operationType string // "read" or "write"
}

// NewSecureFileExecutor creates a new secure file executor
func NewSecureFileExecutor(executor ToolExecutor, options *SecureFileOptions, operationType string) *SecureFileExecutor {
	if options == nil {
		options = DefaultSecureFileOptions()
	}
	return &SecureFileExecutor{
		options:       options,
		executor:      executor,
		operationType: operationType,
	}
}

// Execute performs the file operation with security checks
func (e *SecureFileExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	// Extract path from params
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("path parameter is required")
	}

	// Use atomic operations based on operation type to prevent TOCTOU race conditions
	if e.isReadOperation() {
		return e.executeAtomicRead(ctx, path)
	} else {
		return e.executeAtomicWrite(ctx, params)
	}
}

// validatePath checks if the path is allowed based on security options
func (e *SecureFileExecutor) validatePath(path string) error {
	// Clean and resolve the path
	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return fmt.Errorf("invalid path format: %w", err)
	}

	// Expand home directory in deny paths
	for _, denyPath := range e.options.DenyPaths {
		expandedDeny := expandPath(denyPath)
		absDeny, err := filepath.Abs(filepath.Clean(expandedDeny))
		if err != nil {
			continue // Skip invalid deny paths
		}
		if strings.HasPrefix(cleanPath, absDeny) {
			return fmt.Errorf("access denied: path is in restricted directory")
		}
	}

	// Check symbolic links if not allowed
	if !e.options.AllowSymlinks {
		realPath, err := filepath.EvalSymlinks(cleanPath)
		if err == nil && realPath != cleanPath {
			return fmt.Errorf("symbolic links are not allowed")
		}
	}

	// If no allowed paths are specified, allow all (except denied)
	if len(e.options.AllowedPaths) == 0 {
		return nil
	}

	// Check if path is within allowed paths
	for _, allowedPath := range e.options.AllowedPaths {
		expandedAllow := expandPath(allowedPath)
		absAllowed, err := filepath.Abs(expandedAllow)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(absAllowed, cleanPath)
		if err == nil && !strings.HasPrefix(rel, "..") {
			return nil
		}
	}

	return fmt.Errorf("access denied: path is not in allowed directories")
}

// checkFileSize verifies the file size is within limits
func (e *SecureFileExecutor) checkFileSize(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		// File doesn't exist yet, which is fine for write operations
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("cannot stat file: %w", err)
	}

	if info.Size() > e.options.MaxFileSize {
		return fmt.Errorf("file size %d exceeds maximum allowed size of %d bytes",
			info.Size(), e.options.MaxFileSize)
	}

	return nil
}

// validateFileDescriptor performs security validation on an open file descriptor
// This helps prevent TOCTOU race conditions by validating after opening
func (e *SecureFileExecutor) validateFileDescriptor(file *os.File) error {
	stat, err := file.Stat()
	if err != nil {
		return fmt.Errorf("cannot stat file descriptor: %w", err)
	}

	// Check file size limit
	if stat.Size() > e.options.MaxFileSize {
		return fmt.Errorf("file size %d exceeds maximum allowed size of %d bytes",
			stat.Size(), e.options.MaxFileSize)
	}

	// Check that it's a regular file (not a device, pipe, etc.)
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("access denied: not a regular file")
	}

	// For additional security, we could check ownership, permissions, etc.
	// but this provides basic protection against special files

	return nil
}

// isReadOperation checks if this executor is for a read operation
func (e *SecureFileExecutor) isReadOperation() bool {
	return e.operationType == "read"
}

// expandPath expands ~ to home directory
func expandPath(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}

// NewSecureReadFileTool creates a secure file reading tool
func NewSecureReadFileTool(options *SecureFileOptions) *Tool {
	baseTool := NewReadFileTool()
	baseTool.Executor = NewSecureFileExecutor(&readFileExecutor{}, options, "read")
	return baseTool
}

// NewSecureWriteFileTool creates a secure file writing tool
func NewSecureWriteFileTool(options *SecureFileOptions) *Tool {
	baseTool := NewWriteFileTool()
	baseTool.Executor = NewSecureFileExecutor(&writeFileExecutor{}, options, "write")
	return baseTool
}

// executeAtomicRead performs atomic read operation to prevent TOCTOU race conditions
func (e *SecureFileExecutor) executeAtomicRead(ctx context.Context, path string) (*ToolExecutionResult, error) {
	// First validate the path
	if err := e.validatePath(path); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("path validation failed: %v", err),
		}, nil
	}

	// Open the file
	file, err := os.Open(path)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to open file: %v", err),
		}, nil
	}
	defer file.Close()

	// Validate the opened file descriptor to prevent TOCTOU attacks
	if validationErr := e.validateFileDescriptor(file); validationErr != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("file validation failed: %v", validationErr),
		}, nil
	}

	// Read the file content with size limit
	const maxReadSize = 100 * 1024 * 1024 // 100MB limit
	limitedReader := io.LimitReader(file, maxReadSize)
	data, err := io.ReadAll(limitedReader)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to read file: %v", err),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data: map[string]interface{}{
			"content": string(data),
			"size":    len(data),
		},
	}, nil
}

// executeAtomicWrite performs atomic write operation to prevent TOCTOU race conditions
func (e *SecureFileExecutor) executeAtomicWrite(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("path parameter is required")
	}

	content, ok := params["content"].(string)
	if !ok {
		return nil, fmt.Errorf("content parameter is required")
	}

	mode, _ := params["mode"].(string)
	if mode == "" {
		mode = "write"
	}

	// First validate the path
	if err := e.validatePath(path); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("path validation failed: %v", err),
		}, nil
	}

	// Validate parent directory path
	dir := filepath.Dir(path)
	if err := e.validatePath(dir); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("parent directory access denied: %v", err),
		}, nil
	}

	// Create directory if needed
	if err := os.MkdirAll(dir, 0755); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to create directory: %v", err),
		}, nil
	}

	// Choose the appropriate file opening mode
	var flags int
	switch mode {
	case "append":
		flags = os.O_APPEND | os.O_CREATE | os.O_WRONLY
	default: // "write" or default
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}

	// Open the file atomically
	file, err := os.OpenFile(path, flags, 0644)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to open file for writing: %v", err),
		}, nil
	}
	defer file.Close()

	// Validate the file descriptor for security
	if validationErr := e.validateFileDescriptor(file); validationErr != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("file validation failed: %v", validationErr),
		}, nil
	}

	// Write the data
	_, err = file.WriteString(content)
	if err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to write to file: %v", err),
		}, nil
	}

	// Sync to ensure data is written
	if err := file.Sync(); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to sync file: %v", err),
		}, nil
	}

	return &ToolExecutionResult{
		Success: true,
		Data: map[string]interface{}{
			"path":          path,
			"bytes_written": len(content),
		},
	}, nil
}
