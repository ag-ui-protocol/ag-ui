package errors

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"time"
)

// Wrap wraps an error with additional context
func Wrap(err error, message string) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", message, err)
}

// Wrapf wraps an error with formatted context
func Wrapf(err error, format string, args ...interface{}) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), err)
}

// Is checks if an error matches a target error
func Is(err, target error) bool {
	return errors.Is(err, target)
}

// As attempts to extract a specific error type
func As(err error, target interface{}) bool {
	return errors.As(err, target)
}

// Cause returns the root cause of an error
func Cause(err error) error {
	for {
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			break
		}
		unwrapped := unwrapper.Unwrap()
		if unwrapped == nil {
			break
		}
		err = unwrapped
	}
	return err
}

// Chain creates a chain of errors
func Chain(errs ...error) error {
	var nonNil []error
	for _, err := range errs {
		if err != nil {
			nonNil = append(nonNil, err)
		}
	}

	switch len(nonNil) {
	case 0:
		return nil
	case 1:
		return nonNil[0]
	default:
		return &ChainedError{errors: nonNil}
	}
}

// ChainedError represents multiple errors
type ChainedError struct {
	errors []error
}

// Error returns the combined error message
func (e *ChainedError) Error() string {
	if len(e.errors) == 0 {
		return ""
	}

	var messages []string
	for _, err := range e.errors {
		messages = append(messages, err.Error())
	}
	return strings.Join(messages, "; ")
}

// Errors returns all errors in the chain
func (e *ChainedError) Errors() []error {
	return e.errors
}

// Unwrap returns the first error in the chain
func (e *ChainedError) Unwrap() error {
	if len(e.errors) > 0 {
		return e.errors[0]
	}
	return nil
}

// RetryConfig configures retry behavior
type RetryConfig struct {
	// MaxAttempts is the maximum number of attempts (0 = unlimited)
	MaxAttempts int

	// InitialDelay is the initial delay between retries
	InitialDelay time.Duration

	// MaxDelay is the maximum delay between retries
	MaxDelay time.Duration

	// Multiplier is the delay multiplier for exponential backoff
	Multiplier float64

	// Jitter adds randomness to delays (0.0 to 1.0)
	Jitter float64

	// RetryIf determines if an error should be retried
	RetryIf func(error) bool

	// OnRetry is called before each retry attempt
	OnRetry func(attempt int, err error, delay time.Duration)
}

// DefaultRetryConfig returns a default retry configuration
func DefaultRetryConfig() *RetryConfig {
	return &RetryConfig{
		MaxAttempts:  3,
		InitialDelay: 100 * time.Millisecond,
		MaxDelay:     30 * time.Second,
		Multiplier:   2.0,
		Jitter:       0.1,
		RetryIf:      IsRetryable,
	}
}

// Retry executes a function with retry logic
func Retry(ctx context.Context, config *RetryConfig, fn func() error) error {
	if config == nil {
		config = DefaultRetryConfig()
	}

	var lastErr error
	delay := config.InitialDelay

	for attempt := 1; config.MaxAttempts == 0 || attempt <= config.MaxAttempts; attempt++ {
		// Execute the function
		err := fn()
		if err == nil {
			return nil
		}

		lastErr = err

		// Check if we should retry
		if config.RetryIf != nil && !config.RetryIf(err) {
			return err
		}

		// Check if this is the last attempt
		if config.MaxAttempts > 0 && attempt >= config.MaxAttempts {
			break
		}

		// Calculate delay with jitter
		actualDelay := applyJitter(delay, config.Jitter)

		// Call retry callback if provided
		if config.OnRetry != nil {
			config.OnRetry(attempt, err, actualDelay)
		}

		// Wait or return if context is done
		select {
		case <-ctx.Done():
			return Chain(lastErr, ctx.Err())
		case <-time.After(actualDelay):
		}

		// Calculate next delay
		delay = calculateNextDelay(delay, config.Multiplier, config.MaxDelay)
	}

	return NewBaseError("RETRY_EXHAUSTED", "retry attempts exhausted").
		WithCause(lastErr).
		WithDetail("attempts", config.MaxAttempts)
}

// applyJitter adds randomness to a duration
func applyJitter(d time.Duration, jitter float64) time.Duration {
	if jitter <= 0 {
		return d
	}

	jitter = math.Min(jitter, 1.0)
	jitterRange := float64(d) * jitter
	jitterValue := (rand.Float64() * 2 * jitterRange) - jitterRange

	return time.Duration(float64(d) + jitterValue)
}

// calculateNextDelay calculates the next retry delay
func calculateNextDelay(current time.Duration, multiplier float64, max time.Duration) time.Duration {
	next := time.Duration(float64(current) * multiplier)
	if next > max {
		return max
	}
	return next
}

// NewBaseError creates a new base error
func NewBaseError(code, message string) *BaseError {
	return &BaseError{
		Code:      code,
		Message:   message,
		Severity:  SeverityError,
		Timestamp: time.Now(),
		Details:   make(map[string]interface{}),
	}
}

// Encoding-specific error creation functions

// NewDecodingError creates a decoding error
func NewDecodingError(code, message string) *EncodingError {
	return NewEncodingError(code, message).WithOperation("decode")
}

// NewStreamingError creates a streaming error
func NewStreamingError(code, message string) *EncodingError {
	return NewEncodingError(code, message).WithOperation("stream")
}

// NewXSSError creates an XSS detection error
func NewXSSError(message, pattern string) *SecurityError {
	return NewSecurityError("XSS_DETECTED", message).
		WithViolationType("cross_site_scripting").
		WithPattern(pattern).
		WithRiskLevel("high")
}

// NewSQLInjectionError creates a SQL injection detection error
func NewSQLInjectionError(message, pattern string) *SecurityError {
	return NewSecurityError("SQL_INJECTION_DETECTED", message).
		WithViolationType("sql_injection").
		WithPattern(pattern).
		WithRiskLevel("critical")
}

// NewScriptInjectionError creates a script injection detection error
func NewScriptInjectionError(message, pattern string) *SecurityError {
	return NewSecurityError("SCRIPT_INJECTION_DETECTED", message).
		WithViolationType("script_injection").
		WithPattern(pattern).
		WithRiskLevel("high")
}

// NewDOSError creates a denial of service detection error
func NewDOSError(message, location string) *SecurityError {
	return NewSecurityError("DOS_ATTACK_DETECTED", message).
		WithViolationType("denial_of_service").
		WithLocation(location).
		WithRiskLevel("medium")
}

// NewPathTraversalError creates a path traversal detection error
func NewPathTraversalError(message, pattern string) *SecurityError {
	return NewSecurityError("PATH_TRAVERSAL_DETECTED", message).
		WithViolationType("path_traversal").
		WithPattern(pattern).
		WithRiskLevel("high")
}

// IsSecurityError checks if an error is a security error
func IsSecurityError(err error) bool {
	if err == nil {
		return false
	}
	var securityErr *SecurityError
	return errors.As(err, &securityErr)
}

// WithOperation adds operation context to errors
func WithOperation(op, target string, err error) error {
	if err == nil {
		return nil
	}
	return NewOperationError(op, target, err)
}

// Common error codes for the system
const (
	// Validation error codes
	CodeValidationFailed  = "VALIDATION_FAILED"
	CodeMissingEvent      = "MISSING_EVENT"
	CodeMissingEventType  = "MISSING_EVENT_TYPE"
	CodeNegativeTimestamp = "NEGATIVE_TIMESTAMP"
	CodeIDTooLong         = "ID_TOO_LONG"

	// Registry error codes
	CodeFormatNotRegistered = "FORMAT_NOT_REGISTERED"
	CodeNilFactory          = "NIL_FACTORY"
	CodeEmptyMimeType       = "EMPTY_MIME_TYPE"

	// Encoding/Decoding error codes
	CodeEncodingFailed = "ENCODING_FAILED"
	CodeDecodingFailed = "DECODING_FAILED"

	// Security error codes
	CodeSecurityViolation = "SECURITY_VIOLATION"
	CodeXSSDetected       = "XSS_DETECTED"
	CodeInvalidData       = "INVALID_DATA"
	CodeSizeExceeded      = "SIZE_EXCEEDED"
	CodeDepthExceeded     = "DEPTH_EXCEEDED"
	CodeNullByteDetected  = "NULL_BYTE_DETECTED"
	CodeInvalidUTF8       = "INVALID_UTF8"
	CodeHTMLNotAllowed    = "HTML_NOT_ALLOWED"
	CodeEntityExpansion   = "ENTITY_EXPANSION"
	CodeZipBomb           = "ZIP_BOMB"

	// Negotiation error codes
	CodeNegotiationFailed = "NEGOTIATION_FAILED"
	CodeNoSuitableFormat  = "NO_SUITABLE_FORMAT"
	CodeUnsupportedFormat = "UNSUPPORTED_FORMAT"
)
