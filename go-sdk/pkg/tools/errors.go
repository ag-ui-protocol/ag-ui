package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Common error variables for tool operations.
var (
	// ErrToolNotFound indicates a requested tool doesn't exist
	ErrToolNotFound = errors.New("tool not found")

	// ErrInvalidParameters indicates the provided parameters are invalid
	ErrInvalidParameters = errors.New("invalid parameters")

	// ErrExecutionTimeout indicates tool execution exceeded timeout
	ErrExecutionTimeout = errors.New("execution timeout")

	// ErrExecutionCancelled indicates tool execution was cancelled
	ErrExecutionCancelled = errors.New("execution cancelled")

	// ErrRateLimitExceeded indicates rate limit was exceeded
	ErrRateLimitExceeded = errors.New("rate limit exceeded")

	// ErrMaxConcurrencyReached indicates max concurrent executions reached
	ErrMaxConcurrencyReached = errors.New("maximum concurrent executions reached")

	// ErrToolPanicked indicates the tool execution panicked
	ErrToolPanicked = errors.New("tool execution panicked")

	// ErrStreamingNotSupported indicates tool doesn't support streaming
	ErrStreamingNotSupported = errors.New("streaming not supported")

	// ErrCircularDependency indicates a circular tool dependency
	ErrCircularDependency = errors.New("circular dependency detected")
)

// ToolError represents a detailed error from tool operations.
type ToolError struct {
	// Type categorizes the error
	Type ErrorType

	// Code is a machine-readable error code
	Code string

	// Message is a human-readable error message
	Message string

	// ToolID identifies the tool that caused the error
	ToolID string

	// Details provides additional error context
	Details map[string]interface{}

	// Cause is the underlying error, if any
	Cause error

	// Timestamp is when the error occurred
	Timestamp time.Time

	// Retryable indicates if the operation can be retried
	Retryable bool

	// RetryAfter suggests when to retry (if retryable)
	RetryAfter *time.Duration
}

// ErrorType categorizes tool errors.
type ErrorType string

const (
	// ErrorTypeValidation indicates parameter validation errors
	ErrorTypeValidation ErrorType = "validation"

	// ErrorTypeExecution indicates runtime execution errors
	ErrorTypeExecution ErrorType = "execution"

	// ErrorTypeTimeout indicates timeout errors
	ErrorTypeTimeout ErrorType = "timeout"

	// ErrorTypeCancellation indicates cancellation errors
	ErrorTypeCancellation ErrorType = "cancellation"

	// ErrorTypeRateLimit indicates rate limiting errors
	ErrorTypeRateLimit ErrorType = "rate_limit"

	// ErrorTypeConcurrency indicates concurrency limit errors
	ErrorTypeConcurrency ErrorType = "concurrency"

	// ErrorTypeDependency indicates dependency resolution errors
	ErrorTypeDependency ErrorType = "dependency"

	// ErrorTypeInternal indicates internal system errors
	ErrorTypeInternal ErrorType = "internal"

	// ErrorTypeProvider indicates AI provider-specific errors
	ErrorTypeProvider ErrorType = "provider"
)

// Error implements the error interface.
func (e *ToolError) Error() string {
	var parts []string

	if e.Code != "" {
		parts = append(parts, fmt.Sprintf("[%s]", e.Code))
	}

	if e.ToolID != "" {
		parts = append(parts, fmt.Sprintf("tool %q", e.ToolID))
	}

	parts = append(parts, e.Message)

	if e.Cause != nil {
		parts = append(parts, fmt.Sprintf("caused by: %v", e.Cause))
	}

	return strings.Join(parts, ": ")
}

// Unwrap returns the underlying error.
func (e *ToolError) Unwrap() error {
	return e.Cause
}

// Is checks if the error matches a target error.
func (e *ToolError) Is(target error) bool {
	if target == nil {
		return false
	}

	// Check against common errors
	switch target {
	case ErrToolNotFound:
		return e.Type == ErrorTypeValidation && strings.Contains(e.Message, "not found")
	case ErrInvalidParameters:
		return e.Type == ErrorTypeValidation
	case ErrExecutionTimeout:
		return e.Type == ErrorTypeTimeout
	case ErrExecutionCancelled:
		return e.Type == ErrorTypeCancellation
	case ErrRateLimitExceeded:
		return e.Type == ErrorTypeRateLimit
	case ErrMaxConcurrencyReached:
		return e.Type == ErrorTypeConcurrency
	}

	// Check if target is also a ToolError
	if targetErr, ok := target.(*ToolError); ok {
		return e.Type == targetErr.Type && e.Code == targetErr.Code
	}

	return false
}

// NewToolError creates a new tool error.
func NewToolError(errType ErrorType, code, message string) *ToolError {
	return &ToolError{
		Type:      errType,
		Code:      code,
		Message:   message,
		Timestamp: time.Now(),
		Details:   make(map[string]interface{}),
	}
}

// WithToolID adds a tool ID to the error.
func (e *ToolError) WithToolID(toolID string) *ToolError {
	e.ToolID = toolID
	return e
}

// WithCause adds an underlying cause to the error.
func (e *ToolError) WithCause(cause error) *ToolError {
	e.Cause = cause
	return e
}

// WithDetail adds a detail to the error.
func (e *ToolError) WithDetail(key string, value interface{}) *ToolError {
	if e.Details == nil {
		e.Details = make(map[string]interface{})
	}
	e.Details[key] = value
	return e
}

// WithRetry marks the error as retryable.
func (e *ToolError) WithRetry(after time.Duration) *ToolError {
	e.Retryable = true
	e.RetryAfter = &after
	return e
}

// ErrorHandler provides centralized error handling for tool operations.
type ErrorHandler struct {
	// ErrorTransformers allow customizing error messages
	transformers []ErrorTransformer

	// ErrorListeners are notified of errors
	listeners []ErrorListener

	// RecoveryStrategies define how to recover from errors
	strategies map[ErrorType]RecoveryStrategy
}

// ErrorTransformer modifies errors before they're returned.
type ErrorTransformer func(*ToolError) *ToolError

// ErrorListener is notified when errors occur.
type ErrorListener func(*ToolError)

// RecoveryStrategy defines how to recover from an error.
type RecoveryStrategy func(context.Context, *ToolError) error

// NewErrorHandler creates a new error handler.
func NewErrorHandler() *ErrorHandler {
	return &ErrorHandler{
		transformers: []ErrorTransformer{},
		listeners:    []ErrorListener{},
		strategies:   make(map[ErrorType]RecoveryStrategy),
	}
}

// HandleError processes an error through the error handling pipeline.
func (h *ErrorHandler) HandleError(err error, toolID string) error {
	// Handle nil error
	if err == nil {
		err = errors.New("nil error")
	}

	// Convert to ToolError if needed
	toolErr, ok := err.(*ToolError)
	if !ok {
		toolErr = h.wrapError(err, toolID)
	}

	// Apply transformers
	for _, transformer := range h.transformers {
		toolErr = transformer(toolErr)
	}

	// Notify listeners
	for _, listener := range h.listeners {
		listener(toolErr)
	}

	return toolErr
}

// Recover attempts to recover from an error.
func (h *ErrorHandler) Recover(ctx context.Context, err error) error {
	toolErr, ok := err.(*ToolError)
	if !ok {
		return err
	}

	strategy, exists := h.strategies[toolErr.Type]
	if !exists {
		return err
	}

	return strategy(ctx, toolErr)
}

// AddTransformer adds an error transformer.
func (h *ErrorHandler) AddTransformer(transformer ErrorTransformer) {
	h.transformers = append(h.transformers, transformer)
}

// AddListener adds an error listener.
func (h *ErrorHandler) AddListener(listener ErrorListener) {
	h.listeners = append(h.listeners, listener)
}

// SetRecoveryStrategy sets a recovery strategy for an error type.
func (h *ErrorHandler) SetRecoveryStrategy(errType ErrorType, strategy RecoveryStrategy) {
	h.strategies[errType] = strategy
}

// wrapError converts a generic error to a ToolError.
func (h *ErrorHandler) wrapError(err error, toolID string) *ToolError {
	// Check for specific error types
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return NewToolError(ErrorTypeTimeout, "TIMEOUT", "execution timeout exceeded").
			WithToolID(toolID).
			WithCause(err)

	case errors.Is(err, context.Canceled):
		return NewToolError(ErrorTypeCancellation, "CANCELLED", "execution was cancelled").
			WithToolID(toolID).
			WithCause(err)

	default:
		return NewToolError(ErrorTypeExecution, "EXECUTION_ERROR", err.Error()).
			WithToolID(toolID).
			WithCause(err)
	}
}

// ValidationErrorBuilder helps build detailed validation errors.
type ValidationErrorBuilder struct {
	errors []string
	fields map[string][]string
}

// NewValidationErrorBuilder creates a new validation error builder.
func NewValidationErrorBuilder() *ValidationErrorBuilder {
	return &ValidationErrorBuilder{
		errors: []string{},
		fields: make(map[string][]string),
	}
}

// AddError adds a general validation error.
func (b *ValidationErrorBuilder) AddError(message string) *ValidationErrorBuilder {
	b.errors = append(b.errors, message)
	return b
}

// AddFieldError adds a field-specific validation error.
func (b *ValidationErrorBuilder) AddFieldError(field, message string) *ValidationErrorBuilder {
	b.fields[field] = append(b.fields[field], message)
	return b
}

// Build creates a ToolError from the validation errors.
func (b *ValidationErrorBuilder) Build(toolID string) *ToolError {
	if len(b.errors) == 0 && len(b.fields) == 0 {
		return nil
	}

	// Build error message
	var messages []string
	messages = append(messages, b.errors...)

	for field, fieldErrors := range b.fields {
		for _, err := range fieldErrors {
			messages = append(messages, fmt.Sprintf("%s: %s", field, err))
		}
	}

	err := NewToolError(
		ErrorTypeValidation,
		"VALIDATION_FAILED",
		strings.Join(messages, "; "),
	).WithToolID(toolID)

	// Add field errors as details
	if len(b.fields) > 0 {
		err.WithDetail("field_errors", b.fields)
	}

	return err
}

// HasErrors returns true if there are any validation errors.
func (b *ValidationErrorBuilder) HasErrors() bool {
	return len(b.errors) > 0 || len(b.fields) > 0
}

// CircuitBreaker provides circuit breaker pattern for tool execution.
type CircuitBreaker struct {
	// Configuration
	failureThreshold int
	resetTimeout     time.Duration

	// State (protected by mutex)
	mu          sync.RWMutex
	failures    int
	lastFailure time.Time
	state       CircuitState
}

// CircuitState represents the circuit breaker state.
type CircuitState int

const (
	// CircuitClosed allows requests through
	CircuitClosed CircuitState = iota
	// CircuitOpen blocks requests
	CircuitOpen
	// CircuitHalfOpen allows limited requests for testing
	CircuitHalfOpen
)

// NewCircuitBreaker creates a new circuit breaker.
func NewCircuitBreaker(threshold int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		failureThreshold: threshold,
		resetTimeout:     resetTimeout,
		state:            CircuitClosed,
	}
}

// Call executes a function with circuit breaker protection.
func (cb *CircuitBreaker) Call(fn func() error) error {
	if err := cb.canProceed(); err != nil {
		return err
	}

	err := fn()
	cb.recordResult(err)
	return err
}

// canProceed checks if the circuit allows the call.
func (cb *CircuitBreaker) canProceed() error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case CircuitOpen:
		if time.Since(cb.lastFailure) > cb.resetTimeout {
			cb.state = CircuitHalfOpen
			cb.failures = 0
			return nil
		}
		return NewToolError(
			ErrorTypeExecution,
			"CIRCUIT_OPEN",
			"circuit breaker is open",
		).WithRetry(cb.resetTimeout - time.Since(cb.lastFailure))

	case CircuitHalfOpen, CircuitClosed:
		return nil

	default:
		return nil
	}
}

// recordResult updates circuit breaker state based on result.
func (cb *CircuitBreaker) recordResult(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err == nil {
		if cb.state == CircuitHalfOpen {
			cb.state = CircuitClosed
		}
		cb.failures = 0
		return
	}

	cb.failures++
	cb.lastFailure = time.Now()

	if cb.failures >= cb.failureThreshold {
		cb.state = CircuitOpen
	}
}

// GetState returns the current circuit breaker state.
func (cb *CircuitBreaker) GetState() CircuitState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// Reset manually resets the circuit breaker.
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.state = CircuitClosed
	cb.failures = 0
}