// Package errors provides comprehensive error handling utilities for the ag-ui Go SDK.
// It includes custom error types, severity-based handling, context management, and retry logic.
package errors

import (
	"errors"
	"fmt"
	"time"
)

// Common sentinel errors
var (
	// ErrStateInvalid indicates an invalid state transition or state data
	ErrStateInvalid = errors.New("invalid state")

	// ErrValidationFailed indicates validation of input data failed
	ErrValidationFailed = errors.New("validation failed")

	// ErrConflict indicates a conflict in concurrent operations
	ErrConflict = errors.New("operation conflict")

	// ErrRetryExhausted indicates all retry attempts have been exhausted
	ErrRetryExhausted = errors.New("retry attempts exhausted")

	// ErrContextMissing indicates required context information is missing
	ErrContextMissing = errors.New("required context missing")

	// ErrOperationNotPermitted indicates the operation is not allowed
	ErrOperationNotPermitted = errors.New("operation not permitted")

	// Encoding-specific sentinel errors
	// ErrEncodingNotSupported indicates the encoding format is not supported
	ErrEncodingNotSupported = errors.New("encoding format not supported")

	// ErrDecodingFailed indicates decoding of data failed
	ErrDecodingFailed = errors.New("decoding failed")

	// ErrEncodingFailed indicates encoding of data failed
	ErrEncodingFailed = errors.New("encoding failed")

	// ErrFormatNotRegistered indicates the format is not registered
	ErrFormatNotRegistered = errors.New("format not registered")

	// ErrInvalidMimeType indicates an invalid MIME type
	ErrInvalidMimeType = errors.New("invalid MIME type")

	// ErrStreamingNotSupported indicates streaming is not supported
	ErrStreamingNotSupported = errors.New("streaming not supported")

	// ErrChunkingFailed indicates chunking of data failed
	ErrChunkingFailed = errors.New("chunking failed")

	// ErrCompressionFailed indicates compression of data failed
	ErrCompressionFailed = errors.New("compression failed")

	// ErrSecurityViolation indicates a security policy violation
	ErrSecurityViolation = errors.New("security violation")

	// ErrCompatibilityCheck indicates a compatibility check failure
	ErrCompatibilityCheck = errors.New("compatibility check failed")

	// ErrNegotiationFailed indicates content negotiation failed
	ErrNegotiationFailed = errors.New("negotiation failed")
)

// ErrorType represents different categories of errors for agents
type ErrorType string

const (
	// ErrorTypeInvalidState indicates an invalid agent state transition
	ErrorTypeInvalidState ErrorType = "invalid_state"

	// ErrorTypeUnsupported indicates an unsupported operation
	ErrorTypeUnsupported ErrorType = "unsupported"

	// ErrorTypeTimeout indicates a timeout occurred
	ErrorTypeTimeout ErrorType = "timeout"

	// ErrorTypeValidation indicates validation failed
	ErrorTypeValidation ErrorType = "validation"

	// ErrorTypeNotFound indicates a resource was not found
	ErrorTypeNotFound ErrorType = "not_found"

	// ErrorTypePermission indicates insufficient permissions
	ErrorTypePermission ErrorType = "permission"

	// ErrorTypeExternal indicates an external service error
	ErrorTypeExternal ErrorType = "external"

	// ErrorTypeRateLimit indicates rate limiting errors
	ErrorTypeRateLimit ErrorType = "rate_limit"
)

// Severity levels for errors
type Severity int

const (
	// SeverityDebug indicates a debug-level error (informational)
	SeverityDebug Severity = iota
	// SeverityInfo indicates an informational error
	SeverityInfo
	// SeverityWarning indicates a warning that doesn't prevent operation
	SeverityWarning
	// SeverityError indicates a recoverable error
	SeverityError
	// SeverityCritical indicates a critical error requiring immediate attention
	SeverityCritical
	// SeverityFatal indicates a fatal error that requires termination
	SeverityFatal
)

// String returns the string representation of severity
func (s Severity) String() string {
	switch s {
	case SeverityDebug:
		return "DEBUG"
	case SeverityInfo:
		return "INFO"
	case SeverityWarning:
		return "WARNING"
	case SeverityError:
		return "ERROR"
	case SeverityCritical:
		return "CRITICAL"
	case SeverityFatal:
		return "FATAL"
	default:
		return "UNKNOWN"
	}
}

// BaseError provides common fields for all custom error types
type BaseError struct {
	// Code is a machine-readable error code
	Code string

	// Message is a human-readable error message
	Message string

	// Severity indicates the error severity
	Severity Severity

	// Timestamp is when the error occurred
	Timestamp time.Time

	// Details provides additional error context
	Details map[string]interface{}

	// Cause is the underlying error, if any
	Cause error

	// Retryable indicates if the operation can be retried
	Retryable bool

	// RetryAfter suggests when to retry (if retryable)
	RetryAfter *time.Duration
}

// Error implements the error interface
func (e *BaseError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("[%s] %s: %s (caused by: %v)", e.Severity, e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("[%s] %s: %s", e.Severity, e.Code, e.Message)
}

// Unwrap returns the underlying error
func (e *BaseError) Unwrap() error {
	return e.Cause
}

// WithDetail adds a detail to the error
func (e *BaseError) WithDetail(key string, value interface{}) *BaseError {
	if e.Details == nil {
		e.Details = make(map[string]interface{})
	}
	e.Details[key] = value
	return e
}

// WithCause adds an underlying cause to the error
func (e *BaseError) WithCause(cause error) *BaseError {
	e.Cause = cause
	return e
}

// WithRetry marks the error as retryable with a suggested retry time
func (e *BaseError) WithRetry(after time.Duration) *BaseError {
	e.Retryable = true
	e.RetryAfter = &after
	return e
}

// StateError represents errors related to state management
type StateError struct {
	*BaseError

	// StateID identifies the state that caused the error
	StateID string

	// CurrentState is the current state value (if available)
	CurrentState interface{}

	// ExpectedState is the expected state value (if applicable)
	ExpectedState interface{}

	// Transition describes the attempted state transition
	Transition string
}

// NewStateError creates a new state error
func NewStateError(code, message string) *StateError {
	return &StateError{
		BaseError: &BaseError{
			Code:      code,
			Message:   message,
			Severity:  SeverityError,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
	}
}

// Error implements the error interface with state-specific details
func (e *StateError) Error() string {
	base := e.BaseError.Error()
	if e.StateID != "" {
		base = fmt.Sprintf("%s (state: %s)", base, e.StateID)
	}
	if e.Transition != "" {
		base = fmt.Sprintf("%s (transition: %s)", base, e.Transition)
	}
	return base
}

// WithStateID sets the state ID
func (e *StateError) WithStateID(id string) *StateError {
	e.StateID = id
	return e
}

// WithStates sets the current and expected states
func (e *StateError) WithStates(current, expected interface{}) *StateError {
	e.CurrentState = current
	e.ExpectedState = expected
	return e
}

// WithTransition sets the attempted transition
func (e *StateError) WithTransition(transition string) *StateError {
	e.Transition = transition
	return e
}

// ValidationError represents validation-related errors
type ValidationError struct {
	*BaseError

	// Field identifies the field that failed validation
	Field string

	// Value is the invalid value
	Value interface{}

	// Rule is the validation rule that failed
	Rule string

	// FieldErrors contains field-specific validation errors
	FieldErrors map[string][]string
}

// NewValidationError creates a new validation error
func NewValidationError(code, message string) *ValidationError {
	return &ValidationError{
		BaseError: &BaseError{
			Code:      code,
			Message:   message,
			Severity:  SeverityWarning,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
		FieldErrors: make(map[string][]string),
	}
}

// Error implements the error interface with validation-specific details
func (e *ValidationError) Error() string {
	base := e.BaseError.Error()
	if e.Field != "" {
		base = fmt.Sprintf("%s (field: %s)", base, e.Field)
	}
	if e.Rule != "" {
		base = fmt.Sprintf("%s (rule: %s)", base, e.Rule)
	}
	return base
}

// WithField sets the field that failed validation
func (e *ValidationError) WithField(field string, value interface{}) *ValidationError {
	e.Field = field
	e.Value = value
	return e
}

// WithRule sets the validation rule that failed
func (e *ValidationError) WithRule(rule string) *ValidationError {
	e.Rule = rule
	return e
}

// AddFieldError adds a field-specific error
func (e *ValidationError) AddFieldError(field, message string) *ValidationError {
	e.FieldErrors[field] = append(e.FieldErrors[field], message)
	return e
}

// HasFieldErrors returns true if there are field-specific errors
func (e *ValidationError) HasFieldErrors() bool {
	return len(e.FieldErrors) > 0
}

// WithCause adds an underlying cause to the validation error and returns the ValidationError
func (e *ValidationError) WithCause(cause error) *ValidationError {
	e.BaseError.Cause = cause
	return e
}

// WithDetail adds a detail to the validation error and returns the ValidationError
func (e *ValidationError) WithDetail(key string, value interface{}) *ValidationError {
	if e.BaseError.Details == nil {
		e.BaseError.Details = make(map[string]interface{})
	}
	e.BaseError.Details[key] = value
	return e
}

// ConflictError represents conflict-related errors
type ConflictError struct {
	*BaseError

	// ResourceID identifies the resource in conflict
	ResourceID string

	// ResourceType describes the type of resource
	ResourceType string

	// ConflictingOperation describes the conflicting operation
	ConflictingOperation string

	// ResolutionStrategy suggests how to resolve the conflict
	ResolutionStrategy string
}

// NewConflictError creates a new conflict error
func NewConflictError(code, message string) *ConflictError {
	return &ConflictError{
		BaseError: &BaseError{
			Code:      code,
			Message:   message,
			Severity:  SeverityError,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
	}
}

// Error implements the error interface with conflict-specific details
func (e *ConflictError) Error() string {
	base := e.BaseError.Error()
	if e.ResourceType != "" && e.ResourceID != "" {
		base = fmt.Sprintf("%s (resource: %s/%s)", base, e.ResourceType, e.ResourceID)
	}
	if e.ConflictingOperation != "" {
		base = fmt.Sprintf("%s (operation: %s)", base, e.ConflictingOperation)
	}
	return base
}

// WithResource sets the conflicting resource details
func (e *ConflictError) WithResource(resourceType, resourceID string) *ConflictError {
	e.ResourceType = resourceType
	e.ResourceID = resourceID
	return e
}

// WithOperation sets the conflicting operation
func (e *ConflictError) WithOperation(operation string) *ConflictError {
	e.ConflictingOperation = operation
	return e
}

// WithResolution sets the suggested resolution strategy
func (e *ConflictError) WithResolution(strategy string) *ConflictError {
	e.ResolutionStrategy = strategy
	return e
}

// IsRetryable checks if an error is retryable
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}

	// Check if it's one of our custom errors
	switch e := err.(type) {
	case *BaseError:
		return e.Retryable
	case *StateError:
		return e.BaseError.Retryable
	case *ValidationError:
		return e.BaseError.Retryable
	case *ConflictError:
		return e.BaseError.Retryable
	}

	// Check wrapped errors
	var base *BaseError
	if errors.As(err, &base) {
		return base.Retryable
	}

	return false
}

// GetSeverity extracts the severity from an error
func GetSeverity(err error) Severity {
	if err == nil {
		return SeverityInfo
	}

	// Check if it's one of our custom errors
	switch e := err.(type) {
	case *BaseError:
		return e.Severity
	case *StateError:
		return e.BaseError.Severity
	case *ValidationError:
		return e.BaseError.Severity
	case *ConflictError:
		return e.BaseError.Severity
	case *EncodingError:
		return e.BaseError.Severity
	case *SecurityError:
		return e.BaseError.Severity
	}

	// Check wrapped errors
	var base *BaseError
	if errors.As(err, &base) {
		return base.Severity
	}

	// Default severity for unknown errors
	return SeverityError
}

// GetRetryAfter extracts the retry after duration from an error
func GetRetryAfter(err error) *time.Duration {
	if err == nil {
		return nil
	}

	// Check if it's one of our custom errors
	switch e := err.(type) {
	case *BaseError:
		return e.RetryAfter
	case *StateError:
		return e.BaseError.RetryAfter
	case *ValidationError:
		return e.BaseError.RetryAfter
	case *ConflictError:
		return e.BaseError.RetryAfter
	case *EncodingError:
		return e.BaseError.RetryAfter
	case *SecurityError:
		return e.BaseError.RetryAfter
	}

	// Check wrapped errors
	var base *BaseError
	if errors.As(err, &base) {
		return base.RetryAfter
	}

	return nil
}

// EncodingError represents encoding/decoding-related errors
type EncodingError struct {
	*BaseError

	// Format identifies the encoding format
	Format string

	// Operation describes the operation that failed (encode/decode/validate)
	Operation string

	// Data contains the problematic data (if safe to include)
	Data interface{}

	// Position indicates the position where the error occurred
	Position int64

	// MimeType is the MIME type being processed
	MimeType string
}

// NewEncodingError creates a new encoding error
func NewEncodingError(code, message string) *EncodingError {
	return &EncodingError{
		BaseError: &BaseError{
			Code:      code,
			Message:   message,
			Severity:  SeverityError,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
	}
}

// Error implements the error interface with encoding-specific details
func (e *EncodingError) Error() string {
	// Start with base message without cause
	base := fmt.Sprintf("[%s] %s: %s", e.Severity, e.Code, e.Message)

	// Add encoding-specific details first
	if e.Format != "" {
		base = fmt.Sprintf("%s (format: %s)", base, e.Format)
	}
	if e.Operation != "" {
		base = fmt.Sprintf("%s (operation: %s)", base, e.Operation)
	}
	if e.MimeType != "" {
		base = fmt.Sprintf("%s (mime: %s)", base, e.MimeType)
	}
	if e.Position > 0 {
		base = fmt.Sprintf("%s (position: %d)", base, e.Position)
	}

	// Add cause at the end
	if e.Cause != nil {
		base = fmt.Sprintf("%s (caused by: %v)", base, e.Cause)
	}

	return base
}

// WithFormat sets the encoding format
func (e *EncodingError) WithFormat(format string) *EncodingError {
	e.Format = format
	return e
}

// WithOperation sets the operation that failed
func (e *EncodingError) WithOperation(operation string) *EncodingError {
	e.Operation = operation
	return e
}

// WithMimeType sets the MIME type
func (e *EncodingError) WithMimeType(mimeType string) *EncodingError {
	e.MimeType = mimeType
	return e
}

// WithPosition sets the position where the error occurred
func (e *EncodingError) WithPosition(position int64) *EncodingError {
	e.Position = position
	return e
}

// WithData sets the problematic data (use with caution for sensitive data)
func (e *EncodingError) WithData(data interface{}) *EncodingError {
	e.Data = data
	return e
}

// WithCause adds an underlying cause to the encoding error and returns the EncodingError
func (e *EncodingError) WithCause(cause error) *EncodingError {
	e.BaseError.Cause = cause
	return e
}

// SecurityError represents security-related errors
type SecurityError struct {
	*BaseError

	// ViolationType describes the type of security violation
	ViolationType string

	// Pattern contains the detected pattern (if applicable)
	Pattern string

	// Location describes where the violation was detected
	Location string

	// RiskLevel indicates the risk level of the violation
	RiskLevel string
}

// NewSecurityError creates a new security error
func NewSecurityError(code, message string) *SecurityError {
	return &SecurityError{
		BaseError: &BaseError{
			Code:      code,
			Message:   message,
			Severity:  SeverityCritical,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
	}
}

// Error implements the error interface with security-specific details
func (e *SecurityError) Error() string {
	base := e.BaseError.Error()
	if e.ViolationType != "" {
		base = fmt.Sprintf("%s (violation: %s)", base, e.ViolationType)
	}
	if e.Pattern != "" {
		base = fmt.Sprintf("%s (pattern: %s)", base, e.Pattern)
	}
	if e.Location != "" {
		base = fmt.Sprintf("%s (location: %s)", base, e.Location)
	}
	if e.RiskLevel != "" {
		base = fmt.Sprintf("%s (risk: %s)", base, e.RiskLevel)
	}
	return base
}

// WithViolationType sets the type of security violation
func (e *SecurityError) WithViolationType(violationType string) *SecurityError {
	e.ViolationType = violationType
	return e
}

// WithPattern sets the detected pattern
func (e *SecurityError) WithPattern(pattern string) *SecurityError {
	e.Pattern = pattern
	return e
}

// WithLocation sets the location where the violation was detected
func (e *SecurityError) WithLocation(location string) *SecurityError {
	e.Location = location
	return e
}

// WithRiskLevel sets the risk level of the violation
func (e *SecurityError) WithRiskLevel(riskLevel string) *SecurityError {
	e.RiskLevel = riskLevel
	return e
}

// WithDetail adds a detail to the security error and returns the SecurityError
func (e *SecurityError) WithDetail(key string, value interface{}) *SecurityError {
	if e.BaseError.Details == nil {
		e.BaseError.Details = make(map[string]interface{})
	}
	e.BaseError.Details[key] = value
	return e
}

// WithCause adds an underlying cause to the security error and returns the SecurityError
func (e *SecurityError) WithCause(cause error) *SecurityError {
	e.BaseError.Cause = cause
	return e
}

// AgentError represents errors specific to agent operations
type AgentError struct {
	*BaseError

	// Type categorizes the error
	Type ErrorType

	// Agent identifies which agent encountered the error
	Agent string

	// EventID identifies the event being processed when error occurred (if applicable)
	EventID string
}

// NewAgentError creates a new agent error
func NewAgentError(errorType ErrorType, message, agent string) *AgentError {
	return &AgentError{
		BaseError: &BaseError{
			Code:      string(errorType),
			Message:   message,
			Severity:  SeverityError,
			Timestamp: time.Now(),
			Details:   make(map[string]interface{}),
		},
		Type:  errorType,
		Agent: agent,
	}
}

// Error implements the error interface with agent-specific details
func (e *AgentError) Error() string {
	base := e.BaseError.Error()
	if e.Agent != "" {
		base = fmt.Sprintf("%s (agent: %s)", base, e.Agent)
	}
	if e.EventID != "" {
		base = fmt.Sprintf("%s (event: %s)", base, e.EventID)
	}
	return base
}

// WithAgent sets the agent name
func (e *AgentError) WithAgent(agent string) *AgentError {
	e.Agent = agent
	return e
}

// WithEventID sets the event ID
func (e *AgentError) WithEventID(eventID string) *AgentError {
	e.EventID = eventID
	return e
}

// OperationError represents errors that occur during specific operations with context preservation
type OperationError struct {
	Op      string                 // Operation that failed
	Target  string                 // What was being operated on
	Err     error                  // Underlying error
	Code    string                 // Error code for programmatic handling
	Time    time.Time              // When the error occurred
	Details map[string]interface{} // Additional context
}

// NewOperationError creates a new OperationError
func NewOperationError(op, target string, err error) *OperationError {
	return &OperationError{
		Op:      op,
		Target:  target,
		Err:     err,
		Time:    time.Now(),
		Details: make(map[string]interface{}),
	}
}

// Error implements the error interface
func (e *OperationError) Error() string {
	return fmt.Sprintf("operation %s on %s failed: %v", e.Op, e.Target, e.Err)
}

// Unwrap returns the underlying error
func (e *OperationError) Unwrap() error {
	return e.Err
}

// WithCode sets the error code for programmatic handling
func (e *OperationError) WithCode(code string) *OperationError {
	e.Code = code
	return e
}

// WithDetail adds additional context to the error
func (e *OperationError) WithDetail(key string, value interface{}) *OperationError {
	if e.Details == nil {
		e.Details = make(map[string]interface{})
	}
	e.Details[key] = value
	return e
}

// WithCause sets the underlying cause of the error
func (e *OperationError) WithCause(cause error) *OperationError {
	e.Err = cause
	return e
}

// String returns a string representation of the error for debugging
func (e *OperationError) String() string {
	details := ""
	if len(e.Details) > 0 {
		details = fmt.Sprintf(" (details: %v)", e.Details)
	}
	codeStr := ""
	if e.Code != "" {
		codeStr = fmt.Sprintf(" [%s]", e.Code)
	}
	return fmt.Sprintf("OperationError{Op:%s, Target:%s, Code:%s, Time:%s}%s%s: %v",
		e.Op, e.Target, e.Code, e.Time.Format(time.RFC3339), codeStr, details, e.Err)
}
