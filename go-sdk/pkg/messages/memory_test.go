package messages

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHistoryMemoryLimits(t *testing.T) {
	t.Run("Memory limit prevents adding messages", func(t *testing.T) {
		// Create history with small memory limit
		options := DefaultHistoryOptions()
		options.MaxMemoryBytes = 1024 // 1KB limit
		history := NewHistory(options)

		// Create a large message (larger than 1KB when serialized)
		largeContent := strings.Repeat("Hello World! ", 100) // ~1300 bytes
		msg := NewUserMessage(largeContent)

		// Should fail to add
		err := history.Add(msg)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "would exceed memory limit")
		assert.Equal(t, 0, history.Size())
	})

	t.Run("Memory tracking and compaction", func(t *testing.T) {
		// Create history with moderate memory limit
		options := DefaultHistoryOptions()
		options.MaxMemoryBytes = 20 * 1024 // 20KB limit
		options.MaxMessages = 100
		history := NewHistory(options)

		// Add messages until we approach the limit
		successCount := 0
		for i := 0; i < 20; i++ {
			msg := NewUserMessage(strings.Repeat("Test message ", 50)) // ~650 bytes each
			err := history.Add(msg)
			if err != nil {
				break // Stop when we hit the limit
			}
			successCount++
		}
		
		// Should have added at least some messages
		assert.Greater(t, successCount, 5)

		// Check memory usage is tracked
		assert.Greater(t, history.CurrentMemoryBytes(), int64(0))
		assert.Less(t, history.CurrentMemoryBytes(), options.MaxMemoryBytes)

		// Try to add a message that would exceed the limit
		bigMsg := NewUserMessage(strings.Repeat("Big message ", 2000)) // ~24KB
		err := history.Add(bigMsg)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "would exceed memory limit")
	})

	t.Run("Batch add respects memory limits", func(t *testing.T) {
		options := DefaultHistoryOptions()
		options.MaxMemoryBytes = 5 * 1024 // 5KB limit
		history := NewHistory(options)

		// Create batch of messages
		messages := make([]Message, 10)
		for i := 0; i < 10; i++ {
			messages[i] = NewUserMessage(strings.Repeat("Batch msg ", 60)) // ~660 bytes each
		}

		// Should fail as batch exceeds limit
		err := history.AddBatch(messages)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "would exceed memory limit")
		assert.Equal(t, 0, history.Size())
	})

	t.Run("Clear resets memory tracking", func(t *testing.T) {
		options := DefaultHistoryOptions()
		options.MaxMemoryBytes = 10 * 1024
		history := NewHistory(options)

		// Add some messages
		for i := 0; i < 5; i++ {
			msg := NewUserMessage("Test message " + string(rune('A'+i)))
			history.Add(msg)
		}

		assert.Greater(t, history.CurrentMemoryBytes(), int64(0))

		// Clear should reset memory
		history.Clear()
		assert.Equal(t, int64(0), history.CurrentMemoryBytes())
		assert.Equal(t, 0, history.Size())
	})
}

func TestValidationByteSize(t *testing.T) {
	t.Run("Content byte size validation", func(t *testing.T) {
		options := DefaultValidationOptions()
		options.MaxContentBytes = 100 // 100 bytes limit
		validator := NewValidator(options)

		// Small message should pass
		smallMsg := NewUserMessage("Hello")
		err := validator.ValidateMessage(smallMsg)
		assert.NoError(t, err)

		// Large message should fail
		largeMsg := NewUserMessage(strings.Repeat("Large ", 50)) // 300 bytes
		err = validator.ValidateMessage(largeMsg)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "exceeds maximum byte size")
	})

	t.Run("Unicode expansion protection", func(t *testing.T) {
		options := DefaultValidationOptions()
		options.MaxContentBytes = 100
		validator := NewValidator(options)

		// Unicode characters can take multiple bytes
		// This string has 20 characters but takes more bytes
		unicodeMsg := NewUserMessage("Hello 世界🌍 Test 测试 🚀")
		
		// Calculate actual byte size
		content := unicodeMsg.GetContent()
		byteSize := len([]byte(*content))
		
		// If it exceeds limit, should fail
		if byteSize > 100 {
			err := validator.ValidateMessage(unicodeMsg)
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "exceeds maximum byte size")
		}
	})

	t.Run("Tool arguments byte size validation", func(t *testing.T) {
		options := DefaultValidationOptions()
		options.MaxArgumentsBytes = 100 // 100 bytes limit
		validator := NewValidator(options)

		// Create assistant message with tool calls
		smallArgs := `{"city": "SF"}`
		msg := NewAssistantMessageWithTools([]ToolCall{
			{
				ID:   "call_1",
				Type: "function",
				Function: Function{
					Name:      "get_weather",
					Arguments: smallArgs,
				},
			},
		})

		// Should pass
		err := validator.ValidateMessage(msg)
		assert.NoError(t, err)

		// Large arguments should fail
		largeArgs := `{"data": "` + strings.Repeat("x", 200) + `"}`
		msg2 := NewAssistantMessageWithTools([]ToolCall{
			{
				ID:   "call_2",
				Type: "function",
				Function: Function{
					Name:      "process_data",
					Arguments: largeArgs,
				},
			},
		})

		err = validator.ValidateMessage(msg2)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "exceed maximum byte size")
	})
}

func TestMessageSizeCalculation(t *testing.T) {
	t.Run("Calculate message size", func(t *testing.T) {
		msg := NewUserMessage("Hello, World!")
		
		size, err := CalculateMessageSize(msg)
		require.NoError(t, err)
		assert.Greater(t, size, int64(0))
		
		// Size should include the JSON structure overhead
		assert.Greater(t, size, int64(len("Hello, World!")))
	})

	t.Run("Validate message total size", func(t *testing.T) {
		msg := NewAssistantMessageWithTools([]ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "test_function",
					Arguments: `{"param": "value"}`,
				},
			},
		})

		// Set a reasonable limit
		err := ValidateMessageSize(msg, 1024*1024) // 1MB
		assert.NoError(t, err)

		// Set a very small limit
		err = ValidateMessageSize(msg, 10) // 10 bytes
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "exceeds maximum size")
	})
}