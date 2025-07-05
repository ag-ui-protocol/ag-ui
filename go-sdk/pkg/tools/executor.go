package tools

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// ExecutionEngine manages the execution of tools.
// It provides validation, timeout management, concurrency control,
// and result handling for tool executions.
type ExecutionEngine struct {
	registry *Registry

	// Configuration
	maxConcurrent  int
	defaultTimeout time.Duration

	// Execution tracking
	mu          sync.RWMutex
	activeCount int
	executions  map[string]*executionState

	// Metrics
	metrics *ExecutionMetrics

	// Rate limiting
	rateLimiter RateLimiter

	// Hooks for extensibility
	beforeExecute []ExecutionHook
	afterExecute  []ExecutionHook
}

// executionState tracks the state of a single tool execution.
type executionState struct {
	toolID    string
	startTime time.Time
	cancel    context.CancelFunc
}

// ExecutionMetrics tracks tool execution statistics.
type ExecutionMetrics struct {
	mu              sync.RWMutex
	totalExecutions int64
	successCount    int64
	errorCount      int64
	totalDuration   time.Duration
	toolMetrics     map[string]*ToolMetrics
}

// ToolMetrics tracks statistics for a specific tool.
type ToolMetrics struct {
	Executions      int64
	Successes       int64
	Errors          int64
	TotalDuration   time.Duration
	AverageDuration time.Duration
}

// RateLimiter interface for tool rate limiting.
type RateLimiter interface {
	// Allow checks if a tool execution is allowed
	Allow(toolID string) bool
	// Wait blocks until the tool execution is allowed
	Wait(ctx context.Context, toolID string) error
}

// ExecutionHook is called before or after tool execution.
type ExecutionHook func(ctx context.Context, toolID string, params map[string]interface{}) error

// ExecutionEngineOption configures the execution engine.
type ExecutionEngineOption func(*ExecutionEngine)

// WithMaxConcurrent sets the maximum number of concurrent executions.
func WithMaxConcurrent(max int) ExecutionEngineOption {
	return func(e *ExecutionEngine) {
		e.maxConcurrent = max
	}
}

// WithDefaultTimeout sets the default execution timeout.
func WithDefaultTimeout(timeout time.Duration) ExecutionEngineOption {
	return func(e *ExecutionEngine) {
		e.defaultTimeout = timeout
	}
}

// WithRateLimiter sets the rate limiter for tool executions.
func WithRateLimiter(limiter RateLimiter) ExecutionEngineOption {
	return func(e *ExecutionEngine) {
		e.rateLimiter = limiter
	}
}

// NewExecutionEngine creates a new execution engine.
func NewExecutionEngine(registry *Registry, opts ...ExecutionEngineOption) *ExecutionEngine {
	e := &ExecutionEngine{
		registry:       registry,
		maxConcurrent:  100,              // Default max concurrent executions
		defaultTimeout: 30 * time.Second, // Default timeout
		executions:     make(map[string]*executionState),
		metrics: &ExecutionMetrics{
			toolMetrics: make(map[string]*ToolMetrics),
		},
	}

	// Apply options
	for _, opt := range opts {
		opt(e)
	}

	return e
}

// Execute runs a tool with the given parameters.
func (e *ExecutionEngine) Execute(ctx context.Context, toolID string, params map[string]interface{}) (*ToolExecutionResult, error) {
	// Get the tool from registry (read-only view for memory efficiency)
	toolView, err := e.registry.GetReadOnly(toolID)
	if err != nil {
		return nil, fmt.Errorf("tool not found: %w", err)
	}

	// Check rate limits
	if e.rateLimiter != nil {
		if rateLimitErr := e.rateLimiter.Wait(ctx, toolID); rateLimitErr != nil {
			return nil, fmt.Errorf("rate limit exceeded: %w", rateLimitErr)
		}
	}

	// Check concurrency limits
	if concurrencyErr := e.checkConcurrencyLimit(ctx); concurrencyErr != nil {
		return nil, concurrencyErr
	}

	// Validate parameters
	validator := NewSchemaValidator(toolView.GetSchema())
	if validationErr := validator.Validate(params); validationErr != nil {
		return nil, fmt.Errorf("parameter validation failed: %w", validationErr)
	}

	// Run before-execute hooks
	for _, hook := range e.beforeExecute {
		if hookErr := hook(ctx, toolID, params); hookErr != nil {
			return nil, fmt.Errorf("pre-execution hook failed: %w", hookErr)
		}
	}

	// Set up execution context with timeout
	timeout := e.defaultTimeout
	if capabilities := toolView.GetCapabilities(); capabilities != nil && capabilities.Timeout > 0 {
		timeout = capabilities.Timeout
	}

	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Track execution
	execID := fmt.Sprintf("%s-%d", toolID, time.Now().UnixNano())
	e.trackExecution(execID, toolID, cancel)
	defer e.untrackExecution(execID)

	// Record start time
	startTime := time.Now()

	// Execute the tool
	result, err := e.executeWithRecovery(execCtx, toolView, params)

	// Record execution time
	duration := time.Since(startTime)

	// Prepare result
	if err != nil {
		result = &ToolExecutionResult{
			Success:   false,
			Error:     err.Error(),
			Duration:  duration,
			Timestamp: time.Now(),
		}
	} else if result == nil {
		result = &ToolExecutionResult{
			Success:   true,
			Duration:  duration,
			Timestamp: time.Now(),
		}
	} else {
		result.Duration = duration
		result.Timestamp = time.Now()
	}

	// Update metrics based on final result
	e.updateMetrics(toolID, result.Success, duration)

	// Run after-execute hooks
	for _, hook := range e.afterExecute {
		if hookErr := hook(ctx, toolID, params); hookErr != nil {
			// Log hook errors but don't fail the execution
			fmt.Printf("post-execution hook error: %v\n", hookErr)
		}
	}

	return result, nil
}

// ExecuteStream runs a streaming tool with the given parameters.
func (e *ExecutionEngine) ExecuteStream(ctx context.Context, toolID string, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
	// Get the tool from registry (read-only view for memory efficiency)
	toolView, err := e.registry.GetReadOnly(toolID)
	if err != nil {
		return nil, fmt.Errorf("tool not found: %w", err)
	}

	// Check if tool supports streaming
	streamingExecutor, ok := toolView.GetExecutor().(StreamingToolExecutor)
	if !ok {
		return nil, fmt.Errorf("tool %q does not support streaming", toolID)
	}

	// Validate parameters
	validator := NewSchemaValidator(toolView.GetSchema())
	if validationErr := validator.Validate(params); validationErr != nil {
		return nil, fmt.Errorf("parameter validation failed: %w", validationErr)
	}

	// Check rate limits
	if e.rateLimiter != nil {
		if rateLimitErr := e.rateLimiter.Wait(ctx, toolID); rateLimitErr != nil {
			return nil, fmt.Errorf("rate limit exceeded: %w", rateLimitErr)
		}
	}

	// Check concurrency limits
	if concurrencyErr := e.checkConcurrencyLimit(ctx); concurrencyErr != nil {
		return nil, concurrencyErr
	}

	// Set up execution context with timeout
	timeout := e.defaultTimeout
	if capabilities := toolView.GetCapabilities(); capabilities != nil && capabilities.Timeout > 0 {
		timeout = capabilities.Timeout
	}

	execCtx, cancel := context.WithTimeout(ctx, timeout)

	// Track execution
	execID := fmt.Sprintf("%s-stream-%d", toolID, time.Now().UnixNano())
	e.trackExecution(execID, toolID, cancel)

	// Execute the streaming tool
	stream, err := streamingExecutor.ExecuteStream(execCtx, params)
	if err != nil {
		cancel()
		e.untrackExecution(execID)
		return nil, fmt.Errorf("streaming execution failed: %w", err)
	}

	// Wrap the stream to handle cleanup
	wrappedStream := make(chan *ToolStreamChunk)
	go func() {
		defer close(wrappedStream)
		defer cancel()
		defer e.untrackExecution(execID)

		startTime := time.Now()
		hasError := false

		for chunk := range stream {
			select {
			case wrappedStream <- chunk:
				if chunk.Type == "error" {
					hasError = true
				}
			case <-execCtx.Done():
				// Context canceled, stop streaming
				return
			}
		}

		// Update metrics
		duration := time.Since(startTime)
		e.updateMetrics(toolID, !hasError, duration)
	}()

	return wrappedStream, nil
}

// executeWithRecovery executes a tool with panic recovery.
func (e *ExecutionEngine) executeWithRecovery(ctx context.Context, tool ReadOnlyTool, params map[string]interface{}) (result *ToolExecutionResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("tool execution panicked: %v", r)
			result = nil
		}
	}()

	return tool.GetExecutor().Execute(ctx, params)
}

// checkConcurrencyLimit checks if we can execute another tool.
func (e *ExecutionEngine) checkConcurrencyLimit(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.activeCount >= e.maxConcurrent {
		// Wait for a slot to become available
		for e.activeCount >= e.maxConcurrent {
			e.mu.Unlock()
			select {
			case <-ctx.Done():
				e.mu.Lock()
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
				e.mu.Lock()
			}
		}
	}

	e.activeCount++
	return nil
}

// trackExecution records an active execution.
func (e *ExecutionEngine) trackExecution(execID, toolID string, cancel context.CancelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.executions[execID] = &executionState{
		toolID:    toolID,
		startTime: time.Now(),
		cancel:    cancel,
	}
}

// untrackExecution removes an execution from tracking.
func (e *ExecutionEngine) untrackExecution(execID string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.executions, execID)
	e.activeCount--
}

// updateMetrics updates execution metrics.
func (e *ExecutionEngine) updateMetrics(toolID string, success bool, duration time.Duration) {
	e.metrics.mu.Lock()
	defer e.metrics.mu.Unlock()

	e.metrics.totalExecutions++
	e.metrics.totalDuration += duration

	if success {
		e.metrics.successCount++
	} else {
		e.metrics.errorCount++
	}

	// Update tool-specific metrics
	toolMetric, exists := e.metrics.toolMetrics[toolID]
	if !exists {
		toolMetric = &ToolMetrics{}
		e.metrics.toolMetrics[toolID] = toolMetric
	}

	toolMetric.Executions++
	toolMetric.TotalDuration += duration
	toolMetric.AverageDuration = toolMetric.TotalDuration / time.Duration(toolMetric.Executions)

	if success {
		toolMetric.Successes++
	} else {
		toolMetric.Errors++
	}
}

// GetMetrics returns the current execution metrics.
func (e *ExecutionEngine) GetMetrics() *ExecutionMetrics {
	e.metrics.mu.RLock()
	defer e.metrics.mu.RUnlock()

	// Create a copy of metrics
	copy := &ExecutionMetrics{
		totalExecutions: e.metrics.totalExecutions,
		successCount:    e.metrics.successCount,
		errorCount:      e.metrics.errorCount,
		totalDuration:   e.metrics.totalDuration,
		toolMetrics:     make(map[string]*ToolMetrics),
	}

	for toolID, metric := range e.metrics.toolMetrics {
		copy.toolMetrics[toolID] = &ToolMetrics{
			Executions:      metric.Executions,
			Successes:       metric.Successes,
			Errors:          metric.Errors,
			TotalDuration:   metric.TotalDuration,
			AverageDuration: metric.AverageDuration,
		}
	}

	return copy
}

// CancelAll cancels all active executions.
func (e *ExecutionEngine) CancelAll() {
	e.mu.Lock()
	defer e.mu.Unlock()

	for _, exec := range e.executions {
		exec.cancel()
	}
}

// AddBeforeExecuteHook adds a hook to run before tool execution.
func (e *ExecutionEngine) AddBeforeExecuteHook(hook ExecutionHook) {
	e.beforeExecute = append(e.beforeExecute, hook)
}

// AddAfterExecuteHook adds a hook to run after tool execution.
func (e *ExecutionEngine) AddAfterExecuteHook(hook ExecutionHook) {
	e.afterExecute = append(e.afterExecute, hook)
}

// GetActiveExecutions returns the number of active executions.
func (e *ExecutionEngine) GetActiveExecutions() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.activeCount
}

// IsExecuting checks if a specific tool is currently executing.
func (e *ExecutionEngine) IsExecuting(toolID string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, exec := range e.executions {
		if exec.toolID == toolID {
			return true
		}
	}
	return false
}
