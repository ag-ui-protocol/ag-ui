package events

import (
	"encoding/json"
	"testing"
)

func TestThinkingStartEvent(t *testing.T) {
	t.Run("basic creation", func(t *testing.T) {
		event := NewThinkingStartEvent()

		if event.Type() != EventTypeThinkingStart {
			t.Errorf("expected event type %s, got %s", EventTypeThinkingStart, event.Type())
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("with title", func(t *testing.T) {
		title := "Analyzing request"
		event := NewThinkingStartEvent().WithTitle(title)

		if event.Title == nil || *event.Title != title {
			t.Errorf("expected title %s, got %v", title, event.Title)
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("JSON serialization", func(t *testing.T) {
		title := "Processing"
		event := NewThinkingStartEvent().WithTitle(title)

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(jsonData, &decoded); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}

		if decoded["type"] != string(EventTypeThinkingStart) {
			t.Errorf("expected type %s in JSON, got %v", EventTypeThinkingStart, decoded["type"])
		}

		if decoded["title"] != title {
			t.Errorf("expected title %s in JSON, got %v", title, decoded["title"])
		}
	})

	t.Run("JSON field naming", func(t *testing.T) {
		event := NewThinkingStartEvent().WithTitle("Test")

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		jsonStr := string(jsonData)

		// Check for camelCase field names
		if !contains(jsonStr, `"type"`) {
			t.Error("JSON should contain 'type' field")
		}

		if !contains(jsonStr, `"title"`) {
			t.Error("JSON should contain 'title' field")
		}

		// Should not contain snake_case
		if contains(jsonStr, `"event_type"`) {
			t.Error("JSON should not contain snake_case field names")
		}
	})
}

func TestThinkingEndEvent(t *testing.T) {
	t.Run("basic creation", func(t *testing.T) {
		event := NewThinkingEndEvent()

		if event.Type() != EventTypeThinkingEnd {
			t.Errorf("expected event type %s, got %s", EventTypeThinkingEnd, event.Type())
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("JSON serialization", func(t *testing.T) {
		event := NewThinkingEndEvent()

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(jsonData, &decoded); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}

		if decoded["type"] != string(EventTypeThinkingEnd) {
			t.Errorf("expected type %s in JSON, got %v", EventTypeThinkingEnd, decoded["type"])
		}
	})
}

func TestThinkingTextMessageStartEvent(t *testing.T) {
	t.Run("basic creation", func(t *testing.T) {
		event := NewThinkingTextMessageStartEvent()

		if event.Type() != EventTypeThinkingTextMessageStart {
			t.Errorf("expected event type %s, got %s", EventTypeThinkingTextMessageStart, event.Type())
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("JSON serialization", func(t *testing.T) {
		event := NewThinkingTextMessageStartEvent()

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(jsonData, &decoded); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}

		if decoded["type"] != string(EventTypeThinkingTextMessageStart) {
			t.Errorf("expected type %s in JSON, got %v", EventTypeThinkingTextMessageStart, decoded["type"])
		}
	})
}

func TestThinkingTextMessageContentEvent(t *testing.T) {
	t.Run("basic creation", func(t *testing.T) {
		delta := "Thinking about the problem..."
		event := NewThinkingTextMessageContentEvent(delta)

		if event.Type() != EventTypeThinkingTextMessageContent {
			t.Errorf("expected event type %s, got %s", EventTypeThinkingTextMessageContent, event.Type())
		}

		if event.Delta != delta {
			t.Errorf("expected delta %s, got %s", delta, event.Delta)
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("validation requires delta", func(t *testing.T) {
		event := &ThinkingTextMessageContentEvent{
			BaseEvent: NewBaseEvent(EventTypeThinkingTextMessageContent),
			Delta:     "",
		}

		if err := event.Validate(); err == nil {
			t.Error("expected validation to fail for empty delta")
		}
	})

	t.Run("JSON serialization", func(t *testing.T) {
		delta := "Processing request..."
		event := NewThinkingTextMessageContentEvent(delta)

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(jsonData, &decoded); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}

		if decoded["type"] != string(EventTypeThinkingTextMessageContent) {
			t.Errorf("expected type %s in JSON, got %v", EventTypeThinkingTextMessageContent, decoded["type"])
		}

		if decoded["delta"] != delta {
			t.Errorf("expected delta %s in JSON, got %v", delta, decoded["delta"])
		}
	})

	t.Run("JSON field naming", func(t *testing.T) {
		event := NewThinkingTextMessageContentEvent("test")

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		jsonStr := string(jsonData)

		// Check for correct field names
		if !contains(jsonStr, `"delta"`) {
			t.Error("JSON should contain 'delta' field")
		}
	})
}

func TestThinkingTextMessageEndEvent(t *testing.T) {
	t.Run("basic creation", func(t *testing.T) {
		event := NewThinkingTextMessageEndEvent()

		if event.Type() != EventTypeThinkingTextMessageEnd {
			t.Errorf("expected event type %s, got %s", EventTypeThinkingTextMessageEnd, event.Type())
		}

		if err := event.Validate(); err != nil {
			t.Errorf("validation failed: %v", err)
		}
	})

	t.Run("JSON serialization", func(t *testing.T) {
		event := NewThinkingTextMessageEndEvent()

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("failed to serialize to JSON: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(jsonData, &decoded); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}

		if decoded["type"] != string(EventTypeThinkingTextMessageEnd) {
			t.Errorf("expected type %s in JSON, got %v", EventTypeThinkingTextMessageEnd, decoded["type"])
		}
	})
}

// Helper function to check if a string contains a substring
func contains(s, substr string) bool {
	return len(s) > 0 && len(substr) > 0 &&
		(len(s) >= len(substr)) &&
		(s == substr ||
			(len(s) > len(substr) &&
				(s[:len(substr)] == substr ||
					contains(s[1:], substr))))
}
