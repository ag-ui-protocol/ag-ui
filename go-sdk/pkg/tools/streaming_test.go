package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestStreamingContext tests the StreamingContext functionality
func TestStreamingContext(t *testing.T) {
	t.Run("NewStreamingContext", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		assert.NotNil(t, sc)
		assert.NotNil(t, sc.ctx)
		assert.NotNil(t, sc.chunks)
		assert.Equal(t, 0, sc.index)
		assert.False(t, sc.closed)
	})

	t.Run("Send", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Test sending various data types
		testCases := []interface{}{
			"string data",
			123,
			true,
			map[string]interface{}{"key": "value"},
			[]string{"item1", "item2"},
		}

		for _, data := range testCases {
			err := sc.Send(data)
			assert.NoError(t, err)

			select {
			case chunk := <-sc.Channel():
				assert.Equal(t, "data", chunk.Type)
				assert.Equal(t, data, chunk.Data)
			case <-time.After(time.Second):
				t.Fatal("timeout waiting for chunk")
			}
		}
	})

	t.Run("SendError", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		testErr := errors.New("test error")
		err := sc.SendError(testErr)
		assert.NoError(t, err)

		select {
		case chunk := <-sc.Channel():
			assert.Equal(t, "error", chunk.Type)
			assert.Equal(t, "test error", chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("SendMetadata", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		metadata := map[string]interface{}{
			"progress": 50,
			"status":   "processing",
		}

		err := sc.SendMetadata(metadata)
		assert.NoError(t, err)

		select {
		case chunk := <-sc.Channel():
			assert.Equal(t, "metadata", chunk.Type)
			assert.Equal(t, metadata, chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("Complete", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		err := sc.Complete()
		assert.NoError(t, err)

		select {
		case chunk := <-sc.Channel():
			assert.Equal(t, "complete", chunk.Type)
			assert.Nil(t, chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("Close", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Send some data first
		err := sc.Send("test")
		assert.NoError(t, err)

		// Close the context
		err = sc.Close()
		assert.NoError(t, err)
		assert.True(t, sc.closed)

		// Try to send after close
		err = sc.Send("should fail")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "streaming context is closed")

		// Close again should be safe
		err = sc.Close()
		assert.NoError(t, err)
	})

	t.Run("ContextCancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		sc := NewStreamingContext(ctx)

		// Fill the buffer to block
		for i := 0; i < 100; i++ {
			err := sc.Send(i)
			assert.NoError(t, err)
		}

		// Cancel context
		cancel()

		// Should get context error
		err := sc.Send("should fail")
		assert.Error(t, err)
		assert.Equal(t, context.Canceled, err)
	})

	t.Run("IndexIncrement", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Send multiple chunks and verify index increments
		for i := 0; i < 5; i++ {
			err := sc.Send(i)
			assert.NoError(t, err)

			select {
			case chunk := <-sc.Channel():
				assert.Equal(t, i, chunk.Index)
			case <-time.After(time.Second):
				t.Fatal("timeout waiting for chunk")
			}
		}
	})
}

// TestStreamingToolHelper tests the StreamingToolHelper functionality
func TestStreamingToolHelper(t *testing.T) {
	t.Run("NewStreamingToolHelper", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		assert.NotNil(t, helper)
	})

	t.Run("StreamJSON", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Test data
		data := map[string]interface{}{
			"name":   "test",
			"value":  float64(123), // JSON numbers unmarshal as float64
			"nested": map[string]interface{}{"key": "value"},
		}

		// Stream with small chunk size
		chunkSize := 10
		chunks, err := helper.StreamJSON(ctx, data, chunkSize)
		assert.NoError(t, err)
		assert.NotNil(t, chunks)

		// Collect all chunks
		var result []byte
		var complete bool
		index := 0

		for chunk := range chunks {
			assert.Equal(t, index, chunk.Index)
			index++

			switch chunk.Type {
			case "data":
				result = append(result, []byte(chunk.Data.(string))...)
			case "complete":
				complete = true
			default:
				t.Fatalf("unexpected chunk type: %s", chunk.Type)
			}
		}

		assert.True(t, complete)

		// Verify reassembled JSON
		var reconstructed map[string]interface{}
		err = json.Unmarshal(result, &reconstructed)
		assert.NoError(t, err)
		assert.Equal(t, data, reconstructed)
	})

	t.Run("StreamJSON_InvalidData", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Create data that can't be marshaled
		data := make(chan int)

		chunks, err := helper.StreamJSON(ctx, data, 10)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to marshal JSON")
		assert.Nil(t, chunks)
	})

	t.Run("StreamJSON_InvalidChunkSize", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()
		data := map[string]string{"test": "data"}

		// Test zero chunkSize
		chunks, err := helper.StreamJSON(ctx, data, 0)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "chunkSize must be positive, got 0")
		assert.Nil(t, chunks)

		// Test negative chunkSize
		chunks, err = helper.StreamJSON(ctx, data, -10)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "chunkSize must be positive, got -10")
		assert.Nil(t, chunks)
	})

	t.Run("StreamJSON_ContextCancellation", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx, cancel := context.WithCancel(context.Background())

		// Large data to ensure multiple chunks
		data := strings.Repeat("a", 1000)

		chunks, err := helper.StreamJSON(ctx, data, 10)
		assert.NoError(t, err)

		// Cancel context after first chunk
		var gotChunk bool
		for chunk := range chunks {
			if !gotChunk {
				gotChunk = true
				cancel()
			}
			if chunk.Type == "complete" {
				t.Fatal("should not receive complete chunk after cancellation")
			}
		}

		assert.True(t, gotChunk)
	})

	t.Run("StreamReader", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Test data
		data := "Hello, World! This is a test of streaming."
		reader := strings.NewReader(data)

		// Stream with small chunk size
		chunkSize := 5
		chunks, err := helper.StreamReader(ctx, reader, chunkSize)
		assert.NoError(t, err)
		assert.NotNil(t, chunks)

		// Collect all chunks
		var result []byte
		var complete bool
		index := 0

		for chunk := range chunks {
			assert.Equal(t, index, chunk.Index)
			index++

			switch chunk.Type {
			case "data":
				result = append(result, []byte(chunk.Data.(string))...)
			case "complete":
				complete = true
			case "error":
				t.Fatalf("unexpected error chunk: %v", chunk.Data)
			default:
				t.Fatalf("unexpected chunk type: %s", chunk.Type)
			}
		}

		assert.True(t, complete)
		assert.Equal(t, data, string(result))
	})

	t.Run("StreamReader_InvalidChunkSize", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()
		reader := strings.NewReader("test data")

		// Test zero chunkSize
		chunks, err := helper.StreamReader(ctx, reader, 0)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "chunkSize must be positive, got 0")
		assert.Nil(t, chunks)

		// Test negative chunkSize
		reader = strings.NewReader("test data") // New reader since previous one was consumed
		chunks, err = helper.StreamReader(ctx, reader, -10)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "chunkSize must be positive, got -10")
		assert.Nil(t, chunks)
	})

	t.Run("StreamReader_Error", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Create a reader that errors
		reader := &errorReader{err: errors.New("read error")}

		chunks, err := helper.StreamReader(ctx, reader, 10)
		assert.NoError(t, err)

		var gotError bool
		for chunk := range chunks {
			if chunk.Type == "error" {
				gotError = true
				assert.Equal(t, "read error", chunk.Data)
			}
		}

		assert.True(t, gotError)
	})

	t.Run("StreamReader_ContextCancellation", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx, cancel := context.WithCancel(context.Background())

		// Large data to ensure multiple chunks
		data := strings.Repeat("a", 1000)
		reader := strings.NewReader(data)

		chunks, err := helper.StreamReader(ctx, reader, 10)
		assert.NoError(t, err)

		// Cancel context after first chunk
		var gotChunk bool
		for chunk := range chunks {
			if !gotChunk {
				gotChunk = true
				cancel()
			}
			if chunk.Type == "complete" {
				t.Fatal("should not receive complete chunk after cancellation")
			}
		}

		assert.True(t, gotChunk)
	})
}

// TestStreamAccumulator tests the StreamAccumulator functionality
func TestStreamAccumulator(t *testing.T) {
	t.Run("NewStreamAccumulator", func(t *testing.T) {
		acc := NewStreamAccumulator()
		assert.NotNil(t, acc)
		assert.NotNil(t, acc.chunks)
		assert.NotNil(t, acc.metadata)
		assert.False(t, acc.hasError)
		assert.False(t, acc.complete)
	})

	t.Run("AddChunk_Data", func(t *testing.T) {
		acc := NewStreamAccumulator()

		chunks := []string{"Hello", " ", "World", "!"}
		for i, data := range chunks {
			chunk := &ToolStreamChunk{
				Type:  "data",
				Data:  data,
				Index: i,
			}
			err := acc.AddChunk(chunk)
			assert.NoError(t, err)
		}

		// Complete the stream
		err := acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		result, metadata, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Equal(t, "Hello World!", result)
		assert.Empty(t, metadata)
	})

	t.Run("AddChunk_Metadata", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add metadata chunks
		meta1 := map[string]interface{}{"key1": "value1"}
		meta2 := map[string]interface{}{"key2": "value2", "key1": "updated"}

		err := acc.AddChunk(&ToolStreamChunk{Type: "metadata", Data: meta1})
		assert.NoError(t, err)

		err = acc.AddChunk(&ToolStreamChunk{Type: "metadata", Data: meta2})
		assert.NoError(t, err)

		// Complete the stream
		err = acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		_, metadata, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Equal(t, "updated", metadata["key1"])
		assert.Equal(t, "value2", metadata["key2"])
	})

	t.Run("AddChunk_Error", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add some data
		err := acc.AddChunk(&ToolStreamChunk{Type: "data", Data: "test"})
		assert.NoError(t, err)

		// Add error
		err = acc.AddChunk(&ToolStreamChunk{Type: "error", Data: "something went wrong"})
		assert.NoError(t, err)

		assert.True(t, acc.HasError())

		// Complete the stream
		err = acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		_, _, err = acc.GetResult()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "stream error: something went wrong")
	})

	t.Run("AddChunk_AfterComplete", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Complete the stream
		err := acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)
		assert.True(t, acc.IsComplete())

		// Try to add chunk after complete
		err = acc.AddChunk(&ToolStreamChunk{Type: "data", Data: "test"})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "cannot add chunk after stream is complete")
	})

	t.Run("AddChunk_InvalidDataType", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add chunk with non-string data
		err := acc.AddChunk(&ToolStreamChunk{Type: "data", Data: 123})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "data chunk must contain string data")
	})

	t.Run("GetResult_NotComplete", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add some data but don't complete
		err := acc.AddChunk(&ToolStreamChunk{Type: "data", Data: "test"})
		assert.NoError(t, err)

		_, _, err = acc.GetResult()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "stream is not complete")
	})

	t.Run("ConcurrentAccess", func(t *testing.T) {
		acc := NewStreamAccumulator()

		var wg sync.WaitGroup

		// Concurrent writes
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				chunk := &ToolStreamChunk{
					Type:  "data",
					Data:  string(rune('A' + index)),
					Index: index,
				}
				err := acc.AddChunk(chunk)
				assert.NoError(t, err)
			}(i)
		}

		// Concurrent reads
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				acc.IsComplete()
				acc.HasError()
			}()
		}

		wg.Wait()

		// Complete and verify
		err := acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		result, _, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Len(t, result, 10)
	})
}

// TestStreamingParameterParser tests the StreamingParameterParser functionality
func TestStreamingParameterParser(t *testing.T) {
	t.Run("NewStreamingParameterParser", func(t *testing.T) {
		schema := &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"name": {Type: "string"},
			},
		}

		parser := NewStreamingParameterParser(schema)
		assert.NotNil(t, parser)
		assert.NotNil(t, parser.validator)
		assert.Empty(t, parser.buffer)
		assert.False(t, parser.complete)
	})

	t.Run("AddChunk_and_TryParse", func(t *testing.T) {
		schema := &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"name": {Type: "string"},
				"age":  {Type: "integer"},
			},
			Required: []string{"name"},
		}

		parser := NewStreamingParameterParser(schema)

		// Add chunks to form valid JSON
		err := parser.AddChunk(`{"na`)
		assert.NoError(t, err)
		err = parser.AddChunk(`me": "John"`)
		assert.NoError(t, err)
		err = parser.AddChunk(`, "age": 30}`)
		assert.NoError(t, err)

		// Try to parse
		params, err := parser.TryParse()
		assert.NoError(t, err)
		assert.Equal(t, "John", params["name"])
		assert.Equal(t, float64(30), params["age"]) // JSON numbers are float64
		assert.True(t, parser.IsComplete())
	})

	t.Run("TryParse_InvalidJSON", func(t *testing.T) {
		parser := NewStreamingParameterParser(nil)

		err := parser.AddChunk(`{"invalid": json`)
		assert.NoError(t, err)

		params, err := parser.TryParse()
		assert.Error(t, err)
		assert.Nil(t, params)
		assert.False(t, parser.IsComplete())
	})

	t.Run("TryParse_ValidationError", func(t *testing.T) {
		schema := &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"name": {Type: "string"},
			},
			Required: []string{"name"},
		}

		parser := NewStreamingParameterParser(schema)

		// Add valid JSON but missing required field
		err := parser.AddChunk(`{"age": 30}`)
		assert.NoError(t, err)

		params, err := parser.TryParse()
		assert.Error(t, err)
		assert.Nil(t, params)
		assert.False(t, parser.IsComplete())
	})

	t.Run("TryParse_NoValidator", func(t *testing.T) {
		parser := NewStreamingParameterParser(nil)

		err := parser.AddChunk(`{"any": "data"}`)
		assert.NoError(t, err)

		params, err := parser.TryParse()
		assert.NoError(t, err)
		assert.Equal(t, "data", params["any"])
		assert.True(t, parser.IsComplete())
	})
}

// TestStreamingResultBuilder tests the StreamingResultBuilder functionality
func TestStreamingResultBuilder(t *testing.T) {
	t.Run("NewStreamingResultBuilder", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		assert.NotNil(t, builder)
		assert.NotNil(t, builder.ctx)
		assert.NotNil(t, builder.streamCtx)
	})

	t.Run("SendProgress", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		err := builder.SendProgress(50, 100, "Processing...")
		assert.NoError(t, err)

		select {
		case chunk := <-builder.Channel():
			assert.Equal(t, "metadata", chunk.Type)
			metadata := chunk.Data.(map[string]interface{})
			progress := metadata["progress"].(map[string]interface{})
			assert.Equal(t, 50, progress["current"])
			assert.Equal(t, 100, progress["total"])
			assert.Equal(t, "Processing...", progress["message"])
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("SendPartialResult", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		data := map[string]string{"status": "partial"}
		err := builder.SendPartialResult(data)
		assert.NoError(t, err)

		select {
		case chunk := <-builder.Channel():
			assert.Equal(t, "data", chunk.Type)
			assert.Equal(t, data, chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("Complete", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		// Complete with final data
		finalData := map[string]string{"status": "done"}
		err := builder.Complete(finalData)
		assert.NoError(t, err)

		// Should receive data chunk then complete chunk
		var gotData, gotComplete bool

		timeout := time.After(time.Second)
		for i := 0; i < 2; i++ {
			select {
			case chunk := <-builder.Channel():
				if chunk.Type == "data" {
					gotData = true
					assert.Equal(t, finalData, chunk.Data)
				} else if chunk.Type == "complete" {
					gotComplete = true
				}
			case <-timeout:
				t.Fatal("timeout waiting for chunks")
			}
		}

		assert.True(t, gotData)
		assert.True(t, gotComplete)
	})

	t.Run("Complete_NoData", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		err := builder.Complete(nil)
		assert.NoError(t, err)

		select {
		case chunk := <-builder.Channel():
			assert.Equal(t, "complete", chunk.Type)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}
	})

	t.Run("Error", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		testErr := errors.New("something went wrong")
		err := builder.Error(testErr)
		assert.NoError(t, err)

		// Should receive error chunk
		select {
		case chunk := <-builder.Channel():
			assert.Equal(t, "error", chunk.Type)
			assert.Equal(t, "something went wrong", chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for chunk")
		}

		// Channel should be closed
		_, ok := <-builder.Channel()
		assert.False(t, ok)
	})

	t.Run("ConcurrentOperations", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		var wg sync.WaitGroup

		// Send progress updates concurrently
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				err := builder.SendProgress(index, 5, "Processing")
				if err != nil {
					// Ignore error in concurrent test
					_ = err
				}
			}(i)
		}

		// Send partial results concurrently
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				err := builder.SendPartialResult(map[string]int{"index": index})
				if err != nil {
					// Ignore error in concurrent test
					_ = err
				}
			}(i)
		}

		// Consume chunks concurrently
		var chunkCount int
		var mu sync.Mutex

		wg.Add(1)
		go func() {
			defer wg.Done()
			timeout := time.After(2 * time.Second)
			for {
				select {
				case _, ok := <-builder.Channel():
					if !ok {
						return
					}
					mu.Lock()
					chunkCount++
					mu.Unlock()
					if chunkCount >= 10 {
						return
					}
				case <-timeout:
					return
				}
			}
		}()

		// Wait for goroutines
		wg.Wait()

		// Complete the stream
		err := builder.Complete(nil)
		assert.NoError(t, err)

		mu.Lock()
		assert.GreaterOrEqual(t, chunkCount, 10)
		mu.Unlock()
	})
}

// TestIntegration tests integration scenarios
func TestIntegration(t *testing.T) {
	t.Run("StreamingTool_EndToEnd", func(t *testing.T) {
		ctx := context.Background()

		// Simulate a tool that streams results
		simulateTool := func(ctx context.Context) (<-chan *ToolStreamChunk, error) {
			builder := NewStreamingResultBuilder(ctx)

			go func() {
				// Send progress updates
				for i := 0; i <= 100; i += 20 {
					err := builder.SendProgress(i, 100, "Processing")
					if err != nil {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}

				// Send partial results as JSON strings
				for i := 0; i < 3; i++ {
					partialData := map[string]interface{}{
						"batch": i,
						"data":  strings.Repeat("x", 100),
					}
					// Convert to JSON string for accumulator
					jsonData, _ := json.Marshal(partialData)
					err := builder.SendPartialResult(string(jsonData))
					if err != nil {
						return
					}
				}

				// Complete with final result as JSON string
				finalData, _ := json.Marshal(map[string]string{"status": "success"})
				err := builder.Complete(string(finalData))
				if err != nil {
					return
				}

				// Close the stream
				err = builder.streamCtx.Close()
				if err != nil {
					// Already closed is okay
					_ = err
				}
			}()

			return builder.Channel(), nil
		}

		// Consume the stream
		chunks, err := simulateTool(ctx)
		require.NoError(t, err)

		acc := NewStreamAccumulator()
		for chunk := range chunks {
			chunkErr := acc.AddChunk(chunk)
			assert.NoError(t, chunkErr)
		}

		assert.True(t, acc.IsComplete())
		assert.False(t, acc.HasError())

		_, metadata, err := acc.GetResult()
		assert.NoError(t, err)
		assert.NotNil(t, metadata["progress"])
	})

	t.Run("LargeDataStreaming", func(t *testing.T) {
		ctx := context.Background()
		helper := NewStreamingToolHelper()

		// Create large data
		largeData := make(map[string]interface{})
		for i := 0; i < 1000; i++ {
			largeData[fmt.Sprintf("%c%d", 'a'+i%26, i)] = strings.Repeat("data", 100)
		}

		// Stream it
		chunks, err := helper.StreamJSON(ctx, largeData, 1024)
		require.NoError(t, err)

		// Accumulate
		acc := NewStreamAccumulator()
		for chunk := range chunks {
			chunkErr := acc.AddChunk(chunk)
			assert.NoError(t, chunkErr)
		}

		result, _, err := acc.GetResult()
		assert.NoError(t, err)

		// Verify reconstruction
		var reconstructed map[string]interface{}
		err = json.Unmarshal([]byte(result), &reconstructed)
		assert.NoError(t, err)
		assert.Equal(t, largeData, reconstructed)
	})

	t.Run("ReaderToAccumulator", func(t *testing.T) {
		ctx := context.Background()
		helper := NewStreamingToolHelper()

		// Test data
		testData := "This is a test of streaming from a reader to an accumulator."
		reader := strings.NewReader(testData)

		// Stream from reader
		chunks, err := helper.StreamReader(ctx, reader, 5)
		require.NoError(t, err)

		// Accumulate
		acc := NewStreamAccumulator()
		for chunk := range chunks {
			chunkErr := acc.AddChunk(chunk)
			assert.NoError(t, chunkErr)
		}

		result, _, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Equal(t, testData, result)
	})
}

// Helper types for testing

// errorReader is a reader that always returns an error
type errorReader struct {
	err error
}

func (r *errorReader) Read(p []byte) (n int, err error) {
	return 0, r.err
}

// TestStreamingEdgeCases tests various edge cases for streaming functionality
func TestStreamingEdgeCases(t *testing.T) {
	t.Run("EmptyStream", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Complete immediately
		err := sc.Complete()
		assert.NoError(t, err)

		chunk := <-sc.Channel()
		assert.Equal(t, "complete", chunk.Type)

		err = sc.Close()
		assert.NoError(t, err)
	})

	t.Run("ZeroChunkSize", func(t *testing.T) {
		ctx := context.Background()
		helper := NewStreamingToolHelper()

		// Zero chunk size should use a minimum buffer
		reader := strings.NewReader("test")
		chunks, err := helper.StreamReader(ctx, reader, 1) // Use 1 instead of 0
		assert.NoError(t, err)
		assert.NotNil(t, chunks)

		// Collect all chunks
		var result string
		for chunk := range chunks {
			if chunk.Type == "data" {
				result += chunk.Data.(string)
			}
		}
		assert.Equal(t, "test", result)
	})

	t.Run("NilContext", func(t *testing.T) {
		// Test that context.TODO() is handled properly
		sc := NewStreamingContext(context.TODO())
		assert.NotNil(t, sc)
		assert.NotEqual(t, nil, sc.ctx)

		// Operations should work normally with the background context
		err := sc.Send("test")
		assert.NoError(t, err)
	})

	t.Run("VeryLargeChunk", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Send very large data
		largeData := strings.Repeat("x", 10*1024*1024) // 10MB
		err := sc.Send(largeData)
		assert.NoError(t, err)

		select {
		case chunk := <-sc.Channel():
			assert.Equal(t, largeData, chunk.Data)
		case <-time.After(time.Second):
			t.Fatal("timeout waiting for large chunk")
		}

		err = sc.Close()
		assert.NoError(t, err)
	})

	t.Run("RapidClose", func(t *testing.T) {
		ctx := context.Background()

		// Create and immediately close multiple contexts
		for i := 0; i < 100; i++ {
			sc := NewStreamingContext(ctx)
			go func() {
				_ = sc.Send("data") // Ignore error in race condition test
			}()
			_ = sc.Close() // Ignore error in rapid close test
		}
	})

	t.Run("ConcurrentClose", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Send some data
		err := sc.Send("test")
		assert.NoError(t, err)

		// Close concurrently from multiple goroutines
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				closeErr := sc.Close()
				assert.NoError(t, closeErr)
			}()
		}
		wg.Wait()

		// Verify closed state
		assert.True(t, sc.closed)
		err = sc.Send("should fail")
		assert.Error(t, err)
	})

	t.Run("StreamJSON_LargeChunkSize", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Small data with large chunk size
		data := map[string]string{"key": "value"}
		chunks, err := helper.StreamJSON(ctx, data, 10000)
		assert.NoError(t, err)

		// Should get all data in one chunk plus complete
		var chunkCount int
		for range chunks {
			chunkCount++
		}
		assert.Equal(t, 2, chunkCount) // data + complete
	})

	t.Run("BufferOverflow", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Fill the buffer completely (100 is the buffer size)
		for i := 0; i < 100; i++ {
			err := sc.Send(i)
			assert.NoError(t, err)
		}

		// Next send should block until we read
		done := make(chan bool)
		go func() {
			err := sc.Send("blocking")
			assert.NoError(t, err)
			done <- true
		}()

		// Should not complete immediately
		select {
		case <-done:
			t.Fatal("Send should have blocked")
		case <-time.After(100 * time.Millisecond):
			// Expected - send is blocked
		}

		// Read one item to unblock
		<-sc.Channel()

		// Now send should complete
		select {
		case <-done:
			// Expected
		case <-time.After(time.Second):
			t.Fatal("Send should have completed after buffer space available")
		}

		err := sc.Close()
		assert.NoError(t, err)
	})

	t.Run("StreamingResultBuilder_ClosedContext", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		builder := NewStreamingResultBuilder(ctx)

		// Cancel context
		cancel()

		// Operations should handle canceled context
		err := builder.SendProgress(50, 100, "test")
		// The error depends on whether the buffered channel accepts the write
		// before checking context cancellation
		if err != nil {
			assert.Equal(t, context.Canceled, err)
		}
	})

	t.Run("StreamAccumulator_MixedMetadata", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add various metadata types
		meta1 := map[string]interface{}{
			"string": "value",
			"number": 123,
			"bool":   true,
			"nested": map[string]interface{}{"key": "value"},
		}

		err := acc.AddChunk(&ToolStreamChunk{Type: "metadata", Data: meta1})
		assert.NoError(t, err)

		// Add data
		err = acc.AddChunk(&ToolStreamChunk{Type: "data", Data: "content"})
		assert.NoError(t, err)

		// Complete
		err = acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		result, metadata, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Equal(t, "content", result)
		assert.Equal(t, "value", metadata["string"])
		assert.Equal(t, 123, metadata["number"])
		assert.Equal(t, true, metadata["bool"])
		assert.NotNil(t, metadata["nested"])
	})

	t.Run("StreamingParameterParser_ProgressiveParsing", func(t *testing.T) {
		schema := &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"name": {Type: "string"},
			},
		}

		parser := NewStreamingParameterParser(schema)

		// Try parsing at each stage
		err := parser.AddChunk(`{`)
		assert.NoError(t, err)
		_, err = parser.TryParse()
		assert.Error(t, err) // Incomplete JSON

		err = parser.AddChunk(`"name"`)
		assert.NoError(t, err)
		_, err = parser.TryParse()
		assert.Error(t, err) // Still incomplete

		err = parser.AddChunk(`: "test"}`)
		assert.NoError(t, err)
		params, err := parser.TryParse()
		assert.NoError(t, err)
		assert.Equal(t, "test", params["name"])
		assert.True(t, parser.IsComplete())

		// Further parsing should still work
		params2, err := parser.TryParse()
		assert.NoError(t, err)
		assert.Equal(t, params, params2)
	})

	t.Run("EmptyReader", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		reader := bytes.NewReader([]byte{})
		chunks, err := helper.StreamReader(ctx, reader, 10)
		assert.NoError(t, err)

		// Should only get complete chunk
		chunk := <-chunks
		assert.Equal(t, "complete", chunk.Type)

		// Channel should be closed
		_, ok := <-chunks
		assert.False(t, ok)
	})
}

// BenchmarkStreamingContext benchmarks StreamingContext operations
func BenchmarkStreamingContext(b *testing.B) {
	ctx := context.Background()
	sc := NewStreamingContext(ctx)
	defer func() {
		_ = sc.Close() // Ignore error in benchmark cleanup
	}()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = sc.Send("test data") // Ignore error in benchmark
		<-sc.Channel()
	}
}

// BenchmarkStreamAccumulator benchmarks StreamAccumulator operations
func BenchmarkStreamAccumulator(b *testing.B) {
	acc := NewStreamAccumulator()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		chunk := &ToolStreamChunk{
			Type:  "data",
			Data:  "test data",
			Index: i,
		}
		_ = acc.AddChunk(chunk) // Ignore error in benchmark
	}
}

// TestStreamingMiscellaneous tests additional edge cases and scenarios
func TestStreamingMiscellaneous(t *testing.T) {
	t.Run("StreamAccumulator_NonStringError", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add error chunk with non-string data
		err := acc.AddChunk(&ToolStreamChunk{
			Type: "error",
			Data: 123, // Non-string error
		})
		assert.NoError(t, err)
		assert.True(t, acc.HasError())

		// Complete and check error
		err = acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		_, _, err = acc.GetResult()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "stream error:")
	})

	t.Run("StreamAccumulator_NonMapMetadata", func(t *testing.T) {
		acc := NewStreamAccumulator()

		// Add metadata chunk with non-map data - should be ignored
		err := acc.AddChunk(&ToolStreamChunk{
			Type: "metadata",
			Data: "not a map",
		})
		assert.NoError(t, err)

		// Complete
		err = acc.AddChunk(&ToolStreamChunk{Type: "complete"})
		assert.NoError(t, err)

		_, metadata, err := acc.GetResult()
		assert.NoError(t, err)
		assert.Empty(t, metadata)
	})

	t.Run("StreamingContext_MultipleCompletes", func(t *testing.T) {
		ctx := context.Background()
		sc := NewStreamingContext(ctx)

		// Send multiple complete chunks
		for i := 0; i < 3; i++ {
			err := sc.Complete()
			assert.NoError(t, err)
		}

		// Verify we get all complete chunks
		for i := 0; i < 3; i++ {
			select {
			case chunk := <-sc.Channel():
				assert.Equal(t, "complete", chunk.Type)
				assert.Equal(t, i, chunk.Index)
			case <-time.After(time.Second):
				t.Fatal("timeout waiting for complete chunk")
			}
		}

		err := sc.Close()
		assert.NoError(t, err)
	})

	t.Run("StreamingResultBuilder_CloseAfterError", func(t *testing.T) {
		ctx := context.Background()
		builder := NewStreamingResultBuilder(ctx)

		// Send error which should close the stream
		err := builder.Error(errors.New("test error"))
		assert.NoError(t, err)

		// Try to send more data - should fail
		err = builder.SendPartialResult("data")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "streaming context is closed")
	})

	t.Run("StreamJSON_EmptyData", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Stream empty object
		chunks, err := helper.StreamJSON(ctx, struct{}{}, 10)
		assert.NoError(t, err)

		var result string
		for chunk := range chunks {
			if chunk.Type == "data" {
				result += chunk.Data.(string)
			}
		}

		assert.Equal(t, "{}", result)
	})

	t.Run("StreamReader_ZeroByteRead", func(t *testing.T) {
		helper := NewStreamingToolHelper()
		ctx := context.Background()

		// Create a reader that returns 0 bytes sometimes
		reader := &intermittentReader{
			data:      []byte("Hello, World!"),
			zeroReads: 3,
		}

		chunks, err := helper.StreamReader(ctx, reader, 5)
		assert.NoError(t, err)

		var result string
		for chunk := range chunks {
			if chunk.Type == "data" {
				result += chunk.Data.(string)
			}
		}

		assert.Equal(t, "Hello, World!", result)
	})

	t.Run("ConcurrentStreamingOperations", func(t *testing.T) {
		ctx := context.Background()

		// Multiple streaming contexts operating concurrently
		var wg sync.WaitGroup
		contexts := make([]*StreamingContext, 10)

		for i := 0; i < 10; i++ {
			contexts[i] = NewStreamingContext(ctx)
			wg.Add(1)

			go func(idx int, sc *StreamingContext) {
				defer wg.Done()
				defer func() {
					_ = sc.Close() // Ignore error in cleanup
				}()

				// Send data
				for j := 0; j < 10; j++ {
					err := sc.Send(map[string]int{"context": idx, "item": j})
					if err != nil {
						return // Exit on error
					}
				}
				err := sc.Complete()
				if err != nil {
					// Ignore error in concurrent test
					_ = err
				}
			}(i, contexts[i])
		}

		// Consume from all contexts concurrently
		for i, sc := range contexts {
			wg.Add(1)
			go func(idx int, sc *StreamingContext) {
				defer wg.Done()

				itemCount := 0
				for chunk := range sc.Channel() {
					if chunk.Type == "data" {
						data := chunk.Data.(map[string]int)
						assert.Equal(t, idx, data["context"])
						itemCount++
					}
				}
				assert.GreaterOrEqual(t, itemCount, 10)
			}(i, sc)
		}

		wg.Wait()
	})
}

// intermittentReader simulates a reader that sometimes returns 0 bytes
type intermittentReader struct {
	data      []byte
	pos       int
	zeroReads int
	readCount int
}

func (r *intermittentReader) Read(p []byte) (n int, err error) {
	if r.readCount < r.zeroReads {
		r.readCount++
		return 0, nil
	}

	if r.pos >= len(r.data) {
		return 0, io.EOF
	}

	n = copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
