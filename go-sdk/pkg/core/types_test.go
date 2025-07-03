package core

import (
	"context"
	"testing"
	"time"
)

func TestEventInterface(t *testing.T) {
	t.Run("MessageEvent", func(t *testing.T) {
		data := MessageData{
			Content: "Hello, world!",
			Sender:  "test-user",
		}

		event := NewEvent("msg-123", "message", data)

		if got := event.ID(); got != "msg-123" {
			t.Errorf("ID() = %v, want %v", got, "msg-123")
		}

		if got := event.Type(); got != "message" {
			t.Errorf("Type() = %v, want %v", got, "message")
		}

		if event.Timestamp().IsZero() {
			t.Error("Timestamp() should not be zero")
		}

		if got := event.Data().Content; got != "Hello, world!" {
			t.Errorf("Data().Content = %v, want %v", got, "Hello, world!")
		}

		if got := event.Data().Sender; got != "test-user" {
			t.Errorf("Data().Sender = %v, want %v", got, "test-user")
		}
	})

	t.Run("StateEvent", func(t *testing.T) {
		data := StateData{
			Key:   "user.name",
			Value: "John Doe",
		}

		event := NewEvent("state-456", "state_update", data)

		if got := event.ID(); got != "state-456" {
			t.Errorf("ID() = %v, want %v", got, "state-456")
		}

		if got := event.Type(); got != "state_update" {
			t.Errorf("Type() = %v, want %v", got, "state_update")
		}

		if got := event.Data().Key; got != "user.name" {
			t.Errorf("Data().Key = %v, want %v", got, "user.name")
		}

		if got := event.Data().Value; got != "John Doe" {
			t.Errorf("Data().Value = %v, want %v", got, "John Doe")
		}
	})

	t.Run("ToolEvent", func(t *testing.T) {
		data := ToolData{
			ToolName: "calculator",
			Args: map[string]interface{}{
				"operation": "add",
				"x":         5,
				"y":         3,
			},
			Result: 8,
		}

		event := NewEvent("tool-789", "tool_call", data)

		if got := event.Type(); got != "tool_call" {
			t.Errorf("Type() = %v, want %v", got, "tool_call")
		}

		if got := event.Data().ToolName; got != "calculator" {
			t.Errorf("Data().ToolName = %v, want %v", got, "calculator")
		}

		if got := event.Data().Args["operation"]; got != "add" {
			t.Errorf("Data().Args[operation] = %v, want %v", got, "add")
		}
	})
}

func TestAgentInterface(t *testing.T) {
	// Mock agent for testing
	mockAgent := &mockAgent{
		name: "test-agent",
		desc: "Test agent for unit tests",
	}

	t.Run("Agent Name", func(t *testing.T) {
		if got := mockAgent.Name(); got != "test-agent" {
			t.Errorf("Name() = %v, want %v", got, "test-agent")
		}
	})

	t.Run("Agent Description", func(t *testing.T) {
		if got := mockAgent.Description(); got != "Test agent for unit tests" {
			t.Errorf("Description() = %v, want %v", got, "Test agent for unit tests")
		}
	})

	t.Run("Agent HandleEvent", func(t *testing.T) {
		ctx := context.Background()
		event := NewEvent("test-123", "message", MessageData{
			Content: "test message",
			Sender:  "user",
		})

		responses, err := mockAgent.HandleEvent(ctx, event)
		if err != nil {
			t.Errorf("HandleEvent() error = %v, want nil", err)
		}

		if len(responses) != 1 {
			t.Errorf("HandleEvent() returned %d responses, want 1", len(responses))
		}

		// Verify the response is a message event
		if response, ok := responses[0].(Event[MessageData]); ok {
			if response.Type() != "response" {
				t.Errorf("Response type = %v, want %v", response.Type(), "response")
			}
			if !contains(response.Data().Content, "Echo:") {
				t.Errorf("Response content should contain 'Echo:', got: %v", response.Data().Content)
			}
		} else {
			t.Error("Response should be a MessageEvent")
		}
	})
}

func TestStreamConfig(t *testing.T) {
	config := StreamConfig{
		BufferSize:        100,
		Timeout:           30 * time.Second,
		EnableCompression: true,
	}

	if config.BufferSize != 100 {
		t.Errorf("BufferSize = %v, want %v", config.BufferSize, 100)
	}

	if config.Timeout != 30*time.Second {
		t.Errorf("Timeout = %v, want %v", config.Timeout, 30*time.Second)
	}

	if !config.EnableCompression {
		t.Error("EnableCompression should be true")
	}
}

// Mock implementations for testing
type mockAgent struct {
	name string
	desc string
}

func (m *mockAgent) Name() string        { return m.name }
func (m *mockAgent) Description() string { return m.desc }

func (m *mockAgent) HandleEvent(ctx context.Context, event interface{}) ([]interface{}, error) {
	// Type assert to MessageEvent and create a response
	if msgEvent, ok := event.(Event[MessageData]); ok {
		response := NewEvent("response-"+msgEvent.ID(), "response", MessageData{
			Content: "Echo: " + msgEvent.Data().Content,
			Sender:  m.name,
		})
		return []interface{}{response}, nil
	}
	return nil, nil
}

// Helper function
func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[:len(substr)] == substr ||
		len(s) > len(substr) && containsRecursive(s[1:], substr)
}

func containsRecursive(s, substr string) bool {
	if len(s) < len(substr) {
		return false
	}
	if s[:len(substr)] == substr {
		return true
	}
	return containsRecursive(s[1:], substr)
}
