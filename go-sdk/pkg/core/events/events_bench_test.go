package events

import (
	"testing"
)

// BenchmarkEventCreation benchmarks the creation of different event types
func BenchmarkEventCreation(b *testing.B) {
	b.Run("RunStartedEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewRunStartedEvent("thread-123", "run-456")
		}
	})

	b.Run("RunStartedEventWithOptions", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewRunStartedEventWithOptions("", "", WithAutoRunID(), WithAutoThreadID())
		}
	})

	b.Run("TextMessageStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewTextMessageStartEvent("msg-123", WithRole("user"))
		}
	})

	b.Run("TextMessageStartEventWithAuto", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewTextMessageStartEvent("", WithAutoMessageID(), WithRole("user"))
		}
	})

	b.Run("TextMessageContentEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewTextMessageContentEvent("msg-123", "Hello world")
		}
	})

	b.Run("ToolCallStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewToolCallStartEvent("tool-123", "get_weather", WithParentMessageID("msg-456"))
		}
	})

	b.Run("ToolCallStartEventWithAuto", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewToolCallStartEvent("", "get_weather", WithAutoToolCallID(), WithParentMessageID("msg-456"))
		}
	})

	b.Run("StateSnapshotEvent", func(b *testing.B) {
		snapshot := map[string]any{
			"counter": 42,
			"status":  "active",
		}
		for i := 0; i < b.N; i++ {
			_ = NewStateSnapshotEvent(snapshot)
		}
	})

	b.Run("CustomEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = NewCustomEvent("test-event", WithValue("test-value"))
		}
	})
}

// BenchmarkEventValidation benchmarks the validation of different event types
func BenchmarkEventValidation(b *testing.B) {
	runEvent := NewRunStartedEvent("thread-123", "run-456")
	msgEvent := NewTextMessageStartEvent("msg-123", WithRole("user"))
	toolEvent := NewToolCallStartEvent("tool-123", "get_weather")
	stateEvent := NewStateSnapshotEvent(map[string]any{"counter": 42})
	customEvent := NewCustomEvent("test-event", WithValue("test-value"))

	b.Run("RunStartedEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = runEvent.Validate()
		}
	})

	b.Run("TextMessageStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = msgEvent.Validate()
		}
	})

	b.Run("ToolCallStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = toolEvent.Validate()
		}
	})

	b.Run("StateSnapshotEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = stateEvent.Validate()
		}
	})

	b.Run("CustomEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = customEvent.Validate()
		}
	})
}

// BenchmarkEventJSONSerialization benchmarks JSON serialization
func BenchmarkEventJSONSerialization(b *testing.B) {
	runEvent := NewRunStartedEvent("thread-123", "run-456")
	msgEvent := NewTextMessageStartEvent("msg-123", WithRole("user"))
	toolEvent := NewToolCallStartEvent("tool-123", "get_weather")
	stateEvent := NewStateSnapshotEvent(map[string]any{"counter": 42})
	customEvent := NewCustomEvent("test-event", WithValue("test-value"))

	b.Run("RunStartedEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = runEvent.ToJSON()
		}
	})

	b.Run("TextMessageStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = msgEvent.ToJSON()
		}
	})

	b.Run("ToolCallStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = toolEvent.ToJSON()
		}
	})

	b.Run("StateSnapshotEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = stateEvent.ToJSON()
		}
	})

	b.Run("CustomEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = customEvent.ToJSON()
		}
	})
}

// BenchmarkEventProtobufSerialization benchmarks protobuf serialization
func BenchmarkEventProtobufSerialization(b *testing.B) {
	runEvent := NewRunStartedEvent("thread-123", "run-456")
	msgEvent := NewTextMessageStartEvent("msg-123", WithRole("user"))
	toolEvent := NewToolCallStartEvent("tool-123", "get_weather")
	stateEvent := NewStateSnapshotEvent(map[string]any{"counter": 42})
	customEvent := NewCustomEvent("test-event", WithValue("test-value"))

	b.Run("RunStartedEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = runEvent.ToProtobuf()
		}
	})

	b.Run("TextMessageStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = msgEvent.ToProtobuf()
		}
	})

	b.Run("ToolCallStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = toolEvent.ToProtobuf()
		}
	})

	b.Run("StateSnapshotEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = stateEvent.ToProtobuf()
		}
	})

	b.Run("CustomEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = customEvent.ToProtobuf()
		}
	})
}

// BenchmarkEventJSONDeserialization benchmarks JSON deserialization
func BenchmarkEventJSONDeserialization(b *testing.B) {
	runEventJSON := []byte(`{"type":"RUN_STARTED","timestamp":1672531200000,"threadId":"thread-123","runId":"run-456"}`)
	msgEventJSON := []byte(`{"type":"TEXT_MESSAGE_START","timestamp":1672531200000,"messageId":"msg-123","role":"user"}`)
	toolEventJSON := []byte(`{"type":"TOOL_CALL_START","timestamp":1672531200000,"toolCallId":"tool-123","toolCallName":"get_weather"}`)
	stateEventJSON := []byte(`{"type":"STATE_SNAPSHOT","timestamp":1672531200000,"snapshot":{"counter":42}}`)
	customEventJSON := []byte(`{"type":"CUSTOM","timestamp":1672531200000,"name":"test-event","value":"test-value"}`)

	b.Run("RunStartedEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = EventFromJSON(runEventJSON)
		}
	})

	b.Run("TextMessageStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = EventFromJSON(msgEventJSON)
		}
	})

	b.Run("ToolCallStartEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = EventFromJSON(toolEventJSON)
		}
	})

	b.Run("StateSnapshotEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = EventFromJSON(stateEventJSON)
		}
	})

	b.Run("CustomEvent", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_, _ = EventFromJSON(customEventJSON)
		}
	})
}

// BenchmarkEventSequenceValidation benchmarks sequence validation
func BenchmarkEventSequenceValidation(b *testing.B) {
	// Create a valid sequence
	events := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewTextMessageStartEvent("msg-1", WithRole("user")),
		NewTextMessageContentEvent("msg-1", "Hello"),
		NewTextMessageEndEvent("msg-1"),
		NewToolCallStartEvent("tool-1", "get_weather"),
		NewToolCallArgsEvent("tool-1", "{\"location\": \"SF\"}"),
		NewToolCallEndEvent("tool-1"),
		NewRunFinishedEvent("thread-1", "run-1"),
	}

	b.Run("ValidateSequence", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = ValidateSequence(events)
		}
	})
}

// BenchmarkIDGeneration benchmarks ID generation
func BenchmarkIDGeneration(b *testing.B) {
	b.Run("GenerateRunID", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = GenerateRunID()
		}
	})

	b.Run("GenerateMessageID", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = GenerateMessageID()
		}
	})

	b.Run("GenerateToolCallID", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = GenerateToolCallID()
		}
	})

	b.Run("GenerateThreadID", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = GenerateThreadID()
		}
	})

	b.Run("GenerateStepID", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = GenerateStepID()
		}
	})
}

// BenchmarkMemoryAllocations benchmarks memory allocations
func BenchmarkMemoryAllocations(b *testing.B) {
	b.Run("EventCreationAllocs", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = NewRunStartedEvent("thread-123", "run-456")
		}
	})

	b.Run("EventValidationAllocs", func(b *testing.B) {
		b.ReportAllocs()
		event := NewRunStartedEvent("thread-123", "run-456")
		for i := 0; i < b.N; i++ {
			_ = event.Validate()
		}
	})

	b.Run("EventJSONSerializationAllocs", func(b *testing.B) {
		b.ReportAllocs()
		event := NewRunStartedEvent("thread-123", "run-456")
		for i := 0; i < b.N; i++ {
			_, _ = event.ToJSON()
		}
	})

	b.Run("EventProtobufSerializationAllocs", func(b *testing.B) {
		b.ReportAllocs()
		event := NewRunStartedEvent("thread-123", "run-456")
		for i := 0; i < b.N; i++ {
			_, _ = event.ToProtobuf()
		}
	})
}
