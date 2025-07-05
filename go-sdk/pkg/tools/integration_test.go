package tools_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/ag-ui/go-sdk/pkg/tools"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Mock executor for integration testing is defined in tool_test.go

// TestIntegrationFullWorkflow tests a complete tool workflow
func TestIntegrationFullWorkflow(t *testing.T) {
	// Create registry and execution engine
	registry := tools.NewRegistry()
	engine := tools.NewExecutionEngine(registry, tools.WithMaxConcurrent(10))

	// Register built-in tools
	err := tools.RegisterBuiltinTools(registry)
	require.NoError(t, err)

	// Create custom tool
	customTool := &tools.Tool{
		ID:          "custom.calculator",
		Name:        "calculator",
		Description: "Performs basic calculations",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"operation": {
					Type:        "string",
					Description: "The operation to perform",
					Enum:        []interface{}{"add", "subtract", "multiply", "divide"},
				},
				"a": {
					Type:        "number",
					Description: "First operand",
				},
				"b": {
					Type:        "number",
					Description: "Second operand",
				},
			},
			Required: []string{"operation", "a", "b"},
		},
		Executor: &calculatorExecutor{},
		Capabilities: &tools.ToolCapabilities{
			Timeout:   1 * time.Second,
			Cacheable: true,
		},
	}

	// Register custom tool
	err = registry.Register(customTool)
	require.NoError(t, err)

	// Test 1: Execute calculation
	t.Run("execute calculation", func(t *testing.T) {
		params := map[string]interface{}{
			"operation": "add",
			"a":         10.5,
			"b":         20.5,
		}

		result, err := engine.Execute(context.Background(), "custom.calculator", params)
		require.NoError(t, err)
		assert.True(t, result.Success)
		assert.Equal(t, 31.0, result.Data)
	})

	// Test 2: Chain multiple tools
	t.Run("chain tools", func(t *testing.T) {
		// First, encode some data
		encodeParams := map[string]interface{}{
			"data": "Secret message",
		}
		encodeResult, err := engine.Execute(context.Background(), "builtin.base64_encode", encodeParams)
		require.NoError(t, err)
		assert.True(t, encodeResult.Success)

		// Then decode it back
		decodeParams := map[string]interface{}{
			"data": encodeResult.Data,
		}
		decodeResult, err := engine.Execute(context.Background(), "builtin.base64_decode", decodeParams)
		require.NoError(t, err)
		assert.True(t, decodeResult.Success)
		assert.Equal(t, "Secret message", decodeResult.Data)
	})

	// Test 3: Concurrent executions
	t.Run("concurrent executions", func(t *testing.T) {
		var wg sync.WaitGroup
		results := make(chan *tools.ToolExecutionResult, 20)

		// Execute 20 tools concurrently
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()

				params := map[string]interface{}{
					"operation": "multiply",
					"a":         float64(index),
					"b":         2.0,
				}

				result, err := engine.Execute(context.Background(), "custom.calculator", params)
				if err == nil {
					results <- result
				}
			}(i)
		}

		wg.Wait()
		close(results)

		// Verify all results
		count := 0
		for result := range results {
			assert.True(t, result.Success)
			count++
		}
		assert.Equal(t, 20, count)
	})

	// Test 4: Test metrics
	t.Run("check metrics", func(t *testing.T) {
		metrics := engine.GetMetrics()
		// Note: metrics fields are not exported, so we can't test them directly
		// This is acceptable as they are implementation details
		// Just verify we can get metrics without error
		assert.NotNil(t, metrics)
	})
}

// TestIntegrationProviderConversion tests AI provider integration
func TestIntegrationProviderConversion(t *testing.T) {
	// Create registry with tools
	registry := tools.NewRegistry()
	err := tools.RegisterBuiltinTools(registry)
	require.NoError(t, err)

	// Create provider registry
	providerRegistry := tools.NewProviderToolRegistry(registry)

	t.Run("OpenAI conversion", func(t *testing.T) {
		openAITools, err := providerRegistry.GetOpenAITools()
		require.NoError(t, err)
		assert.GreaterOrEqual(t, len(openAITools), 8)

		// Verify tool structure
		for _, tool := range openAITools {
			assert.Equal(t, "function", tool.Type)
			assert.NotEmpty(t, tool.Function.Name)
			assert.NotEmpty(t, tool.Function.Description)
			assert.NotNil(t, tool.Function.Parameters)
		}

		// Test tool call conversion
		converter := tools.NewProviderConverter()
		toolCall := &tools.OpenAIToolCall{
			ID:   "call_123",
			Type: "function",
			Function: tools.OpenAIFunctionCall{
				Name:      "json_parse",
				Arguments: `{"json": "{\"key\": \"value\"}"}`,
			},
		}

		name, args, err := converter.ConvertOpenAIToolCall(toolCall)
		require.NoError(t, err)
		assert.Equal(t, "json_parse", name)
		assert.Equal(t, `{"key": "value"}`, args["json"])
	})

	t.Run("Anthropic conversion", func(t *testing.T) {
		anthropicTools, err := providerRegistry.GetAnthropicTools()
		require.NoError(t, err)
		assert.GreaterOrEqual(t, len(anthropicTools), 8)

		// Verify tool structure
		for _, tool := range anthropicTools {
			assert.NotEmpty(t, tool.Name)
			assert.NotEmpty(t, tool.Description)
			assert.NotNil(t, tool.InputSchema)
		}
	})
}

// TestIntegrationStreamingTool tests streaming tool functionality
func TestIntegrationStreamingTool(t *testing.T) {
	registry := tools.NewRegistry()
	engine := tools.NewExecutionEngine(registry)

	// Create a streaming tool
	streamingTool := &tools.Tool{
		ID:          "test.streamer",
		Name:        "streamer",
		Description: "Streams data chunks",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"count": {
					Type:        "integer",
					Description: "Number of chunks to stream",
					Minimum:     &[]float64{1}[0],
					Maximum:     &[]float64{100}[0],
				},
			},
			Required: []string{"count"},
		},
		Executor: &streamingTestExecutor{},
		Capabilities: &tools.ToolCapabilities{
			Streaming: true,
			Timeout:   5 * time.Second,
		},
	}

	err := registry.Register(streamingTool)
	require.NoError(t, err)

	t.Run("stream execution", func(t *testing.T) {
		params := map[string]interface{}{
			"count": 5.0,
		}

		stream, err := engine.ExecuteStream(context.Background(), "test.streamer", params)
		require.NoError(t, err)

		// Collect chunks
		var chunks []*tools.ToolStreamChunk
		for chunk := range stream {
			chunks = append(chunks, chunk)
		}

		// Verify chunks
		assert.Len(t, chunks, 6) // 5 data + 1 complete
		for i := 0; i < 5; i++ {
			assert.Equal(t, "data", chunks[i].Type)
			assert.Equal(t, i, chunks[i].Index)
		}
		assert.Equal(t, "complete", chunks[5].Type)
	})

	t.Run("stream accumulation", func(t *testing.T) {
		params := map[string]interface{}{
			"count": 3.0,
		}

		stream, err := engine.ExecuteStream(context.Background(), "test.streamer", params)
		require.NoError(t, err)

		// Use accumulator
		accumulator := tools.NewStreamAccumulator()
		for chunk := range stream {
			chunkErr := accumulator.AddChunk(chunk)
			require.NoError(t, chunkErr)
		}

		assert.True(t, accumulator.IsComplete())
		assert.False(t, accumulator.HasError())

		result, metadata, err := accumulator.GetResult()
		require.NoError(t, err)
		assert.Equal(t, "chunk 0chunk 1chunk 2", result)
		assert.NotNil(t, metadata)
	})
}

// TestIntegrationErrorHandling tests comprehensive error handling
func TestIntegrationErrorHandling(t *testing.T) {
	registry := tools.NewRegistry()
	engine := tools.NewExecutionEngine(registry)

	// Create error handler
	errorHandler := tools.NewErrorHandler()

	var capturedError *tools.ToolError
	errorHandler.AddListener(func(err *tools.ToolError) {
		capturedError = err
	})

	// Create a tool that fails
	failingTool := &tools.Tool{
		ID:          "test.failing",
		Name:        "failing",
		Description: "Always fails",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type:       "object",
			Properties: map[string]*tools.Property{},
		},
		Executor: &mockExecutor{
			err: tools.NewToolError(tools.ErrorTypeExecution, "FAIL", "Tool always fails"),
		},
	}

	err := registry.Register(failingTool)
	require.NoError(t, err)

	t.Run("error handling", func(t *testing.T) {
		result, err := engine.Execute(context.Background(), "test.failing", map[string]interface{}{})
		require.NoError(t, err)
		assert.False(t, result.Success)

		// Process error through handler
		handledErr := errorHandler.HandleError(err, "test.failing")
		assert.NotNil(t, handledErr)
		assert.NotNil(t, capturedError)
		assert.Equal(t, tools.ErrorTypeExecution, capturedError.Type)
	})

	t.Run("circuit breaker", func(t *testing.T) {
		breaker := tools.NewCircuitBreaker(3, 1*time.Second)

		// Fail 3 times to open circuit
		for i := 0; i < 3; i++ {
			err := breaker.Call(func() error {
				return tools.NewToolError(tools.ErrorTypeExecution, "FAIL", "Operation failed")
			})
			assert.Error(t, err)
		}

		// Circuit should be open
		assert.Equal(t, tools.CircuitOpen, breaker.GetState())

		// Next call should fail immediately
		err := breaker.Call(func() error {
			return nil
		})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "circuit breaker is open")
	})
}

// TestIntegrationValidation tests comprehensive validation
func TestIntegrationValidation(t *testing.T) {
	registry := tools.NewRegistry()

	// Add custom validator
	registry.AddValidator(func(tool *tools.Tool) error {
		// Require all tools to have timeout capability
		if tool.Capabilities == nil || tool.Capabilities.Timeout == 0 {
			return tools.NewToolError(tools.ErrorTypeValidation, "NO_TIMEOUT", "Tool must specify timeout")
		}
		return nil
	})

	t.Run("valid tool passes validation", func(t *testing.T) {
		validTool := &tools.Tool{
			ID:          "test.valid",
			Name:        "valid",
			Description: "Valid tool",
			Version:     "1.0.0",
			Schema: &tools.ToolSchema{
				Type:       "object",
				Properties: map[string]*tools.Property{},
			},
			Executor: &mockExecutor{},
			Capabilities: &tools.ToolCapabilities{
				Timeout: 5 * time.Second,
			},
		}

		err := registry.Register(validTool)
		assert.NoError(t, err)
	})

	t.Run("invalid tool fails validation", func(t *testing.T) {
		invalidTool := &tools.Tool{
			ID:          "test.invalid",
			Name:        "invalid",
			Description: "Invalid tool",
			Version:     "1.0.0",
			Schema: &tools.ToolSchema{
				Type:       "object",
				Properties: map[string]*tools.Property{},
			},
			Executor: &mockExecutor{},
			// No capabilities/timeout
		}

		err := registry.Register(invalidTool)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "Tool must specify timeout")
	})
}

// Helper executors for testing

type calculatorExecutor struct{}

func (e *calculatorExecutor) Execute(ctx context.Context, params map[string]interface{}) (*tools.ToolExecutionResult, error) {
	operation := params["operation"].(string)
	a := params["a"].(float64)
	b := params["b"].(float64)

	var result float64
	switch operation {
	case "add":
		result = a + b
	case "subtract":
		result = a - b
	case "multiply":
		result = a * b
	case "divide":
		if b == 0 {
			return &tools.ToolExecutionResult{
				Success: false,
				Error:   "Division by zero",
			}, nil
		}
		result = a / b
	default:
		return &tools.ToolExecutionResult{
			Success: false,
			Error:   "Unknown operation",
		}, nil
	}

	return &tools.ToolExecutionResult{
		Success: true,
		Data:    result,
	}, nil
}

type streamingTestExecutor struct{}

func (e *streamingTestExecutor) Execute(ctx context.Context, params map[string]interface{}) (*tools.ToolExecutionResult, error) {
	return &tools.ToolExecutionResult{
		Success: true,
		Data:    "Use streaming instead",
	}, nil
}

func (e *streamingTestExecutor) ExecuteStream(ctx context.Context, params map[string]interface{}) (<-chan *tools.ToolStreamChunk, error) {
	count := int(params["count"].(float64))
	ch := make(chan *tools.ToolStreamChunk, count+1)

	go func() {
		defer close(ch)

		for i := 0; i < count; i++ {
			select {
			case ch <- &tools.ToolStreamChunk{
				Type:  "data",
				Data:  "chunk " + string(rune('0'+i)),
				Index: i,
			}:
			case <-ctx.Done():
				return
			}
		}

		ch <- &tools.ToolStreamChunk{
			Type:  "complete",
			Index: count,
		}
	}()

	return ch, nil
}
