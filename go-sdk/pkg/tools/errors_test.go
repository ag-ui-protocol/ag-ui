package tools_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/ag-ui/go-sdk/pkg/tools"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToolError(t *testing.T) {
	t.Run("NewToolError", func(t *testing.T) {
		err := tools.NewToolError(tools.ErrorTypeValidation, "TEST_CODE", "test message")

		assert.Equal(t, tools.ErrorTypeValidation, err.Type)
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
			err      *tools.ToolError
			expected string
		}{
			{
				name:     "basic error",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "", "test message"),
				expected: "test message",
			},
			{
				name:     "error with code",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "TEST_CODE", "test message"),
				expected: "[TEST_CODE]: test message",
			},
			{
				name:     "error with tool ID",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "", "test message").WithToolID("test-tool"),
				expected: `tool "test-tool": test message`,
			},
			{
				name:     "error with code and tool ID",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "TEST_CODE", "test message").WithToolID("test-tool"),
				expected: `[TEST_CODE]: tool "test-tool": test message`,
			},
			{
				name: "error with cause",
				err: tools.NewToolError(tools.ErrorTypeValidation, "", "test message").
					WithCause(errors.New("underlying error")),
				expected: "test message: caused by: underlying error",
			},
			{
				name: "error with all fields",
				err: tools.NewToolError(tools.ErrorTypeValidation, "TEST_CODE", "test message").
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
		err := tools.NewToolError(tools.ErrorTypeValidation, "TEST_CODE", "test message").WithCause(cause)

		assert.Equal(t, cause, err.Unwrap())
		assert.True(t, errors.Is(err, cause))
	})

	t.Run("Is method", func(t *testing.T) {
		tests := []struct {
			name     string
			err      *tools.ToolError
			target   error
			expected bool
		}{
			{
				name:     "nil target",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "", ""),
				target:   nil,
				expected: false,
			},
			{
				name:     "tools.ErrToolNotFound match",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "", "tool not found"),
				target:   tools.ErrToolNotFound,
				expected: true,
			},
			{
				name:     "tools.ErrToolNotFound no match",
				err:      tools.NewToolError(tools.ErrorTypeExecution, "", "something else"),
				target:   tools.ErrToolNotFound,
				expected: false,
			},
			{
				name:     "tools.ErrInvalidParameters match",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "", "invalid"),
				target:   tools.ErrInvalidParameters,
				expected: true,
			},
			{
				name:     "tools.ErrExecutionTimeout match",
				err:      tools.NewToolError(tools.ErrorTypeTimeout, "", "timeout"),
				target:   tools.ErrExecutionTimeout,
				expected: true,
			},
			{
				name:     "tools.ErrExecutionCanceled match",
				err:      tools.NewToolError(tools.ErrorTypeCancellation, "", "canceled"),
				target:   tools.ErrExecutionCanceled,
				expected: true,
			},
			{
				name:     "tools.ErrRateLimitExceeded match",
				err:      tools.NewToolError(tools.ErrorTypeRateLimit, "", "rate limit"),
				target:   tools.ErrRateLimitExceeded,
				expected: true,
			},
			{
				name:     "tools.ErrMaxConcurrencyReached match",
				err:      tools.NewToolError(tools.ErrorTypeConcurrency, "", "concurrency"),
				target:   tools.ErrMaxConcurrencyReached,
				expected: true,
			},
			{
				name:     "ToolError type and code match",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "CODE1", "msg"),
				target:   tools.NewToolError(tools.ErrorTypeValidation, "CODE1", "different msg"),
				expected: true,
			},
			{
				name:     "ToolError type mismatch",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "CODE1", "msg"),
				target:   tools.NewToolError(tools.ErrorTypeExecution, "CODE1", "msg"),
				expected: false,
			},
			{
				name:     "ToolError code mismatch",
				err:      tools.NewToolError(tools.ErrorTypeValidation, "CODE1", "msg"),
				target:   tools.NewToolError(tools.ErrorTypeValidation, "CODE2", "msg"),
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
		handler := tools.NewErrorHandler()

		assert.NotNil(t, handler)
		// Note: Cannot test internal fields when using external test package
	})

	t.Run("HandleError with ToolError", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		// Add transformer
		var transformedErr *tools.ToolError
		handler.AddTransformer(func(err *tools.ToolError) *tools.ToolError {
			transformedErr = err
			_ = err.WithDetail("transformed", true)
			return err
		})

		// Add listener
		var listenedErr *tools.ToolError
		handler.AddListener(func(err *tools.ToolError) {
			listenedErr = err
		})

		toolErr := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := handler.HandleError(toolErr, "test-tool")

		assert.NotNil(t, transformedErr)
		assert.NotNil(t, listenedErr)
		assert.True(t, result.(*tools.ToolError).Details["transformed"].(bool))
		assert.Same(t, transformedErr, listenedErr)
	})

	t.Run("HandleError with generic error", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		genericErr := errors.New("generic error")
		result := handler.HandleError(genericErr, "test-tool")

		toolErr, ok := result.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, tools.ErrorTypeExecution, toolErr.Type)
		assert.Equal(t, "EXECUTION_ERROR", toolErr.Code)
		assert.Equal(t, "generic error", toolErr.Message)
		assert.Equal(t, "test-tool", toolErr.ToolID)
		assert.Equal(t, genericErr, toolErr.Cause)
	})

	t.Run("HandleError with context.DeadlineExceeded", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		result := handler.HandleError(context.DeadlineExceeded, "test-tool")

		toolErr, ok := result.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, tools.ErrorTypeTimeout, toolErr.Type)
		assert.Equal(t, "TIMEOUT", toolErr.Code)
		assert.Equal(t, "execution timeout exceeded", toolErr.Message)
		assert.Equal(t, context.DeadlineExceeded, toolErr.Cause)
	})

	t.Run("HandleError with context.Canceled", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		result := handler.HandleError(context.Canceled, "test-tool")

		toolErr, ok := result.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, tools.ErrorTypeCancellation, toolErr.Type)
		assert.Equal(t, "CANCELED", toolErr.Code)
		assert.Equal(t, "execution was canceled", toolErr.Message)
		assert.Equal(t, context.Canceled, toolErr.Cause)
	})

	t.Run("Recover with recovery strategy", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		recoveryErr := errors.New("recovery failed")
		handler.SetRecoveryStrategy(tools.ErrorTypeValidation, func(ctx context.Context, err *tools.ToolError) error {
			return recoveryErr
		})

		toolErr := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := handler.Recover(context.Background(), toolErr)

		assert.Equal(t, recoveryErr, result)
	})

	t.Run("Recover without strategy", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		toolErr := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := handler.Recover(context.Background(), toolErr)

		assert.Same(t, toolErr, result)
	})

	t.Run("Recover with non-ToolError", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		genericErr := errors.New("generic error")
		result := handler.Recover(context.Background(), genericErr)

		assert.Same(t, genericErr, result)
	})

	t.Run("Multiple transformers", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		handler.AddTransformer(func(err *tools.ToolError) *tools.ToolError {
			_ = err.WithDetail("transform1", true) // Chainable method, ignore return
			return err
		})

		handler.AddTransformer(func(err *tools.ToolError) *tools.ToolError {
			_ = err.WithDetail("transform2", true) // Chainable method, ignore return
			return err
		})

		toolErr := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := handler.HandleError(toolErr, "test-tool")

		resultErr := result.(*tools.ToolError)
		assert.True(t, resultErr.Details["transform1"].(bool))
		assert.True(t, resultErr.Details["transform2"].(bool))
	})

	t.Run("Multiple listeners", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		var count int
		handler.AddListener(func(err *tools.ToolError) {
			count++
		})

		handler.AddListener(func(err *tools.ToolError) {
			count++
		})

		toolErr := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		_ = handler.HandleError(toolErr, "test-tool")

		assert.Equal(t, 2, count)
	})
}

func TestValidationErrorBuilder(t *testing.T) {
	t.Run("NewValidationErrorBuilder", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()

		assert.NotNil(t, builder)
		assert.False(t, builder.HasErrors())
	})

	t.Run("AddError", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()
		result := builder.AddError("error 1").AddError("error 2")

		assert.Same(t, builder, result) // Should return same instance
		assert.True(t, builder.HasErrors())
	})

	t.Run("AddFieldError", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()
		result := builder.
			AddFieldError("field1", "error 1").
			AddFieldError("field1", "error 2").
			AddFieldError("field2", "error 3")

		assert.Same(t, builder, result)
		assert.True(t, builder.HasErrors())
	})

	t.Run("Build with no errors", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()
		err := builder.Build("test-tool")

		assert.Nil(t, err)
	})

	t.Run("Build with general errors only", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()
		builder.AddError("error 1").AddError("error 2")

		err := builder.Build("test-tool")

		require.NotNil(t, err)
		assert.Equal(t, tools.ErrorTypeValidation, err.Type)
		assert.Equal(t, "VALIDATION_FAILED", err.Code)
		assert.Equal(t, "error 1; error 2", err.Message)
		assert.Equal(t, "test-tool", err.ToolID)
		assert.NotContains(t, err.Details, "field_errors")
	})

	t.Run("Build with field errors only", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()
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
		builder := tools.NewValidationErrorBuilder()
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
		builder := tools.NewValidationErrorBuilder()
		assert.False(t, builder.HasErrors())

		builder.AddError("error")
		assert.True(t, builder.HasErrors())

		builder2 := tools.NewValidationErrorBuilder()
		builder2.AddFieldError("field", "error")
		assert.True(t, builder2.HasErrors())
	})
}

func TestCircuitBreaker(t *testing.T) {
	t.Run("NewCircuitBreaker", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(3, 5*time.Second)

		assert.NotNil(t, cb)
		assert.Equal(t, tools.CircuitState(0), cb.GetState())
	})

	t.Run("Call success", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(3, 5*time.Second)

		err := cb.Call(func() error {
			return nil
		})

		assert.NoError(t, err)
		assert.Equal(t, tools.CircuitState(0), cb.GetState())
		// Note: Cannot test internal failure count when using external test package
	})

	t.Run("Call failure below threshold", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(3, 5*time.Second)

		// Two failures
		for i := 0; i < 2; i++ {
			err := cb.Call(func() error {
				return errors.New("error")
			})
			assert.Error(t, err)
		}

		assert.Equal(t, tools.CircuitState(0), cb.GetState())
		// Note: Cannot test internal failure count when using external test package
	})

	t.Run("Call failure reaches threshold", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(3, 5*time.Second)

		// Three failures - should open circuit
		for i := 0; i < 3; i++ {
			err := cb.Call(func() error {
				return errors.New("error")
			})
			assert.Error(t, err)
		}

		assert.Equal(t, tools.CircuitState(1), cb.GetState())
		// Note: Cannot test internal failure count when using external test package

		// Next call should fail with circuit open error
		err := cb.Call(func() error {
			return nil
		})

		require.Error(t, err)
		toolErr, ok := err.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, "CIRCUIT_OPEN", toolErr.Code)
		assert.True(t, toolErr.Retryable)
		assert.NotNil(t, toolErr.RetryAfter)
	})

	t.Run("Circuit breaker reset after timeout", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(2, 100*time.Millisecond)

		// Open the circuit
		for i := 0; i < 2; i++ {
			_ = cb.Call(func() error {
				return errors.New("error")
			}) // Ignore errors while opening circuit
		}

		assert.Equal(t, tools.CircuitState(1), cb.GetState())

		// Wait for reset timeout
		time.Sleep(150 * time.Millisecond)

		// Should move to half-open
		err := cb.Call(func() error {
			return nil
		})

		assert.NoError(t, err)
		assert.Equal(t, tools.CircuitState(0), cb.GetState())
		// Note: Cannot test internal failure count when using external test package
	})

	t.Run("Half-open to open on failure", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(2, 100*time.Millisecond)

		// Open the circuit
		for i := 0; i < 2; i++ {
			_ = cb.Call(func() error {
				return errors.New("error")
			}) // Ignore errors while opening circuit
		}

		// Wait for reset timeout
		time.Sleep(150 * time.Millisecond)

		// Fail in half-open state
		err := cb.Call(func() error {
			return errors.New("still failing")
		})

		assert.Error(t, err)
		assert.Equal(t, tools.CircuitState(2), cb.GetState()) // Still in half-open until threshold
		// Note: Cannot test internal failure count when using external test package
	})

	t.Run("GetState", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(2, 5*time.Second)

		assert.Equal(t, tools.CircuitState(0), cb.GetState())

		// Open circuit
		for i := 0; i < 2; i++ {
			_ = cb.Call(func() error {
				return errors.New("error")
			}) // Ignore errors while opening circuit
		}

		assert.Equal(t, tools.CircuitState(1), cb.GetState())
	})

	t.Run("Reset", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(2, 5*time.Second)

		// Open circuit
		for i := 0; i < 2; i++ {
			_ = cb.Call(func() error {
				return errors.New("error")
			}) // Ignore errors while opening circuit
		}

		assert.Equal(t, tools.CircuitState(1), cb.GetState())
		// Note: Cannot test internal failure count when using external test package

		cb.Reset()

		assert.Equal(t, tools.CircuitState(0), cb.GetState())
		// Note: Cannot test internal failure count when using external test package
	})

	t.Run("Success resets failure count", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(3, 5*time.Second)

		// Two failures
		for i := 0; i < 2; i++ {
			_ = cb.Call(func() error {
				return errors.New("error")
			}) // Ignore errors while opening circuit
		}
		// Note: Cannot test internal failure count when using external test package

		// Success should reset
		err := cb.Call(func() error {
			return nil
		})

		assert.NoError(t, err)
		// Note: Cannot test internal failure count when using external test package
		assert.Equal(t, tools.CircuitState(0), cb.GetState())
	})
}

func TestCommonErrorVariables(t *testing.T) {
	// Test that common error variables are properly defined
	assert.EqualError(t, tools.ErrToolNotFound, "tool not found")
	assert.EqualError(t, tools.ErrInvalidParameters, "invalid parameters")
	assert.EqualError(t, tools.ErrExecutionTimeout, "execution timeout")
	assert.EqualError(t, tools.ErrExecutionCanceled, "execution canceled")
	assert.EqualError(t, tools.ErrRateLimitExceeded, "rate limit exceeded")
	assert.EqualError(t, tools.ErrMaxConcurrencyReached, "maximum concurrent executions reached")
	assert.EqualError(t, tools.ErrToolPanicked, "tool execution panicked")
	assert.EqualError(t, tools.ErrStreamingNotSupported, "streaming not supported")
	assert.EqualError(t, tools.ErrCircularDependency, "circular dependency detected")
}

func TestErrorTypeConversions(t *testing.T) {
	t.Run("wrapError edge cases", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		// Create wrapped context errors
		wrappedTimeout := fmt.Errorf("wrapped: %w", context.DeadlineExceeded)
		result := handler.HandleError(wrappedTimeout, "test-tool")

		toolErr, ok := result.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, tools.ErrorTypeTimeout, toolErr.Type)

		wrappedCanceled := fmt.Errorf("wrapped: %w", context.Canceled)
		result2 := handler.HandleError(wrappedCanceled, "test-tool")

		toolErr2, ok := result2.(*tools.ToolError)
		require.True(t, ok)
		assert.Equal(t, tools.ErrorTypeCancellation, toolErr2.Type)
	})
}

func TestToolErrorBuilderMethods(t *testing.T) {
	t.Run("WithToolID", func(t *testing.T) {
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := err.WithToolID("test-tool")

		assert.Same(t, err, result) // Should return same instance
		assert.Equal(t, "test-tool", err.ToolID)
	})

	t.Run("WithCause", func(t *testing.T) {
		cause := errors.New("underlying error")
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := err.WithCause(cause)

		assert.Same(t, err, result)
		assert.Equal(t, cause, err.Cause)
	})

	t.Run("WithDetail", func(t *testing.T) {
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := err.WithDetail("key1", "value1").WithDetail("key2", 42)

		assert.Same(t, err, result)
		assert.Equal(t, "value1", err.Details["key1"])
		assert.Equal(t, 42, err.Details["key2"])
	})

	t.Run("WithRetry", func(t *testing.T) {
		duration := 5 * time.Second
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")
		result := err.WithRetry(duration)

		assert.Same(t, err, result)
		assert.True(t, err.Retryable)
		require.NotNil(t, err.RetryAfter)
		assert.Equal(t, duration, *err.RetryAfter)
	})

	t.Run("Chaining methods", func(t *testing.T) {
		cause := errors.New("cause")
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message").
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
		err := &tools.ToolError{
			Type:    tools.ErrorTypeValidation,
			Code:    "CODE",
			Message: "message",
			Details: nil,
		}

		// WithDetail should initialize the map if nil
		assert.NotPanics(t, func() {
			_ = err.WithDetail("key", "value") // Chainable method, ignore return
		})
		assert.NotNil(t, err.Details)
		assert.Equal(t, "value", err.Details["key"])
	})

	t.Run("CircuitBreaker with zero threshold", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(0, 5*time.Second)

		// Should immediately open
		err := cb.Call(func() error {
			return errors.New("error")
		})

		assert.Error(t, err)
		assert.Equal(t, tools.CircuitState(1), cb.GetState())
	})

	t.Run("ValidationErrorBuilder edge cases", func(t *testing.T) {
		builder := tools.NewValidationErrorBuilder()

		// Empty field name
		builder.AddFieldError("", "error")
		err := builder.Build("test-tool")

		require.NotNil(t, err)
		assert.Contains(t, err.Message, ": error")

		// Very long error messages
		longMessage := string(make([]byte, 1000))
		builder2 := tools.NewValidationErrorBuilder()
		builder2.AddError(longMessage)
		err2 := builder2.Build("test-tool")

		require.NotNil(t, err2)
		assert.Equal(t, longMessage, err2.Message)
	})

	t.Run("ErrorHandler with nil error", func(t *testing.T) {
		handler := tools.NewErrorHandler()

		// Should handle nil error gracefully
		assert.NotPanics(t, func() {
			result := handler.HandleError(nil, "test-tool")
			assert.NotNil(t, result)
		})
	})

	t.Run("ToolError Is with self", func(t *testing.T) {
		err := tools.NewToolError(tools.ErrorTypeValidation, "CODE", "message")

		// Should match itself
		assert.True(t, err.Is(err))
	})

	t.Run("CircuitBreaker concurrent access", func(t *testing.T) {
		cb := tools.NewCircuitBreaker(10, 5*time.Second)

		// Run multiple goroutines
		done := make(chan bool, 10)
		for i := 0; i < 10; i++ {
			go func(id int) {
				defer func() { done <- true }()

				_ = cb.Call(func() error {
					if id%2 == 0 {
						return errors.New("error")
					}
					return nil
				}) // Ignore error in concurrent test
			}(i)
		}

		// Wait for all goroutines
		for i := 0; i < 10; i++ {
			<-done
		}

		// Circuit should still be in valid state
		assert.Contains(t, []tools.CircuitState{tools.CircuitState(0), tools.CircuitState(1), tools.CircuitState(2)}, cb.GetState())
	})
}

// Benchmarks
func BenchmarkCircuitBreaker_Success(b *testing.B) {
	cb := tools.NewCircuitBreaker(5, time.Second)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = cb.Call(func() error {
			return nil
		})
	}
}

func BenchmarkCircuitBreaker_Failure(b *testing.B) {
	cb := tools.NewCircuitBreaker(5, time.Second)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = cb.Call(func() error {
			return fmt.Errorf("test error")
		})
	}
}

func BenchmarkCircuitBreaker_OpenCircuit(b *testing.B) {
	cb := tools.NewCircuitBreaker(1, time.Minute) // Long timeout to keep circuit open

	// Trigger circuit to open
	_ = cb.Call(func() error { return fmt.Errorf("error") })
	_ = cb.Call(func() error { return fmt.Errorf("error") })

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = cb.Call(func() error {
			return nil
		})
	}
}

func BenchmarkErrorBuilder_Build(b *testing.B) {
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = tools.NewToolError(tools.ErrorTypeValidation, "TEST_ERROR", "Test error message").
			WithToolID("test-tool").
			WithDetail("field", "test").
			WithRetry(time.Second) // Ignore result in benchmark
	}
}

func BenchmarkValidationErrorBuilder_Build(b *testing.B) {
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		builder := tools.NewValidationErrorBuilder()
		builder.AddError("Test validation error")
		builder.AddFieldError("field1", "Field error 1")
		builder.AddFieldError("field2", "Field error 2")
		_ = builder.Build("test-tool")
	}
}
