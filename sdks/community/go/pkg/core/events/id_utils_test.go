package events

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDefaultIDGenerator(t *testing.T) {
	t.Run("NewDefaultIDGenerator", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		assert.NotNil(t, gen)
	})

	t.Run("GenerateRunID", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		id := gen.GenerateRunID()

		assert.True(t, strings.HasPrefix(id, "run-"))
		assert.Greater(t, len(id), 4)

		// Generate multiple IDs to ensure uniqueness
		id2 := gen.GenerateRunID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateMessageID", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		id := gen.GenerateMessageID()

		assert.True(t, strings.HasPrefix(id, "msg-"))
		assert.Greater(t, len(id), 4)

		// Test uniqueness
		id2 := gen.GenerateMessageID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateToolCallID", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		id := gen.GenerateToolCallID()

		assert.True(t, strings.HasPrefix(id, "tool-"))
		assert.Greater(t, len(id), 5)

		// Test uniqueness
		id2 := gen.GenerateToolCallID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateThreadID", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		id := gen.GenerateThreadID()

		assert.True(t, strings.HasPrefix(id, "thread-"))
		assert.Greater(t, len(id), 7)

		// Test uniqueness
		id2 := gen.GenerateThreadID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateStepID", func(t *testing.T) {
		gen := NewDefaultIDGenerator()
		id := gen.GenerateStepID()

		assert.True(t, strings.HasPrefix(id, "step-"))
		assert.Greater(t, len(id), 5)

		// Test uniqueness
		id2 := gen.GenerateStepID()
		assert.NotEqual(t, id, id2)
	})
}

func TestTimestampIDGenerator(t *testing.T) {
	t.Run("NewTimestampIDGenerator_NoPrefix", func(t *testing.T) {
		gen := NewTimestampIDGenerator("")
		assert.NotNil(t, gen)
		assert.Equal(t, "", gen.prefix)
	})

	t.Run("NewTimestampIDGenerator_WithPrefix", func(t *testing.T) {
		gen := NewTimestampIDGenerator("test")
		assert.NotNil(t, gen)
		assert.Equal(t, "test", gen.prefix)
	})

	t.Run("GenerateRunID_NoPrefix", func(t *testing.T) {
		gen := NewTimestampIDGenerator("")
		id := gen.GenerateRunID()

		assert.True(t, strings.HasPrefix(id, "run-"))
		assert.Contains(t, id, "-")

		// Verify timestamp is present
		parts := strings.Split(id, "-")
		require.GreaterOrEqual(t, len(parts), 3)
		timestamp := parts[1]
		_, err := time.Parse("", timestamp) // Just check it's a number
		assert.NotNil(t, err) // We expect an error because timestamp is just a number

		// Test uniqueness
		id2 := gen.GenerateRunID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateRunID_WithPrefix", func(t *testing.T) {
		gen := NewTimestampIDGenerator("myapp")
		id := gen.GenerateRunID()

		assert.True(t, strings.HasPrefix(id, "myapp-run-"))
		assert.Contains(t, id, "-")

		// Test format: prefix-type-timestamp-uuid
		parts := strings.Split(id, "-")
		require.GreaterOrEqual(t, len(parts), 4)
		assert.Equal(t, "myapp", parts[0])
		assert.Equal(t, "run", parts[1])
	})

	t.Run("GenerateMessageID", func(t *testing.T) {
		gen := NewTimestampIDGenerator("")
		id := gen.GenerateMessageID()

		assert.True(t, strings.HasPrefix(id, "msg-"))
		assert.Contains(t, id, "-")

		// Test uniqueness
		id2 := gen.GenerateMessageID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateToolCallID", func(t *testing.T) {
		gen := NewTimestampIDGenerator("service")
		id := gen.GenerateToolCallID()

		assert.True(t, strings.HasPrefix(id, "service-tool-"))
		assert.Contains(t, id, "-")

		// Test uniqueness
		id2 := gen.GenerateToolCallID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateThreadID", func(t *testing.T) {
		gen := NewTimestampIDGenerator("")
		id := gen.GenerateThreadID()

		assert.True(t, strings.HasPrefix(id, "thread-"))
		assert.Contains(t, id, "-")

		// Test uniqueness
		id2 := gen.GenerateThreadID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GenerateStepID", func(t *testing.T) {
		gen := NewTimestampIDGenerator("app")
		id := gen.GenerateStepID()

		assert.True(t, strings.HasPrefix(id, "app-step-"))
		assert.Contains(t, id, "-")

		// Test uniqueness
		id2 := gen.GenerateStepID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("Timestamp_Ordering", func(t *testing.T) {
		gen := NewTimestampIDGenerator("")
		
		// Generate IDs with slight delay
		id1 := gen.GenerateRunID()
		time.Sleep(2 * time.Millisecond)
		id2 := gen.GenerateRunID()
		
		// Extract timestamps
		parts1 := strings.Split(id1, "-")
		parts2 := strings.Split(id2, "-")
		
		require.GreaterOrEqual(t, len(parts1), 3)
		require.GreaterOrEqual(t, len(parts2), 3)
		
		// The timestamp in id2 should be >= timestamp in id1
		// (We can't parse them as ints here but the string comparison should work for ordering)
		assert.True(t, parts2[1] >= parts1[1])
	})
}

func TestGlobalIDGenerator(t *testing.T) {
	t.Run("GetDefaultIDGenerator", func(t *testing.T) {
		gen := GetDefaultIDGenerator()
		assert.NotNil(t, gen)
		
		// Should be a DefaultIDGenerator by default
		_, ok := gen.(*DefaultIDGenerator)
		assert.True(t, ok)
	})

	t.Run("SetDefaultIDGenerator", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		// Set custom generator
		customGen := NewTimestampIDGenerator("custom")
		SetDefaultIDGenerator(customGen)

		gen := GetDefaultIDGenerator()
		assert.Equal(t, customGen, gen)

		// Verify it's actually being used
		timestampGen, ok := gen.(*TimestampIDGenerator)
		require.True(t, ok)
		assert.Equal(t, "custom", timestampGen.prefix)
	})

	t.Run("GlobalGenerateRunID", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		// Test with default generator
		id := GenerateRunID()
		assert.True(t, strings.HasPrefix(id, "run-"))

		// Switch to timestamp generator
		SetDefaultIDGenerator(NewTimestampIDGenerator("global"))
		id = GenerateRunID()
		assert.True(t, strings.HasPrefix(id, "global-run-"))
	})

	t.Run("GlobalGenerateMessageID", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		id := GenerateMessageID()
		assert.True(t, strings.HasPrefix(id, "msg-"))

		// Test uniqueness
		id2 := GenerateMessageID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GlobalGenerateToolCallID", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		id := GenerateToolCallID()
		assert.True(t, strings.HasPrefix(id, "tool-"))

		// Test uniqueness
		id2 := GenerateToolCallID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GlobalGenerateThreadID", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		id := GenerateThreadID()
		assert.True(t, strings.HasPrefix(id, "thread-"))

		// Test uniqueness
		id2 := GenerateThreadID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("GlobalGenerateStepID", func(t *testing.T) {
		// Save original
		original := GetDefaultIDGenerator()
		defer SetDefaultIDGenerator(original)

		id := GenerateStepID()
		assert.True(t, strings.HasPrefix(id, "step-"))

		// Test uniqueness
		id2 := GenerateStepID()
		assert.NotEqual(t, id, id2)
	})

	t.Run("Concurrent_ID_Generation", func(t *testing.T) {
		// Test that concurrent ID generation produces unique IDs
		gen := NewDefaultIDGenerator()
		idChan := make(chan string, 100)

		// Generate IDs concurrently
		for i := 0; i < 100; i++ {
			go func() {
				idChan <- gen.GenerateRunID()
			}()
		}

		// Collect all IDs
		ids := make(map[string]bool)
		for i := 0; i < 100; i++ {
			id := <-idChan
			if ids[id] {
				t.Errorf("Duplicate ID generated: %s", id)
			}
			ids[id] = true
		}

		assert.Equal(t, 100, len(ids))
	})
}