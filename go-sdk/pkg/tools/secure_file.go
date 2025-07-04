package tools

import (
	"context"
	"fmt"
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
	options  *SecureFileOptions
	executor ToolExecutor
}

// NewSecureFileExecutor creates a new secure file executor
func NewSecureFileExecutor(executor ToolExecutor, options *SecureFileOptions) *SecureFileExecutor {
	if options == nil {
		options = DefaultSecureFileOptions()
	}
	return &SecureFileExecutor{
		options:  options,
		executor: executor,
	}
}

// Execute performs the file operation with security checks
func (e *SecureFileExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	// Extract path from params
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("path parameter is required")
	}
	
	// Validate path
	if err := e.validatePath(path); err != nil {
		return &ToolExecutionResult{
			Success: false,
			Error:   fmt.Sprintf("path validation failed: %v", err),
		}, nil
	}
	
	// For read operations, check file size
	if e.isReadOperation() {
		if err := e.checkFileSize(path); err != nil {
			return &ToolExecutionResult{
				Success: false,
				Error:   fmt.Sprintf("file size check failed: %v", err),
			}, nil
		}
	}
	
	// Execute the underlying operation
	return e.executor.Execute(ctx, params)
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
		if strings.HasPrefix(cleanPath, expandedDeny) {
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
		if strings.HasPrefix(cleanPath, absAllowed) {
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

// isReadOperation checks if this executor is for a read operation
func (e *SecureFileExecutor) isReadOperation() bool {
	// This is a simple check - in practice, you might want to
	// pass this information explicitly or check the tool type
	return true // Conservative default
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
	baseTool.Executor = NewSecureFileExecutor(&readFileExecutor{}, options)
	return baseTool
}

// NewSecureWriteFileTool creates a secure file writing tool
func NewSecureWriteFileTool(options *SecureFileOptions) *Tool {
	baseTool := NewWriteFileTool()
	baseTool.Executor = NewSecureFileExecutor(&writeFileExecutor{}, options)
	return baseTool
}