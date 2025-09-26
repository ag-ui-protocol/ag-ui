package events

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBaseEvent(t *testing.T) {
	t.Run("NewBaseEvent", func(t *testing.T) {
		eventType := EventTypeRunStarted
		base := NewBaseEvent(eventType)

		assert.Equal(t, eventType, base.Type())
		assert.NotNil(t, base.Timestamp())
		assert.True(t, *base.Timestamp() > 0)
	})

	t.Run("SetTimestamp", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)
		timestamp := time.Now().UnixMilli()

		base.SetTimestamp(timestamp)
		assert.Equal(t, timestamp, *base.Timestamp())
	})

	t.Run("Validate", func(t *testing.T) {
		// Valid base event
		base := NewBaseEvent(EventTypeRunStarted)
		assert.NoError(t, base.Validate())

		// Invalid event type
		base.EventType = ""
		assert.Error(t, base.Validate())

		// Unknown event type
		base.EventType = "UNKNOWN"
		assert.Error(t, base.Validate())
	})
}

func TestRunEvents(t *testing.T) {
	t.Run("RunStartedEvent", func(t *testing.T) {
		threadID := "thread-123"
		runID := "run-456"

		event := NewRunStartedEvent(threadID, runID)

		assert.Equal(t, EventTypeRunStarted, event.Type())
		assert.Equal(t, threadID, event.ThreadID())
		assert.Equal(t, runID, event.RunID())
		assert.NoError(t, event.Validate())

		// Test JSON serialization
		jsonData, err := event.ToJSON()
		require.NoError(t, err)
		assert.Contains(t, string(jsonData), threadID)
		assert.Contains(t, string(jsonData), runID)

		// Test validation errors
		event.ThreadIDValue = ""
		assert.Error(t, event.Validate())

		event.ThreadIDValue = threadID
		event.RunIDValue = ""
		assert.Error(t, event.Validate())
	})

	t.Run("RunFinishedEvent", func(t *testing.T) {
		threadID := "thread-123"
		runID := "run-456"

		event := NewRunFinishedEvent(threadID, runID)

		assert.Equal(t, EventTypeRunFinished, event.Type())
		assert.Equal(t, threadID, event.ThreadID())
		assert.Equal(t, runID, event.RunID())
		assert.NoError(t, event.Validate())

		// Test JSON serialization
		jsonData, err := event.ToJSON()
		require.NoError(t, err)
		assert.Contains(t, string(jsonData), threadID)
	})

	t.Run("RunErrorEvent", func(t *testing.T) {
		message := "Something went wrong"
		code := "ERROR_CODE"
		runID := "run-456"

		event := NewRunErrorEvent(message, WithErrorCode(code), WithRunID(runID))

		assert.Equal(t, EventTypeRunError, event.Type())
		assert.Equal(t, message, event.Message)
		assert.Equal(t, &code, event.Code)
		assert.Equal(t, runID, event.RunID())
		assert.NoError(t, event.Validate())

		// Test validation error
		event.Message = ""
		assert.Error(t, event.Validate())
	})

	t.Run("StepStartedEvent", func(t *testing.T) {
		stepName := "step-1"

		event := NewStepStartedEvent(stepName)

		assert.Equal(t, EventTypeStepStarted, event.Type())
		assert.Equal(t, stepName, event.StepName)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.StepName = ""
		assert.Error(t, event.Validate())
	})

	t.Run("StepFinishedEvent", func(t *testing.T) {
		stepName := "step-1"

		event := NewStepFinishedEvent(stepName)

		assert.Equal(t, EventTypeStepFinished, event.Type())
		assert.Equal(t, stepName, event.StepName)
		assert.NoError(t, event.Validate())
	})
}

func TestMessageEvents(t *testing.T) {
	t.Run("TextMessageStartEvent", func(t *testing.T) {
		messageID := "msg-123"
		role := "user"

		event := NewTextMessageStartEvent(messageID, WithRole(role))

		assert.Equal(t, EventTypeTextMessageStart, event.Type())
		assert.Equal(t, messageID, event.MessageID)
		assert.Equal(t, &role, event.Role)
		assert.NoError(t, event.Validate())

		// Test without role
		event2 := NewTextMessageStartEvent(messageID)
		assert.Nil(t, event2.Role)
		assert.NoError(t, event2.Validate())

		// Test validation error
		event.MessageID = ""
		assert.Error(t, event.Validate())
	})

	t.Run("TextMessageContentEvent", func(t *testing.T) {
		messageID := "msg-123"
		delta := "Hello"

		event := NewTextMessageContentEvent(messageID, delta)

		assert.Equal(t, EventTypeTextMessageContent, event.Type())
		assert.Equal(t, messageID, event.MessageID)
		assert.Equal(t, delta, event.Delta)
		assert.NoError(t, event.Validate())

		// Test validation errors
		event.MessageID = ""
		assert.Error(t, event.Validate())

		event.MessageID = messageID
		event.Delta = ""
		assert.Error(t, event.Validate())
	})

	t.Run("TextMessageEndEvent", func(t *testing.T) {
		messageID := "msg-123"

		event := NewTextMessageEndEvent(messageID)

		assert.Equal(t, EventTypeTextMessageEnd, event.Type())
		assert.Equal(t, messageID, event.MessageID)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.MessageID = ""
		assert.Error(t, event.Validate())
	})
}

func TestToolEvents(t *testing.T) {
	t.Run("ToolCallStartEvent", func(t *testing.T) {
		toolCallID := "tool-123"
		toolCallName := "get_weather"
		parentMessageID := "msg-456"

		event := NewToolCallStartEvent(toolCallID, toolCallName, WithParentMessageID(parentMessageID))

		assert.Equal(t, EventTypeToolCallStart, event.Type())
		assert.Equal(t, toolCallID, event.ToolCallID)
		assert.Equal(t, toolCallName, event.ToolCallName)
		assert.Equal(t, &parentMessageID, event.ParentMessageID)
		assert.NoError(t, event.Validate())

		// Test validation errors
		event.ToolCallID = ""
		assert.Error(t, event.Validate())

		event.ToolCallID = toolCallID
		event.ToolCallName = ""
		assert.Error(t, event.Validate())
	})

	t.Run("ToolCallArgsEvent", func(t *testing.T) {
		toolCallID := "tool-123"
		delta := "{\"location\": \"San Francisco\"}"

		event := NewToolCallArgsEvent(toolCallID, delta)

		assert.Equal(t, EventTypeToolCallArgs, event.Type())
		assert.Equal(t, toolCallID, event.ToolCallID)
		assert.Equal(t, delta, event.Delta)
		assert.NoError(t, event.Validate())

		// Test validation errors
		event.ToolCallID = ""
		assert.Error(t, event.Validate())

		event.ToolCallID = toolCallID
		event.Delta = ""
		assert.Error(t, event.Validate())
	})

	t.Run("ToolCallEndEvent", func(t *testing.T) {
		toolCallID := "tool-123"

		event := NewToolCallEndEvent(toolCallID)

		assert.Equal(t, EventTypeToolCallEnd, event.Type())
		assert.Equal(t, toolCallID, event.ToolCallID)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.ToolCallID = ""
		assert.Error(t, event.Validate())
	})
}

func TestStateEvents(t *testing.T) {
	t.Run("StateSnapshotEvent", func(t *testing.T) {
		snapshot := map[string]any{
			"counter": 42,
			"status":  "active",
		}

		event := NewStateSnapshotEvent(snapshot)

		assert.Equal(t, EventTypeStateSnapshot, event.Type())
		assert.Equal(t, snapshot, event.Snapshot)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.Snapshot = nil
		assert.Error(t, event.Validate())
	})

	t.Run("StateDeltaEvent", func(t *testing.T) {
		delta := []JSONPatchOperation{
			{Op: "add", Path: "/counter", Value: 42},
			{Op: "replace", Path: "/status", Value: "inactive"},
		}

		event := NewStateDeltaEvent(delta)

		assert.Equal(t, EventTypeStateDelta, event.Type())
		assert.Equal(t, delta, event.Delta)
		assert.NoError(t, event.Validate())

		// Test validation errors
		event.Delta = []JSONPatchOperation{}
		assert.Error(t, event.Validate())

		// Invalid operation
		event.Delta = []JSONPatchOperation{
			{Op: "invalid", Path: "/counter", Value: 42},
		}
		assert.Error(t, event.Validate())

		// Missing path
		event.Delta = []JSONPatchOperation{
			{Op: "add", Value: 42},
		}
		assert.Error(t, event.Validate())

		// Missing value for add operation
		event.Delta = []JSONPatchOperation{
			{Op: "add", Path: "/counter"},
		}
		assert.Error(t, event.Validate())

		// Missing from for move operation
		event.Delta = []JSONPatchOperation{
			{Op: "move", Path: "/counter"},
		}
		assert.Error(t, event.Validate())
	})

	t.Run("MessagesSnapshotEvent", func(t *testing.T) {
		messages := []Message{
			{
				ID:      "msg-1",
				Role:    "user",
				Content: strPtr("Hello"),
			},
			{
				ID:   "msg-2",
				Role: "assistant",
				ToolCalls: []ToolCall{
					{
						ID:   "tool-1",
						Type: "function",
						Function: Function{
							Name:      "get_weather",
							Arguments: "{\"location\": \"SF\"}",
						},
					},
				},
			},
		}

		event := NewMessagesSnapshotEvent(messages)

		assert.Equal(t, EventTypeMessagesSnapshot, event.Type())
		assert.Equal(t, messages, event.Messages)
		assert.NoError(t, event.Validate())

		// Test validation errors
		invalidMessages := []Message{
			{Role: "user"}, // Missing ID
		}
		event.Messages = invalidMessages
		assert.Error(t, event.Validate())

		invalidMessages = []Message{
			{ID: "msg-1"}, // Missing role
		}
		event.Messages = invalidMessages
		assert.Error(t, event.Validate())

		invalidMessages = []Message{
			{
				ID:   "msg-1",
				Role: "assistant",
				ToolCalls: []ToolCall{
					{Type: "function"}, // Missing ID
				},
			},
		}
		event.Messages = invalidMessages
		assert.Error(t, event.Validate())
	})
}

func TestCustomEvents(t *testing.T) {
	t.Run("RawEvent", func(t *testing.T) {
		eventData := map[string]any{"key": "value"}
		source := "external-system"

		event := NewRawEvent(eventData, WithSource(source))

		assert.Equal(t, EventTypeRaw, event.Type())
		assert.Equal(t, eventData, event.Event)
		assert.Equal(t, &source, event.Source)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.Event = nil
		assert.Error(t, event.Validate())
	})

	t.Run("CustomEvent", func(t *testing.T) {
		name := "custom-event"
		value := map[string]any{"data": "test"}

		event := NewCustomEvent(name, WithValue(value))

		assert.Equal(t, EventTypeCustom, event.Type())
		assert.Equal(t, name, event.Name)
		assert.Equal(t, value, event.Value)
		assert.NoError(t, event.Validate())

		// Test validation error
		event.Name = ""
		assert.Error(t, event.Validate())
	})
}

func TestEventSequenceValidation(t *testing.T) {
	t.Run("ValidSequence", func(t *testing.T) {
		events := []Event{
			NewRunStartedEvent("thread-1", "run-1"),
			NewTextMessageStartEvent("msg-1"),
			NewTextMessageContentEvent("msg-1", "Hello"),
			NewTextMessageEndEvent("msg-1"),
			NewToolCallStartEvent("tool-1", "get_weather"),
			NewToolCallArgsEvent("tool-1", "{\"location\": \"SF\"}"),
			NewToolCallEndEvent("tool-1"),
			NewRunFinishedEvent("thread-1", "run-1"),
		}

		assert.NoError(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_DuplicateRunStart", func(t *testing.T) {
		events := []Event{
			NewRunStartedEvent("thread-1", "run-1"),
			NewRunStartedEvent("thread-1", "run-1"), // Duplicate
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_FinishNonExistentRun", func(t *testing.T) {
		events := []Event{
			NewRunFinishedEvent("thread-1", "run-1"), // Not started
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_RestartFinishedRun", func(t *testing.T) {
		events := []Event{
			NewRunStartedEvent("thread-1", "run-1"),
			NewRunFinishedEvent("thread-1", "run-1"),
			NewRunStartedEvent("thread-1", "run-1"), // Cannot restart
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_DuplicateMessageStart", func(t *testing.T) {
		events := []Event{
			NewTextMessageStartEvent("msg-1"),
			NewTextMessageStartEvent("msg-1"), // Duplicate
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_EndNonExistentMessage", func(t *testing.T) {
		events := []Event{
			NewTextMessageEndEvent("msg-1"), // Not started
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_DuplicateToolCallStart", func(t *testing.T) {
		events := []Event{
			NewToolCallStartEvent("tool-1", "get_weather"),
			NewToolCallStartEvent("tool-1", "get_weather"), // Duplicate
		}

		assert.Error(t, ValidateSequence(events))
	})

	t.Run("InvalidSequence_EndNonExistentToolCall", func(t *testing.T) {
		events := []Event{
			NewToolCallEndEvent("tool-1"), // Not started
		}

		assert.Error(t, ValidateSequence(events))
	})
}

func TestJSONSerialization(t *testing.T) {
	t.Run("RoundTrip", func(t *testing.T) {
		// Test various event types
		testEvents := []Event{
			NewRunStartedEvent("thread-1", "run-1"),
			NewTextMessageStartEvent("msg-1", WithRole("user")),
			NewTextMessageContentEvent("msg-1", "Hello"),
			NewToolCallStartEvent("tool-1", "get_weather", WithParentMessageID("msg-1")),
			NewStateSnapshotEvent(map[string]any{"counter": 42}),
			NewCustomEvent("test-event", WithValue("test-value")),
		}

		for _, originalEvent := range testEvents {
			// Serialize to JSON
			jsonData, err := originalEvent.ToJSON()
			require.NoError(t, err)

			// Deserialize from JSON
			parsedEvent, err := EventFromJSON(jsonData)
			require.NoError(t, err)

			// Verify the event type matches
			assert.Equal(t, originalEvent.Type(), parsedEvent.Type())

			// Verify the event validates
			assert.NoError(t, parsedEvent.Validate())
		}
	})

	t.Run("UnknownEventType", func(t *testing.T) {
		jsonData := []byte(`{"type": "UNKNOWN_EVENT"}`)
		_, err := EventFromJSON(jsonData)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "unknown event type")
	})

	t.Run("InvalidJSON", func(t *testing.T) {
		invalidJSON := []byte(`{"type": "RUN_STARTED", invalid}`)
		_, err := EventFromJSON(invalidJSON)
		assert.Error(t, err)
	})
}

// Helper function to create string pointers
func strPtr(s string) *string {
	return &s
}
