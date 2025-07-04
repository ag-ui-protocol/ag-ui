package messages

import (
	"encoding/json"
	"testing"
)

func TestMessageRoleValidation(t *testing.T) {
	tests := []struct {
		name    string
		role    MessageRole
		wantErr bool
	}{
		{"Valid user role", RoleUser, false},
		{"Valid assistant role", RoleAssistant, false},
		{"Valid system role", RoleSystem, false},
		{"Valid tool role", RoleTool, false},
		{"Valid developer role", RoleDeveloper, false},
		{"Invalid role", MessageRole("invalid"), true},
		{"Empty role", MessageRole(""), true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.role.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("MessageRole.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestUserMessage(t *testing.T) {
	t.Run("Create and validate user message", func(t *testing.T) {
		msg := NewUserMessage("Hello, AI!")

		// Check basic properties
		if msg.Role != RoleUser {
			t.Errorf("Expected role %s, got %s", RoleUser, msg.Role)
		}

		if msg.Content == nil || *msg.Content != "Hello, AI!" {
			t.Errorf("Expected content 'Hello, AI!', got %v", msg.Content)
		}

		if msg.ID == "" {
			t.Error("Expected message to have an ID")
		}

		if msg.Metadata == nil || msg.Metadata.Timestamp.IsZero() {
			t.Error("Expected message to have metadata with timestamp")
		}

		// Validate
		if err := msg.Validate(); err != nil {
			t.Errorf("Valid user message failed validation: %v", err)
		}
	})

	t.Run("User message requires content", func(t *testing.T) {
		msg := &UserMessage{
			BaseMessage: BaseMessage{
				Role: RoleUser,
			},
		}

		if err := msg.Validate(); err == nil {
			t.Error("Expected validation error for user message without content")
		}
	})
}

func TestAssistantMessage(t *testing.T) {
	t.Run("Create assistant message with content", func(t *testing.T) {
		msg := NewAssistantMessage("I can help with that!")

		if msg.Role != RoleAssistant {
			t.Errorf("Expected role %s, got %s", RoleAssistant, msg.Role)
		}

		if err := msg.Validate(); err != nil {
			t.Errorf("Valid assistant message failed validation: %v", err)
		}
	})

	t.Run("Create assistant message with tool calls", func(t *testing.T) {
		toolCalls := []ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "get_weather",
					Arguments: `{"location": "San Francisco"}`,
				},
			},
		}

		msg := NewAssistantMessageWithTools(toolCalls)

		if len(msg.ToolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %d", len(msg.ToolCalls))
		}

		if err := msg.Validate(); err != nil {
			t.Errorf("Valid assistant message with tools failed validation: %v", err)
		}
	})

	t.Run("Assistant message requires content or tool calls", func(t *testing.T) {
		msg := &AssistantMessage{
			BaseMessage: BaseMessage{
				Role: RoleAssistant,
			},
		}

		if err := msg.Validate(); err == nil {
			t.Error("Expected validation error for assistant message without content or tool calls")
		}
	})
}

func TestSystemMessage(t *testing.T) {
	t.Run("Create and validate system message", func(t *testing.T) {
		msg := NewSystemMessage("You are a helpful assistant.")

		if msg.Role != RoleSystem {
			t.Errorf("Expected role %s, got %s", RoleSystem, msg.Role)
		}

		if err := msg.Validate(); err != nil {
			t.Errorf("Valid system message failed validation: %v", err)
		}
	})
}

func TestToolMessage(t *testing.T) {
	t.Run("Create and validate tool message", func(t *testing.T) {
		msg := NewToolMessage("Weather: Sunny, 72°F", "call_123")

		if msg.Role != RoleTool {
			t.Errorf("Expected role %s, got %s", RoleTool, msg.Role)
		}

		if msg.Content == nil || *msg.Content != "Weather: Sunny, 72°F" {
			if msg.Content == nil {
				t.Errorf("Expected content 'Weather: Sunny, 72°F', got nil")
			} else {
				t.Errorf("Expected content 'Weather: Sunny, 72°F', got %s", *msg.Content)
			}
		}

		if msg.ToolCallID != "call_123" {
			t.Errorf("Expected tool call ID 'call_123', got %s", msg.ToolCallID)
		}

		if err := msg.Validate(); err != nil {
			t.Errorf("Valid tool message failed validation: %v", err)
		}
	})

	t.Run("Tool message requires content and toolCallId", func(t *testing.T) {
		// Missing content
		msg1 := &ToolMessage{
			BaseMessage: BaseMessage{
				Role: RoleTool,
			},
			ToolCallID: "call_123",
		}

		if err := msg1.Validate(); err == nil {
			t.Error("Expected validation error for tool message without content")
		}

		// Missing toolCallId
		content := "Result"
		msg2 := &ToolMessage{
			BaseMessage: BaseMessage{
				Role:    RoleTool,
				Content: &content,
			},
		}

		if err := msg2.Validate(); err == nil {
			t.Error("Expected validation error for tool message without toolCallId")
		}
	})
}

func TestDeveloperMessage(t *testing.T) {
	t.Run("Create and validate developer message", func(t *testing.T) {
		msg := NewDeveloperMessage("Debug: Processing request")

		if msg.Role != RoleDeveloper {
			t.Errorf("Expected role %s, got %s", RoleDeveloper, msg.Role)
		}

		if err := msg.Validate(); err != nil {
			t.Errorf("Valid developer message failed validation: %v", err)
		}
	})
}

func TestMessageListValidation(t *testing.T) {
	t.Run("Valid message list", func(t *testing.T) {
		messages := MessageList{
			NewSystemMessage("You are helpful."),
			NewUserMessage("Hello!"),
			NewAssistantMessage("Hi there!"),
		}

		if err := messages.Validate(); err != nil {
			t.Errorf("Valid message list failed validation: %v", err)
		}
	})

	t.Run("Invalid message in list", func(t *testing.T) {
		messages := MessageList{
			NewUserMessage("Hello!"),
			&UserMessage{BaseMessage: BaseMessage{Role: RoleUser}}, // Missing content
		}

		if err := messages.Validate(); err == nil {
			t.Error("Expected validation error for message list with invalid message")
		}
	})
}

func TestMessageSerialization(t *testing.T) {
	t.Run("Serialize user message", func(t *testing.T) {
		msg := NewUserMessage("Test message")
		msg.Name = stringPtr("test_user")

		data, err := msg.ToJSON()
		if err != nil {
			t.Fatalf("Failed to serialize message: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("Failed to unmarshal message: %v", err)
		}

		if decoded["role"] != "user" {
			t.Errorf("Expected role 'user', got %v", decoded["role"])
		}

		if decoded["content"] != "Test message" {
			t.Errorf("Expected content 'Test message', got %v", decoded["content"])
		}

		if decoded["name"] != "test_user" {
			t.Errorf("Expected name 'test_user', got %v", decoded["name"])
		}
	})

	t.Run("Serialize assistant message with tool calls", func(t *testing.T) {
		msg := NewAssistantMessageWithTools([]ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "test_function",
					Arguments: `{"key": "value"}`,
				},
			},
		})

		data, err := msg.ToJSON()
		if err != nil {
			t.Fatalf("Failed to serialize message: %v", err)
		}

		var decoded map[string]interface{}
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("Failed to unmarshal message: %v", err)
		}

		toolCalls, ok := decoded["toolCalls"].([]interface{})
		if !ok || len(toolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %v", decoded["toolCalls"])
		}
	})
}

func TestConversation(t *testing.T) {
	t.Run("Create and manage conversation", func(t *testing.T) {
		conv := NewConversation()

		// Add messages
		messages := []Message{
			NewSystemMessage("You are helpful."),
			NewUserMessage("Hello!"),
			NewAssistantMessage("Hi! How can I help?"),
		}

		for _, msg := range messages {
			if err := conv.AddMessage(msg); err != nil {
				t.Errorf("Failed to add message: %v", err)
			}
		}

		if len(conv.Messages) != 3 {
			t.Errorf("Expected 3 messages, got %d", len(conv.Messages))
		}

		// Test GetLastMessage
		last := conv.GetLastMessage()
		if last.GetRole() != RoleAssistant {
			t.Errorf("Expected last message role %s, got %s", RoleAssistant, last.GetRole())
		}

		// Test GetLastUserMessage
		lastUser := conv.GetLastUserMessage()
		if content := lastUser.GetContent(); content == nil || *content != "Hello!" {
			t.Errorf("Expected last user message 'Hello!', got %v", content)
		}

		// Test GetMessagesByRole
		systemMessages := conv.GetMessagesByRole(RoleSystem)
		if len(systemMessages) != 1 {
			t.Errorf("Expected 1 system message, got %d", len(systemMessages))
		}
	})

	t.Run("Conversation message limits", func(t *testing.T) {
		conv := NewConversation(ConversationOptions{
			MaxMessages:            3,
			PreserveSystemMessages: false,
		})

		// Add more than limit
		for i := 0; i < 5; i++ {
			msg := NewUserMessage("Message " + string(rune('0'+i)))
			if err := conv.AddMessage(msg); err != nil {
				t.Errorf("Failed to add message: %v", err)
			}
		}

		if len(conv.Messages) != 3 {
			t.Errorf("Expected 3 messages after pruning, got %d", len(conv.Messages))
		}

		// Check that oldest messages were removed
		firstContent := conv.Messages[0].GetContent()
		if firstContent == nil || *firstContent != "Message 2" {
			t.Errorf("Expected first message to be 'Message 2', got %v", firstContent)
		}
	})

	t.Run("Preserve system messages during pruning", func(t *testing.T) {
		conv := NewConversation(ConversationOptions{
			MaxMessages:            3,
			PreserveSystemMessages: true,
		})

		// Add system message
		conv.AddMessage(NewSystemMessage("System prompt"))

		// Add more user messages than limit
		for i := 0; i < 5; i++ {
			msg := NewUserMessage("Message " + string(rune('0'+i)))
			if err := conv.AddMessage(msg); err != nil {
				t.Errorf("Failed to add message: %v", err)
			}
		}

		if len(conv.Messages) != 3 {
			t.Errorf("Expected 3 messages after pruning, got %d", len(conv.Messages))
		}

		// Check that system message is preserved
		if conv.Messages[0].GetRole() != RoleSystem {
			t.Error("Expected system message to be preserved")
		}

		// Check that we have the 2 most recent user messages
		lastContent := conv.Messages[2].GetContent()
		if lastContent == nil || *lastContent != "Message 4" {
			t.Errorf("Expected last message to be 'Message 4', got %v", lastContent)
		}
	})
}

func TestMessageContent(t *testing.T) {
	t.Run("Create text content", func(t *testing.T) {
		content := NewTextContent("Hello, world!")

		if content.Type != "text" {
			t.Errorf("Expected type 'text', got %s", content.Type)
		}

		if content.Text != "Hello, world!" {
			t.Errorf("Expected text 'Hello, world!', got %s", content.Text)
		}
	})

	t.Run("Create data content", func(t *testing.T) {
		data := map[string]string{
			"image": "base64data",
			"type":  "png",
		}

		content, err := NewDataContent("image", data)
		if err != nil {
			t.Fatalf("Failed to create data content: %v", err)
		}

		if content.Type != "image" {
			t.Errorf("Expected type 'image', got %s", content.Type)
		}

		// Verify data can be unmarshaled
		var decoded map[string]string
		if err := json.Unmarshal(content.Data, &decoded); err != nil {
			t.Fatalf("Failed to unmarshal data: %v", err)
		}

		if decoded["type"] != "png" {
			t.Errorf("Expected type 'png' in data, got %s", decoded["type"])
		}
	})
}

// Helper function
func stringPtr(s string) *string {
	return &s
}
