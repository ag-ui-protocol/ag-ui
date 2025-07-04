package tools

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockRateLimiter is a test rate limiter
type mockRateLimiter struct {
	allowFunc func(toolID string) bool
	waitFunc  func(ctx context.Context, toolID string) error
}

func (m *mockRateLimiter) Allow(toolID string) bool {
	if m.allowFunc != nil {
		return m.allowFunc(toolID)
	}
	return true
}

func (m *mockRateLimiter) Wait(ctx context.Context, toolID string) error {
	if m.waitFunc != nil {
		return m.waitFunc(ctx, toolID)
	}
	return nil
}

// mockToolExecutor for testing
type mockToolExecutor struct {
	executeFunc func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error)
}

func (m *mockToolExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	if m.executeFunc != nil {
		return m.executeFunc(ctx, params)
	}
	return &ToolExecutionResult{Success: true}, nil
}

// testTool creates a test tool
func testTool() *Tool {
	return &Tool{
		ID:          "test-tool",
		Name:        "test",
		Description: "Test tool",
		Version:     "1.0.0",
		Schema: &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"input": {
					Type:        "string",
					Description: "Test input",
				},
			},
			Required: []string{"input"},
		},
		Executor: &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				return &ToolExecutionResult{
					Success: true,
					Data:    params["input"],
				}, nil
			},
		},
		Capabilities: &ToolCapabilities{
			Timeout: 5 * time.Second,
		},
	}
}

func TestExecutionEngine_Creation(t *testing.T) {
	registry := NewRegistry()
	
	t.Run("default configuration", func(t *testing.T) {
		engine := NewExecutionEngine(registry)
		assert.NotNil(t, engine)
		assert.Equal(t, 100, engine.maxConcurrent)
		assert.Equal(t, 30*time.Second, engine.defaultTimeout)
	})

	t.Run("with options", func(t *testing.T) {
		engine := NewExecutionEngine(registry,
			WithMaxConcurrent(50),
			WithDefaultTimeout(10*time.Second),
			WithRateLimiter(&mockRateLimiter{}),
		)
		assert.NotNil(t, engine)
		assert.Equal(t, 50, engine.maxConcurrent)
		assert.Equal(t, 10*time.Second, engine.defaultTimeout)
		assert.NotNil(t, engine.rateLimiter)
	})
}

func TestExecutionEngine_Execute(t *testing.T) {
	t.Run("successful execution", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test value"}

		result, err := engine.Execute(context.Background(), "test-tool", params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, "test value", result.Data)
	})

	t.Run("tool not found", func(t *testing.T) {
		registry := NewRegistry()
		engine := NewExecutionEngine(registry)

		result, err := engine.Execute(context.Background(), "non-existent", nil)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "not found")
		assert.Nil(t, result)
	})

	t.Run("parameter validation failure", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{} // Missing required "input"

		result, err := engine.Execute(context.Background(), "test-tool", params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "validation failed")
		assert.Nil(t, result)
	})

	t.Run("execution error", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				return nil, errors.New("execution failed")
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		result, err := engine.Execute(context.Background(), "test-tool", params)
		require.NoError(t, err) // Execute wraps errors in result
		assert.False(t, result.Success)
		assert.Equal(t, "execution failed", result.Error)
	})

	t.Run("execution timeout", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			},
		}
		tool.Capabilities.Timeout = 100 * time.Millisecond
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		start := time.Now()
		result, err := engine.Execute(context.Background(), "test-tool", params)
		duration := time.Since(start)

		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "context deadline exceeded")
		assert.Less(t, duration, 200*time.Millisecond)
	})

	t.Run("execution panic recovery", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				panic("test panic")
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		result, err := engine.Execute(context.Background(), "test-tool", params)
		require.NoError(t, err)
		assert.False(t, result.Success)
		assert.Contains(t, result.Error, "tool execution panicked")
	})

	t.Run("rate limiting", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		rateLimiter := &mockRateLimiter{
			waitFunc: func(ctx context.Context, toolID string) error {
				return errors.New("rate limit exceeded")
			},
		}

		engine := NewExecutionEngine(registry, WithRateLimiter(rateLimiter))
		params := map[string]interface{}{"input": "test"}

		result, err := engine.Execute(context.Background(), "test-tool", params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "rate limit exceeded")
		assert.Nil(t, result)
	})

	t.Run("execution hooks", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		var beforeCalled, afterCalled bool

		engine := NewExecutionEngine(registry)
		engine.AddBeforeExecuteHook(func(ctx context.Context, toolID string, params map[string]interface{}) error {
			beforeCalled = true
			assert.Equal(t, "test-tool", toolID)
			return nil
		})
		engine.AddAfterExecuteHook(func(ctx context.Context, toolID string, params map[string]interface{}) error {
			afterCalled = true
			assert.Equal(t, "test-tool", toolID)
			return nil
		})

		params := map[string]interface{}{"input": "test"}
		result, err := engine.Execute(context.Background(), "test-tool", params)

		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.True(t, beforeCalled)
		assert.True(t, afterCalled)
	})

	t.Run("before hook error", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		engine.AddBeforeExecuteHook(func(ctx context.Context, toolID string, params map[string]interface{}) error {
			return errors.New("hook failed")
		})

		params := map[string]interface{}{"input": "test"}
		result, err := engine.Execute(context.Background(), "test-tool", params)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "hook failed")
		assert.Nil(t, result)
	})
}

func TestExecutionEngine_ExecuteStream(t *testing.T) {
	t.Run("successful streaming", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		streamingExecutor := &mockStreamingExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				return &ToolExecutionResult{Success: true, Data: "result"}, nil
			},
			executeStreamFunc: func(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
				ch := make(chan *ToolStreamChunk, 3)
				ch <- &ToolStreamChunk{Type: "data", Data: "chunk1", Index: 0}
				ch <- &ToolStreamChunk{Type: "data", Data: "chunk2", Index: 1}
				ch <- &ToolStreamChunk{Type: "complete", Index: 2}
				close(ch)
				return ch, nil
			},
		}
		tool.Executor = streamingExecutor
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		stream, err := engine.ExecuteStream(context.Background(), "test-tool", params)
		require.NoError(t, err)
		require.NotNil(t, stream)

		// Collect chunks
		var chunks []*ToolStreamChunk
		for chunk := range stream {
			chunks = append(chunks, chunk)
		}

		require.Len(t, chunks, 3)
		assert.Equal(t, "data", chunks[0].Type)
		assert.Equal(t, "chunk1", chunks[0].Data)
		assert.Equal(t, "complete", chunks[2].Type)
	})

	t.Run("non-streaming tool", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool() // Regular executor, not streaming
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		stream, err := engine.ExecuteStream(context.Background(), "test-tool", params)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "does not support streaming")
		assert.Nil(t, stream)
	})

	t.Run("streaming with error", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		streamingExecutor := &mockStreamingExecutor{
			executeStreamFunc: func(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
				ch := make(chan *ToolStreamChunk, 2)
				ch <- &ToolStreamChunk{Type: "data", Data: "chunk1", Index: 0}
				ch <- &ToolStreamChunk{Type: "error", Data: "stream error", Index: 1}
				close(ch)
				return ch, nil
			},
		}
		tool.Executor = streamingExecutor
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		stream, err := engine.ExecuteStream(context.Background(), "test-tool", params)
		require.NoError(t, err)

		// Collect chunks
		var chunks []*ToolStreamChunk
		for chunk := range stream {
			chunks = append(chunks, chunk)
		}

		require.Len(t, chunks, 2)
		assert.Equal(t, "error", chunks[1].Type)
		assert.Equal(t, "stream error", chunks[1].Data)
	})

	t.Run("streaming cancellation", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		streamingExecutor := &mockStreamingExecutor{
			executeStreamFunc: func(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
				ch := make(chan *ToolStreamChunk)
				go func() {
					defer close(ch)
					for i := 0; i < 10; i++ {
						select {
						case <-ctx.Done():
							return
						case ch <- &ToolStreamChunk{Type: "data", Data: i, Index: i}:
							time.Sleep(10 * time.Millisecond)
						}
					}
				}()
				return ch, nil
			},
		}
		tool.Executor = streamingExecutor
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		ctx, cancel := context.WithCancel(context.Background())
		stream, err := engine.ExecuteStream(ctx, "test-tool", params)
		require.NoError(t, err)

		// Read a few chunks then cancel
		count := 0
		for _ = range stream {
			count++
			if count == 3 {
				cancel()
			}
			if count > 5 {
				t.Fatal("Stream should have been cancelled")
			}
		}

		assert.LessOrEqual(t, count, 5)
	})
}

func TestExecutionEngine_Concurrency(t *testing.T) {
	t.Run("concurrent execution limit", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var activeCount int32
		var maxActive int32
		
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				current := atomic.AddInt32(&activeCount, 1)
				if current > atomic.LoadInt32(&maxActive) {
					atomic.StoreInt32(&maxActive, current)
				}
				
				time.Sleep(50 * time.Millisecond)
				atomic.AddInt32(&activeCount, -1)
				
				return &ToolExecutionResult{Success: true}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(5))
		params := map[string]interface{}{"input": "test"}

		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := engine.Execute(context.Background(), "test-tool", params)
				assert.NoError(t, err)
			}()
		}

		wg.Wait()
		assert.LessOrEqual(t, int(maxActive), 5, "Max concurrent executions should not exceed limit")
	})

	t.Run("GetActiveExecutions", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		startCh := make(chan struct{})
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				<-startCh
				return &ToolExecutionResult{Success: true}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		// Start execution
		go func() {
			engine.Execute(context.Background(), "test-tool", params)
		}()

		// Wait for execution to start
		time.Sleep(50 * time.Millisecond)
		assert.Equal(t, 1, engine.GetActiveExecutions())

		// Complete execution
		close(startCh)
		time.Sleep(50 * time.Millisecond)
		assert.Equal(t, 0, engine.GetActiveExecutions())
	})

	t.Run("IsExecuting", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		startCh := make(chan struct{})
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				<-startCh
				return &ToolExecutionResult{Success: true}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		assert.False(t, engine.IsExecuting("test-tool"))

		// Start execution
		go func() {
			engine.Execute(context.Background(), "test-tool", params)
		}()

		// Wait for execution to start
		time.Sleep(50 * time.Millisecond)
		assert.True(t, engine.IsExecuting("test-tool"))

		// Complete execution
		close(startCh)
		time.Sleep(50 * time.Millisecond)
		assert.False(t, engine.IsExecuting("test-tool"))
	})

	t.Run("CancelAll", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var cancelled int32
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				<-ctx.Done()
				atomic.AddInt32(&cancelled, 1)
				return nil, ctx.Err()
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry)
		params := map[string]interface{}{"input": "test"}

		// Start multiple executions
		var wg sync.WaitGroup
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				engine.Execute(context.Background(), "test-tool", params)
			}()
		}

		// Wait for executions to start
		time.Sleep(50 * time.Millisecond)

		// Cancel all
		engine.CancelAll()

		wg.Wait()
		assert.Equal(t, int32(5), atomic.LoadInt32(&cancelled))
	})
}

func TestExecutionEngine_Metrics(t *testing.T) {
	registry := NewRegistry()
	tool1 := testTool()
	tool1.ID = "tool1"
	tool1.Name = "tool1"
	tool2 := testTool()
	tool2.ID = "tool2"
	tool2.Name = "tool2"
	tool2.Executor = &mockToolExecutor{
		executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
			return &ToolExecutionResult{
				Success: false,
				Error:   "tool2 always fails",
			}, nil
		},
	}
	
	require.NoError(t, registry.Register(tool1))
	require.NoError(t, registry.Register(tool2))

	engine := NewExecutionEngine(registry)
	params := map[string]interface{}{"input": "test"}

	// Execute tool1 successfully 3 times
	for i := 0; i < 3; i++ {
		result, err := engine.Execute(context.Background(), "tool1", params)
		require.NoError(t, err)
		assert.True(t, result.Success)
	}

	// Execute tool2 with failures 2 times
	for i := 0; i < 2; i++ {
		result, err := engine.Execute(context.Background(), "tool2", params)
		require.NoError(t, err)
		assert.False(t, result.Success)
	}

	// Check metrics
	metrics := engine.GetMetrics()
	assert.Equal(t, int64(5), metrics.totalExecutions)
	assert.Equal(t, int64(3), metrics.successCount)
	assert.Equal(t, int64(2), metrics.errorCount)

	// Check tool-specific metrics
	tool1Metrics := metrics.toolMetrics["tool1"]
	assert.NotNil(t, tool1Metrics)
	assert.Equal(t, int64(3), tool1Metrics.Executions)
	assert.Equal(t, int64(3), tool1Metrics.Successes)
	assert.Equal(t, int64(0), tool1Metrics.Errors)

	tool2Metrics := metrics.toolMetrics["tool2"]
	assert.NotNil(t, tool2Metrics)
	assert.Equal(t, int64(2), tool2Metrics.Executions)
	assert.Equal(t, int64(0), tool2Metrics.Successes)
	assert.Equal(t, int64(2), tool2Metrics.Errors)
}

// mockStreamingExecutor implements StreamingToolExecutor
type mockStreamingExecutor struct {
	executeFunc       func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error)
	executeStreamFunc func(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error)
}

func (m *mockStreamingExecutor) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
	if m.executeFunc != nil {
		return m.executeFunc(ctx, params)
	}
	return &ToolExecutionResult{Success: true}, nil
}

func (m *mockStreamingExecutor) ExecuteStream(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
	if m.executeStreamFunc != nil {
		return m.executeStreamFunc(ctx, params)
	}
	ch := make(chan *ToolStreamChunk)
	close(ch)
	return ch, nil
}

// Benchmarks
func BenchmarkExecutionEngine_Execute(b *testing.B) {
	registry := NewRegistry()
	tool := testTool()
	require.NoError(b, registry.Register(tool))

	engine := NewExecutionEngine(registry)
	params := map[string]interface{}{"input": "test"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := engine.Execute(context.Background(), "test-tool", params)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkExecutionEngine_ConcurrentExecute(b *testing.B) {
	registry := NewRegistry()
	tool := testTool()
	require.NoError(b, registry.Register(tool))

	engine := NewExecutionEngine(registry)
	params := map[string]interface{}{"input": "test"}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, err := engine.Execute(context.Background(), "test-tool", params)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

// Comprehensive Concurrency Tests - addressing PR review feedback
func TestExecutionEngine_ConcurrentExecutionLoad(t *testing.T) {
	t.Run("high concurrency load test", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var executionCount int64
		var maxConcurrent int64
		var currentConcurrent int64
		
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				current := atomic.AddInt64(&currentConcurrent, 1)
				for {
					max := atomic.LoadInt64(&maxConcurrent)
					if current <= max || atomic.CompareAndSwapInt64(&maxConcurrent, max, current) {
						break
					}
				}
				
				// Simulate some work
				time.Sleep(10 * time.Millisecond)
				
				atomic.AddInt64(&executionCount, 1)
				atomic.AddInt64(&currentConcurrent, -1)
				
				return &ToolExecutionResult{
					Success: true,
					Data:    fmt.Sprintf("execution-%d", atomic.LoadInt64(&executionCount)),
				}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(50))
		params := map[string]interface{}{"input": "test"}

		// Execute 200 concurrent requests
		var wg sync.WaitGroup
		results := make(chan *ToolExecutionResult, 200)
		errors := make(chan error, 200)
		
		for i := 0; i < 200; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				if err != nil {
					errors <- err
					return
				}
				results <- result
			}(i)
		}

		wg.Wait()
		close(results)
		close(errors)

		// Verify results
		resultCount := 0
		for result := range results {
			assert.True(t, result.Success)
			assert.NotNil(t, result.Data)
			resultCount++
		}
		
		errorCount := 0
		for err := range errors {
			t.Errorf("Unexpected error: %v", err)
			errorCount++
		}
		
		assert.Equal(t, 200, resultCount, "All executions should complete")
		assert.Equal(t, 0, errorCount, "No errors should occur")
		assert.Equal(t, int64(200), atomic.LoadInt64(&executionCount), "Execution count should match")
		assert.LessOrEqual(t, int(atomic.LoadInt64(&maxConcurrent)), 50, "Max concurrent should not exceed limit")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})

	t.Run("concurrent execution with mixed success/failure", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var executionCount int64
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				count := atomic.AddInt64(&executionCount, 1)
				time.Sleep(5 * time.Millisecond)
				
				// Fail every 5th execution
				if count%5 == 0 {
					return &ToolExecutionResult{
						Success: false,
						Error:   fmt.Sprintf("simulated failure for execution %d", count),
					}, nil
				}
				
				return &ToolExecutionResult{
					Success: true,
					Data:    fmt.Sprintf("success-%d", count),
				}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(20))
		params := map[string]interface{}{"input": "test"}

		// Execute 100 concurrent requests
		var wg sync.WaitGroup
		var successCount, failureCount int64
		
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				require.NoError(t, err)
				
				if result.Success {
					atomic.AddInt64(&successCount, 1)
				} else {
					atomic.AddInt64(&failureCount, 1)
				}
			}()
		}

		wg.Wait()
		
		assert.Equal(t, int64(100), atomic.LoadInt64(&executionCount), "All executions should complete")
		assert.Equal(t, int64(80), atomic.LoadInt64(&successCount), "80% should succeed")
		assert.Equal(t, int64(20), atomic.LoadInt64(&failureCount), "20% should fail")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})

	t.Run("concurrent execution with timeouts", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var timeoutCount, successCount int64
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				// Randomly sleep for 0-150ms to trigger some timeouts
				sleepTime := time.Duration(rand.Intn(150)) * time.Millisecond
				select {
				case <-time.After(sleepTime):
					atomic.AddInt64(&successCount, 1)
					return &ToolExecutionResult{Success: true, Data: "completed"}, nil
				case <-ctx.Done():
					atomic.AddInt64(&timeoutCount, 1)
					return nil, ctx.Err()
				}
			},
		}
		tool.Capabilities.Timeout = 100 * time.Millisecond
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(30))
		params := map[string]interface{}{"input": "test"}

		// Execute 50 concurrent requests
		var wg sync.WaitGroup
		var completedCount int64
		
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				require.NoError(t, err)
				atomic.AddInt64(&completedCount, 1)
				
				if !result.Success {
					assert.Contains(t, result.Error, "deadline exceeded")
				}
			}()
		}

		wg.Wait()
		
		assert.Equal(t, int64(50), atomic.LoadInt64(&completedCount), "All executions should complete")
		totalProcessed := atomic.LoadInt64(&successCount) + atomic.LoadInt64(&timeoutCount)
		assert.Equal(t, int64(50), totalProcessed, "All executions should be processed")
		assert.Greater(t, atomic.LoadInt64(&timeoutCount), int64(0), "Some executions should timeout")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})

	t.Run("concurrent execution with cancellation", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var cancelledCount, completedCount, startedCount int64
		var allStarted = make(chan struct{})
		
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				started := atomic.AddInt64(&startedCount, 1)
				if started == 30 {
					close(allStarted)
				}
				
				select {
				case <-time.After(200 * time.Millisecond):
					atomic.AddInt64(&completedCount, 1)
					return &ToolExecutionResult{Success: true, Data: "completed"}, nil
				case <-ctx.Done():
					atomic.AddInt64(&cancelledCount, 1)
					return nil, ctx.Err()
				}
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(30))
		params := map[string]interface{}{"input": "test"}

		ctx, cancel := context.WithCancel(context.Background())
		
		// Start 30 concurrent executions
		var wg sync.WaitGroup
		for i := 0; i < 30; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := engine.Execute(ctx, "test-tool", params)
				// Error is expected due to cancellation
				if err != nil {
					assert.Contains(t, err.Error(), "context canceled")
				}
			}()
		}

		// Wait for all executions to start, then cancel
		<-allStarted
		time.Sleep(10 * time.Millisecond) // Small delay to ensure they're running
		cancel()

		wg.Wait()
		
		assert.Equal(t, int64(30), atomic.LoadInt64(&startedCount), "All executions should start")
		totalProcessed := atomic.LoadInt64(&completedCount) + atomic.LoadInt64(&cancelledCount)
		assert.Equal(t, int64(30), totalProcessed, "All executions should be processed")
		assert.Greater(t, atomic.LoadInt64(&cancelledCount), int64(0), "Some executions should be cancelled")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})
}

func TestExecutionEngine_ResourceContention(t *testing.T) {
	t.Run("memory usage under concurrent load", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		// Create executor that uses memory
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				// Allocate some memory to simulate real work
				data := make([]byte, 1024*1024) // 1MB
				for i := range data {
					data[i] = byte(i % 256)
				}
				
				time.Sleep(10 * time.Millisecond)
				
				return &ToolExecutionResult{
					Success: true,
					Data:    fmt.Sprintf("processed %d bytes", len(data)),
				}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(20))
		params := map[string]interface{}{"input": "test"}

		// Get initial memory stats
		var m1 runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&m1)

		// Execute 100 concurrent requests
		var wg sync.WaitGroup
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				require.NoError(t, err)
				assert.True(t, result.Success)
			}()
		}

		wg.Wait()
		
		// Get final memory stats
		var m2 runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&m2)

		// Memory should be released after executions complete  
		// Use signed arithmetic to handle the case where memory decreases
		memoryGrowth := int64(m2.Alloc) - int64(m1.Alloc)
		if memoryGrowth > 0 {
			assert.Less(t, memoryGrowth, int64(50*1024*1024), "Memory growth should be reasonable (<50MB)")
		}
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})

	t.Run("goroutine leak detection", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(15))
		params := map[string]interface{}{"input": "test"}

		// Get initial goroutine count
		initialGoroutines := runtime.NumGoroutine()

		// Execute many concurrent requests
		var wg sync.WaitGroup
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				require.NoError(t, err)
				assert.True(t, result.Success)
			}()
		}

		wg.Wait()
		
		// Allow some time for cleanup
		time.Sleep(100 * time.Millisecond)
		runtime.GC()
		
		// Check for goroutine leaks
		finalGoroutines := runtime.NumGoroutine()
		goroutineGrowth := finalGoroutines - initialGoroutines
		assert.LessOrEqual(t, goroutineGrowth, 5, "Goroutine growth should be minimal")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})
}

func TestExecutionEngine_RateLimitingConcurrency(t *testing.T) {
	t.Run("rate limiting under concurrent load", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		require.NoError(t, registry.Register(tool))

		// Create a rate limiter that allows 10 requests per second
		var allowedCount int64
		var blockedCount int64
		
		rateLimiter := &mockRateLimiter{
			waitFunc: func(ctx context.Context, toolID string) error {
				if atomic.LoadInt64(&allowedCount) < 10 {
					atomic.AddInt64(&allowedCount, 1)
					return nil
				}
				atomic.AddInt64(&blockedCount, 1)
				return errors.New("rate limit exceeded")
			},
		}

		engine := NewExecutionEngine(registry, 
			WithMaxConcurrent(50),
			WithRateLimiter(rateLimiter),
		)
		params := map[string]interface{}{"input": "test"}

		// Execute 25 concurrent requests
		var wg sync.WaitGroup
		var successCount, errorCount int64
		
		for i := 0; i < 25; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := engine.Execute(context.Background(), "test-tool", params)
				if err != nil {
					atomic.AddInt64(&errorCount, 1)
					assert.Contains(t, err.Error(), "rate limit exceeded")
				} else {
					atomic.AddInt64(&successCount, 1)
					assert.True(t, result.Success)
				}
			}()
		}

		wg.Wait()
		
		assert.Equal(t, int64(10), atomic.LoadInt64(&allowedCount), "Should allow exactly 10 requests")
		assert.Equal(t, int64(15), atomic.LoadInt64(&blockedCount), "Should block 15 requests")
		assert.Equal(t, int64(10), atomic.LoadInt64(&successCount), "Should have 10 successful executions")
		assert.Equal(t, int64(15), atomic.LoadInt64(&errorCount), "Should have 15 rate limit errors")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
	})
}

func TestExecutionEngine_StressTest(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping stress test in short mode")
	}
	
	t.Run("sustained high load", func(t *testing.T) {
		registry := NewRegistry()
		tool := testTool()
		
		var totalExecutions int64
		tool.Executor = &mockToolExecutor{
			executeFunc: func(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
				atomic.AddInt64(&totalExecutions, 1)
				// Simulate varying work load
				workTime := time.Duration(rand.Intn(20)) * time.Millisecond
				time.Sleep(workTime)
				
				return &ToolExecutionResult{
					Success: true,
					Data:    fmt.Sprintf("execution-%d", atomic.LoadInt64(&totalExecutions)),
				}, nil
			},
		}
		require.NoError(t, registry.Register(tool))

		engine := NewExecutionEngine(registry, WithMaxConcurrent(100))
		params := map[string]interface{}{"input": "test"}

		// Run for 2 seconds with continuous load
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		
		var wg sync.WaitGroup
		var activeWorkers int64
		
		// Start 500 workers
		for i := 0; i < 500; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				atomic.AddInt64(&activeWorkers, 1)
				defer atomic.AddInt64(&activeWorkers, -1)
				
				for {
					select {
					case <-ctx.Done():
						return
					default:
						result, err := engine.Execute(ctx, "test-tool", params)
						if err != nil {
							if !strings.Contains(err.Error(), "context deadline exceeded") {
								t.Errorf("Unexpected error: %v", err)
							}
							return
						}
						if result != nil && !result.Success {
							t.Errorf("Execution failed: %s", result.Error)
						}
					}
				}
			}()
		}

		wg.Wait()
		
		assert.Greater(t, atomic.LoadInt64(&totalExecutions), int64(50), "Should complete many executions")
		assert.Equal(t, int64(0), atomic.LoadInt64(&activeWorkers), "All workers should complete")
		assert.Equal(t, 0, engine.GetActiveExecutions(), "No active executions should remain")
		
		// Verify metrics are reasonable
		metrics := engine.GetMetrics()
		assert.Greater(t, metrics.totalExecutions, int64(50), "Should have recorded many executions")
		assert.Greater(t, metrics.successCount, int64(40), "Most executions should succeed")
	})
}