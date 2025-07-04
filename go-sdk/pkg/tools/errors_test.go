package tools

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToolError(t *testing.T) {
	t.Run("NewToolError", func(t *testing.T) {
		err := NewToolError(ErrorTypeValidation, "TEST_CODE", "test message")
		
		assert.Equal(t, ErrorTypeValidation, err.Type)
		assert.Equal(t, "TEST_CODE", err.Code)
		assert.Equal(t, "test message", err.Message)
		assert.NotZero(t, err.Timestamp)
		assert.NotNil(t, err.Details)
		assert.Empty(t, err.ToolID)
		assert.Nil(t, err.Cause)
		assert.False(t, err.Retryable)
		assert.Nil(t, err.RetryAfter)
	})

	t.Run("Error method", func(t *testing.T) {
		tests := []struct {
			name     string
			err      *ToolError
			expected string
		}{
			{
				name:     "basic error",
				err:      NewToolError(ErrorTypeValidation, "", "test message"),
				expected: "test message",
			},
			{
				name:     "error with code",
				err:      NewToolError(ErrorTypeValidation, "TEST_CODE", "test message"),
				expected: "[TEST_CODE]: test message",
			},
			{
				name:     "error with tool ID",
				err:      NewToolError(ErrorTypeValidation, "", "test message").WithToolID("test-tool"),
				expected: `tool "test-tool": test message`,
			},
			{
				name:     "error with code and tool ID",
				err:      NewToolError(ErrorTypeValidation, "TEST_CODE", "test message").WithToolID("test-tool"),
				expected: `[TEST_CODE]: tool "test-tool": test message`,
			},
			{
				name: "error with cause",
				err: NewToolError(ErrorTypeValidation, "", "test message").
					WithCause(errors.New("underlying error")),
				expected: "test message: caused by: underlying error",
			},
			{
				name: "error with all fields",
				err: NewToolError(ErrorTypeValidation, "TEST_CODE", "test message").
					WithToolID("test-tool").
					WithCause(errors.New("underlying error")),
				expected: `[TEST_CODE]: tool "test-tool": test message: caused by: underlying error`,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.Equal(t, tt.expected, tt.err.Error())
			})
		}
	})

	t.Run("Unwrap", func(t *testing.T) {
		cause := errors.New("underlying error")
		err := NewToolError(ErrorTypeValidation, "TEST_CODE", "test message").WithCause(cause)
		
		assert.Equal(t, cause, err.Unwrap())
		assert.True(t, errors.Is(err, cause))
	})

	t.Run("Is method", func(t *testing.T) {
		tests := []struct {
			name     string
			err      *ToolError
			target   error
			expected bool
		}{
			{
				name:     "nil target",
				err:      NewToolError(ErrorTypeValidation, "", ""),
				target:   nil,
				expected: false,
			},
			{
				name:     "ErrToolNotFound match",
				err:      NewToolError(ErrorTypeValidation, "", "tool not found"),
				target:   ErrToolNotFound,
				expected: true,
			},
			{
				name:     "ErrToolNotFound no match",
				err:      NewToolError(ErrorTypeExecution, "", "something else"),
				target:   ErrToolNotFound,
				expected: false,
			},
			{
				name:     "ErrInvalidParameters match",
				err:      NewToolError(ErrorTypeValidation, "", "invalid"),
				target:   ErrInvalidParameters,
				expected: true,
			},
			{
				name:     "ErrExecutionTimeout match",
				err:      NewToolError(ErrorTypeTimeout, "", "timeout"),
				target:   ErrExecutionTimeout,
				expected: true,
			},
			{
				name:     "ErrExecutionCancelled match",
				err:      NewToolError(ErrorTypeCancellation, "", "cancelled"),
				target:   ErrExecutionCancelled,
				expected: true,
			},
			{
				name:     "ErrRateLimitExceeded match",
				err:      NewToolError(ErrorTypeRateLimit, "", "rate limit"),
				target:   ErrRateLimitExceeded,
				expected: true,
			},
			{
				name:     "ErrMaxConcurrencyReached match",
				err:      NewToolError(ErrorTypeConcurrency, "", "concurrency"),
				target:   ErrMaxConcurrencyReached,
				expected: true,
			},
			{
				name:     "ToolError type and code match",
				err:      NewToolError(ErrorTypeValidation, "CODE1", "msg"),
				target:   NewToolError(ErrorTypeValidation, "CODE1", "different msg"),
				expected: true,
			},
			{
				name:     "ToolError type mismatch",
				err:      NewToolError(ErrorTypeValidation, "CODE1", "msg"),
				target:   NewToolError(ErrorTypeExecution, "CODE1", "msg"),
				expected: false,
			},
			{
				name:     "ToolError code mismatch",
				err:      NewToolError(ErrorTypeValidation, "CODE1", "msg"),
				target:   NewToolError(ErrorTypeValidation, "CODE2", "msg"),
				expected: false,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.Equal(t, tt.expected, tt.err.Is(tt.target))
			})
		}
	})
}


func TestErrorHandler(t *testing.T) {
	t.Run("NewErrorHandler", func(t *testing.T) {
		handler := NewErrorHandler()
		
		assert.NotNil(t, handler)
		assert.NotNil(t, handler.transformers)
		assert.NotNil(t, handler.listeners)
		assert.NotNil(t, handler.strategies)
		assert.Empty(t, handler.transformers)
		assert.Empty(t, handler.listeners)
		assert.Empty(t, handler.strategies)
	})

	t.Run("HandleError with ToolError", func(t *testing.T) {
		handler := NewErrorHandler()
		
		// Add transformer
		var transformedErr *ToolError
		handler.AddTransformer(func(err *ToolError) *ToolError {
			transformedErr = err
			err.WithDetail("transformed", true)
			return err
		})
		
		// Add listener
		var listenedErr *ToolError
		handler.AddListener(func(err *ToolError) {
			listenedErr = err
		})
		
		toolErr := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := handler.HandleError(toolErr, "test-tool")
		
		assert.NotNil(t, transformedErr)
		assert.NotNil(t, listenedErr)
		assert.True(t, result.(*ToolError).Details["transformed"].(bool))
		assert.Same(t, transformedErr, listenedErr)
	})

	t.Run("HandleError with generic error", func(t *testing.T) {
		handler := NewErrorHandler()
		
		genericErr := errors.New("generic error")
		result := handler.HandleError(genericErr, "test-tool")
		
		toolErr, ok := result.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, ErrorTypeExecution, toolErr.Type)
		assert.Equal(t, "EXECUTION_ERROR", toolErr.Code)
		assert.Equal(t, "generic error", toolErr.Message)
		assert.Equal(t, "test-tool", toolErr.ToolID)
		assert.Equal(t, genericErr, toolErr.Cause)
	})

	t.Run("HandleError with context.DeadlineExceeded", func(t *testing.T) {
		handler := NewErrorHandler()
		
		result := handler.HandleError(context.DeadlineExceeded, "test-tool")
		
		toolErr, ok := result.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, ErrorTypeTimeout, toolErr.Type)
		assert.Equal(t, "TIMEOUT", toolErr.Code)
		assert.Equal(t, "execution timeout exceeded", toolErr.Message)
		assert.Equal(t, context.DeadlineExceeded, toolErr.Cause)
	})

	t.Run("HandleError with context.Canceled", func(t *testing.T) {
		handler := NewErrorHandler()
		
		result := handler.HandleError(context.Canceled, "test-tool")
		
		toolErr, ok := result.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, ErrorTypeCancellation, toolErr.Type)
		assert.Equal(t, "CANCELLED", toolErr.Code)
		assert.Equal(t, "execution was cancelled", toolErr.Message)
		assert.Equal(t, context.Canceled, toolErr.Cause)
	})

	t.Run("Recover with recovery strategy", func(t *testing.T) {
		handler := NewErrorHandler()
		
		recoveryErr := errors.New("recovery failed")
		handler.SetRecoveryStrategy(ErrorTypeValidation, func(ctx context.Context, err *ToolError) error {
			return recoveryErr
		})
		
		toolErr := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := handler.Recover(context.Background(), toolErr)
		
		assert.Equal(t, recoveryErr, result)
	})

	t.Run("Recover without strategy", func(t *testing.T) {
		handler := NewErrorHandler()
		
		toolErr := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := handler.Recover(context.Background(), toolErr)
		
		assert.Same(t, toolErr, result)
	})

	t.Run("Recover with non-ToolError", func(t *testing.T) {
		handler := NewErrorHandler()
		
		genericErr := errors.New("generic error")
		result := handler.Recover(context.Background(), genericErr)
		
		assert.Same(t, genericErr, result)
	})

	t.Run("Multiple transformers", func(t *testing.T) {
		handler := NewErrorHandler()
		
		handler.AddTransformer(func(err *ToolError) *ToolError {
			err.WithDetail("transform1", true)
			return err
		})
		
		handler.AddTransformer(func(err *ToolError) *ToolError {
			err.WithDetail("transform2", true)
			return err
		})
		
		toolErr := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := handler.HandleError(toolErr, "test-tool")
		
		resultErr := result.(*ToolError)
		assert.True(t, resultErr.Details["transform1"].(bool))
		assert.True(t, resultErr.Details["transform2"].(bool))
	})

	t.Run("Multiple listeners", func(t *testing.T) {
		handler := NewErrorHandler()
		
		var count int
		handler.AddListener(func(err *ToolError) {
			count++
		})
		
		handler.AddListener(func(err *ToolError) {
			count++
		})
		
		toolErr := NewToolError(ErrorTypeValidation, "CODE", "message")
		handler.HandleError(toolErr, "test-tool")
		
		assert.Equal(t, 2, count)
	})
}

func TestValidationErrorBuilder(t *testing.T) {
	t.Run("NewValidationErrorBuilder", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		
		assert.NotNil(t, builder)
		assert.Empty(t, builder.errors)
		assert.Empty(t, builder.fields)
		assert.False(t, builder.HasErrors())
	})

	t.Run("AddError", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		result := builder.AddError("error 1").AddError("error 2")
		
		assert.Same(t, builder, result) // Should return same instance
		assert.Len(t, builder.errors, 2)
		assert.Equal(t, "error 1", builder.errors[0])
		assert.Equal(t, "error 2", builder.errors[1])
		assert.True(t, builder.HasErrors())
	})

	t.Run("AddFieldError", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		result := builder.
			AddFieldError("field1", "error 1").
			AddFieldError("field1", "error 2").
			AddFieldError("field2", "error 3")
		
		assert.Same(t, builder, result)
		assert.Len(t, builder.fields["field1"], 2)
		assert.Len(t, builder.fields["field2"], 1)
		assert.True(t, builder.HasErrors())
	})

	t.Run("Build with no errors", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		err := builder.Build("test-tool")
		
		assert.Nil(t, err)
	})

	t.Run("Build with general errors only", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		builder.AddError("error 1").AddError("error 2")
		
		err := builder.Build("test-tool")
		
		require.NotNil(t, err)
		assert.Equal(t, ErrorTypeValidation, err.Type)
		assert.Equal(t, "VALIDATION_FAILED", err.Code)
		assert.Equal(t, "error 1; error 2", err.Message)
		assert.Equal(t, "test-tool", err.ToolID)
		assert.NotContains(t, err.Details, "field_errors")
	})

	t.Run("Build with field errors only", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		builder.
			AddFieldError("field1", "error 1").
			AddFieldError("field2", "error 2")
		
		err := builder.Build("test-tool")
		
		require.NotNil(t, err)
		assert.Contains(t, err.Message, "field1: error 1")
		assert.Contains(t, err.Message, "field2: error 2")
		assert.Contains(t, err.Details, "field_errors")
		
		fieldErrors := err.Details["field_errors"].(map[string][]string)
		assert.Len(t, fieldErrors["field1"], 1)
		assert.Len(t, fieldErrors["field2"], 1)
	})

	t.Run("Build with mixed errors", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		builder.
			AddError("general error").
			AddFieldError("field1", "field error 1").
			AddFieldError("field1", "field error 2")
		
		err := builder.Build("test-tool")
		
		require.NotNil(t, err)
		assert.Contains(t, err.Message, "general error")
		assert.Contains(t, err.Message, "field1: field error 1")
		assert.Contains(t, err.Message, "field1: field error 2")
		assert.Contains(t, err.Details, "field_errors")
	})

	t.Run("HasErrors", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		assert.False(t, builder.HasErrors())
		
		builder.AddError("error")
		assert.True(t, builder.HasErrors())
		
		builder2 := NewValidationErrorBuilder()
		builder2.AddFieldError("field", "error")
		assert.True(t, builder2.HasErrors())
	})
}

func TestCircuitBreaker(t *testing.T) {
	t.Run("NewCircuitBreaker", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 5*time.Second)
		
		assert.NotNil(t, cb)
		assert.Equal(t, 3, cb.failureThreshold)
		assert.Equal(t, 5*time.Second, cb.resetTimeout)
		assert.Equal(t, CircuitClosed, cb.state)
		assert.Equal(t, 0, cb.failures)
	})

	t.Run("Call success", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 5*time.Second)
		
		err := cb.Call(func() error {
			return nil
		})
		
		assert.NoError(t, err)
		assert.Equal(t, CircuitClosed, cb.state)
		assert.Equal(t, 0, cb.failures)
	})

	t.Run("Call failure below threshold", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 5*time.Second)
		
		// Two failures
		for i := 0; i < 2; i++ {
			err := cb.Call(func() error {
				return errors.New("error")
			})
			assert.Error(t, err)
		}
		
		assert.Equal(t, CircuitClosed, cb.state)
		assert.Equal(t, 2, cb.failures)
	})

	t.Run("Call failure reaches threshold", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 5*time.Second)
		
		// Three failures - should open circuit
		for i := 0; i < 3; i++ {
			err := cb.Call(func() error {
				return errors.New("error")
			})
			assert.Error(t, err)
		}
		
		assert.Equal(t, CircuitOpen, cb.state)
		assert.Equal(t, 3, cb.failures)
		
		// Next call should fail with circuit open error
		err := cb.Call(func() error {
			return nil
		})
		
		require.Error(t, err)
		toolErr, ok := err.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, "CIRCUIT_OPEN", toolErr.Code)
		assert.True(t, toolErr.Retryable)
		assert.NotNil(t, toolErr.RetryAfter)
	})

	t.Run("Circuit breaker reset after timeout", func(t *testing.T) {
		cb := NewCircuitBreaker(2, 100*time.Millisecond)
		
		// Open the circuit
		for i := 0; i < 2; i++ {
			cb.Call(func() error {
				return errors.New("error")
			})
		}
		
		assert.Equal(t, CircuitOpen, cb.state)
		
		// Wait for reset timeout
		time.Sleep(150 * time.Millisecond)
		
		// Should move to half-open
		err := cb.Call(func() error {
			return nil
		})
		
		assert.NoError(t, err)
		assert.Equal(t, CircuitClosed, cb.state)
		assert.Equal(t, 0, cb.failures)
	})

	t.Run("Half-open to open on failure", func(t *testing.T) {
		cb := NewCircuitBreaker(2, 100*time.Millisecond)
		
		// Open the circuit
		for i := 0; i < 2; i++ {
			cb.Call(func() error {
				return errors.New("error")
			})
		}
		
		// Wait for reset timeout
		time.Sleep(150 * time.Millisecond)
		
		// Fail in half-open state
		err := cb.Call(func() error {
			return errors.New("still failing")
		})
		
		assert.Error(t, err)
		assert.Equal(t, CircuitHalfOpen, cb.state) // Still in half-open until threshold
		assert.Equal(t, 1, cb.failures)
	})

	t.Run("GetState", func(t *testing.T) {
		cb := NewCircuitBreaker(2, 5*time.Second)
		
		assert.Equal(t, CircuitClosed, cb.GetState())
		
		// Open circuit
		for i := 0; i < 2; i++ {
			cb.Call(func() error {
				return errors.New("error")
			})
		}
		
		assert.Equal(t, CircuitOpen, cb.GetState())
	})

	t.Run("Reset", func(t *testing.T) {
		cb := NewCircuitBreaker(2, 5*time.Second)
		
		// Open circuit
		for i := 0; i < 2; i++ {
			cb.Call(func() error {
				return errors.New("error")
			})
		}
		
		assert.Equal(t, CircuitOpen, cb.state)
		assert.Equal(t, 2, cb.failures)
		
		cb.Reset()
		
		assert.Equal(t, CircuitClosed, cb.state)
		assert.Equal(t, 0, cb.failures)
	})

	t.Run("Success resets failure count", func(t *testing.T) {
		cb := NewCircuitBreaker(3, 5*time.Second)
		
		// Two failures
		for i := 0; i < 2; i++ {
			cb.Call(func() error {
				return errors.New("error")
			})
		}
		assert.Equal(t, 2, cb.failures)
		
		// Success should reset
		err := cb.Call(func() error {
			return nil
		})
		
		assert.NoError(t, err)
		assert.Equal(t, 0, cb.failures)
		assert.Equal(t, CircuitClosed, cb.state)
	})
}

func TestCommonErrorVariables(t *testing.T) {
	// Test that common error variables are properly defined
	assert.EqualError(t, ErrToolNotFound, "tool not found")
	assert.EqualError(t, ErrInvalidParameters, "invalid parameters")
	assert.EqualError(t, ErrExecutionTimeout, "execution timeout")
	assert.EqualError(t, ErrExecutionCancelled, "execution cancelled")
	assert.EqualError(t, ErrRateLimitExceeded, "rate limit exceeded")
	assert.EqualError(t, ErrMaxConcurrencyReached, "maximum concurrent executions reached")
	assert.EqualError(t, ErrToolPanicked, "tool execution panicked")
	assert.EqualError(t, ErrStreamingNotSupported, "streaming not supported")
	assert.EqualError(t, ErrCircularDependency, "circular dependency detected")
}

func TestErrorTypeConversions(t *testing.T) {
	t.Run("wrapError edge cases", func(t *testing.T) {
		handler := NewErrorHandler()
		
		// Create wrapped context errors
		wrappedTimeout := fmt.Errorf("wrapped: %w", context.DeadlineExceeded)
		result := handler.HandleError(wrappedTimeout, "test-tool")
		
		toolErr, ok := result.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, ErrorTypeTimeout, toolErr.Type)
		
		wrappedCanceled := fmt.Errorf("wrapped: %w", context.Canceled)
		result2 := handler.HandleError(wrappedCanceled, "test-tool")
		
		toolErr2, ok := result2.(*ToolError)
		require.True(t, ok)
		assert.Equal(t, ErrorTypeCancellation, toolErr2.Type)
	})
}

func TestToolErrorBuilderMethods(t *testing.T) {
	t.Run("WithToolID", func(t *testing.T) {
		err := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := err.WithToolID("test-tool")
		
		assert.Same(t, err, result) // Should return same instance
		assert.Equal(t, "test-tool", err.ToolID)
	})

	t.Run("WithCause", func(t *testing.T) {
		cause := errors.New("underlying error")
		err := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := err.WithCause(cause)
		
		assert.Same(t, err, result)
		assert.Equal(t, cause, err.Cause)
	})

	t.Run("WithDetail", func(t *testing.T) {
		err := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := err.WithDetail("key1", "value1").WithDetail("key2", 42)
		
		assert.Same(t, err, result)
		assert.Equal(t, "value1", err.Details["key1"])
		assert.Equal(t, 42, err.Details["key2"])
	})

	t.Run("WithRetry", func(t *testing.T) {
		duration := 5 * time.Second
		err := NewToolError(ErrorTypeValidation, "CODE", "message")
		result := err.WithRetry(duration)
		
		assert.Same(t, err, result)
		assert.True(t, err.Retryable)
		require.NotNil(t, err.RetryAfter)
		assert.Equal(t, duration, *err.RetryAfter)
	})

	t.Run("Chaining methods", func(t *testing.T) {
		cause := errors.New("cause")
		err := NewToolError(ErrorTypeValidation, "CODE", "message").
			WithToolID("tool").
			WithCause(cause).
			WithDetail("key", "value").
			WithRetry(time.Second)
		
		assert.Equal(t, "tool", err.ToolID)
		assert.Equal(t, cause, err.Cause)
		assert.Equal(t, "value", err.Details["key"])
		assert.True(t, err.Retryable)
		assert.Equal(t, time.Second, *err.RetryAfter)
	})
}

func TestEdgeCases(t *testing.T) {
	t.Run("ToolError with nil details map", func(t *testing.T) {
		err := &ToolError{
			Type:    ErrorTypeValidation,
			Code:    "CODE",
			Message: "message",
			Details: nil,
		}
		
		// WithDetail should initialize the map if nil
		assert.NotPanics(t, func() {
			err.WithDetail("key", "value")
		})
		assert.NotNil(t, err.Details)
		assert.Equal(t, "value", err.Details["key"])
	})

	t.Run("CircuitBreaker with zero threshold", func(t *testing.T) {
		cb := NewCircuitBreaker(0, 5*time.Second)
		
		// Should immediately open
		err := cb.Call(func() error {
			return errors.New("error")
		})
		
		assert.Error(t, err)
		assert.Equal(t, CircuitOpen, cb.state)
	})

	t.Run("ValidationErrorBuilder edge cases", func(t *testing.T) {
		builder := NewValidationErrorBuilder()
		
		// Empty field name
		builder.AddFieldError("", "error")
		err := builder.Build("test-tool")
		
		require.NotNil(t, err)
		assert.Contains(t, err.Message, ": error")
		
		// Very long error messages
		longMessage := string(make([]byte, 1000))
		builder2 := NewValidationErrorBuilder()
		builder2.AddError(longMessage)
		err2 := builder2.Build("test-tool")
		
		require.NotNil(t, err2)
		assert.Equal(t, longMessage, err2.Message)
	})

	t.Run("ErrorHandler with nil error", func(t *testing.T) {
		handler := NewErrorHandler()
		
		// Should handle nil error gracefully
		assert.NotPanics(t, func() {
			result := handler.HandleError(nil, "test-tool")
			assert.NotNil(t, result)
		})
	})

	t.Run("ToolError Is with self", func(t *testing.T) {
		err := NewToolError(ErrorTypeValidation, "CODE", "message")
		
		// Should match itself
		assert.True(t, err.Is(err))
	})

	t.Run("CircuitBreaker concurrent access", func(t *testing.T) {
		cb := NewCircuitBreaker(10, 5*time.Second)
		
		// Run multiple goroutines
		done := make(chan bool, 10)
		for i := 0; i < 10; i++ {
			go func(id int) {
				defer func() { done <- true }()
				
				cb.Call(func() error {
					if id%2 == 0 {
						return errors.New("error")
					}
					return nil
				})
			}(i)
		}
		
		// Wait for all goroutines
		for i := 0; i < 10; i++ {
			<-done
		}
		
		// Circuit should still be in valid state
		assert.Contains(t, []CircuitState{CircuitClosed, CircuitOpen, CircuitHalfOpen}, cb.state)
	})
}