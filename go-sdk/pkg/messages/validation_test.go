package messages

import (
	"strings"
	"testing"
)

func TestValidator(t *testing.T) {
	v := NewValidator()

	t.Run("Validate valid messages", func(t *testing.T) {
		messages := []Message{
			NewUserMessage("Valid user message"),
			NewAssistantMessage("Valid assistant message"),
			NewSystemMessage("Valid system message"),
			NewToolMessage("Valid tool result", "call_123"),
			NewDeveloperMessage("Valid developer message"),
		}

		for _, msg := range messages {
			if err := v.ValidateMessage(msg); err != nil {
				t.Errorf("Valid message failed validation: %v", err)
			}
		}
	})

	t.Run("Validate message content length", func(t *testing.T) {
		v := NewValidator(ValidationOptions{
			MaxContentBytes: 100,
		})

		// Create message with content exceeding limit
		longContent := strings.Repeat("a", 101)
		msg := NewUserMessage(longContent)

		if err := v.ValidateMessage(msg); err == nil {
			t.Error("Expected validation error for content exceeding max length")
		}
	})

	t.Run("Validate message name", func(t *testing.T) {
		v := NewValidator()

		// Valid names
		validNames := []string{"user_123", "bot-assistant", "system.main", "TEST_USER"}
		for _, name := range validNames {
			msg := NewUserMessage("Content")
			msg.Name = &name
			if err := v.ValidateMessage(msg); err != nil {
				t.Errorf("Valid name '%s' failed validation: %v", name, err)
			}
		}

		// Invalid names
		invalidNames := []string{"user@123", "bot assistant", "system/main", "user!", ""}
		for _, name := range invalidNames {
			msg := NewUserMessage("Content")
			msg.Name = &name
			if err := v.ValidateMessage(msg); err == nil {
				t.Errorf("Invalid name '%s' should have failed validation", name)
			}
		}
	})

	t.Run("Validate assistant message with tool calls", func(t *testing.T) {
		v := NewValidator()

		// Valid tool calls
		validToolCalls := []ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "get_weather",
					Arguments: `{"location": "NYC"}`,
				},
			},
		}
		msg := NewAssistantMessageWithTools(validToolCalls)
		if err := v.ValidateMessage(msg); err != nil {
			t.Errorf("Valid assistant message with tools failed: %v", err)
		}

		// Invalid tool call - missing ID
		invalidToolCalls1 := []ToolCall{
			{
				Type: "function",
				Function: Function{
					Name:      "get_weather",
					Arguments: `{"location": "NYC"}`,
				},
			},
		}
		msg1 := NewAssistantMessageWithTools(invalidToolCalls1)
		msg1.ToolCalls = invalidToolCalls1 // Override to ensure invalid state
		if err := v.ValidateMessage(msg1); err == nil {
			t.Error("Expected validation error for tool call without ID")
		}

		// Invalid tool call - wrong type
		invalidToolCalls2 := []ToolCall{
			{
				ID:   "call_123",
				Type: "invalid_type",
				Function: Function{
					Name:      "get_weather",
					Arguments: `{"location": "NYC"}`,
				},
			},
		}
		msg2 := NewAssistantMessageWithTools(validToolCalls)
		msg2.ToolCalls = invalidToolCalls2
		if err := v.ValidateMessage(msg2); err == nil {
			t.Error("Expected validation error for invalid tool call type")
		}

		// Invalid tool call - invalid JSON arguments
		invalidToolCalls3 := []ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "get_weather",
					Arguments: `{invalid json}`,
				},
			},
		}
		msg3 := NewAssistantMessageWithTools(validToolCalls)
		msg3.ToolCalls = invalidToolCalls3
		if err := v.ValidateMessage(msg3); err == nil {
			t.Error("Expected validation error for invalid JSON arguments")
		}
	})

	t.Run("Validate tool call limits", func(t *testing.T) {
		v := NewValidator(ValidationOptions{
			MaxToolCalls: 3,
		})

		// Create message with too many tool calls
		toolCalls := make([]ToolCall, 4)
		for i := 0; i < 4; i++ {
			toolCalls[i] = ToolCall{
				ID:   "call_" + string(rune('0'+i)),
				Type: "function",
				Function: Function{
					Name:      "test_func",
					Arguments: "{}",
				},
			}
		}

		msg := NewAssistantMessageWithTools(toolCalls)
		if err := v.ValidateMessage(msg); err == nil {
			t.Error("Expected validation error for exceeding max tool calls")
		}
	})

	t.Run("Validate empty content handling", func(t *testing.T) {
		v := NewValidator(ValidationOptions{
			AllowEmptyContent:  false,
			MaxToolCalls:       100, // Ensure we allow tool calls
			MaxNameLength:      256, // Ensure we allow names
			MaxContentBytes:    1000000,
			MaxArgumentsBytes:  100000,
			StrictRoleCheck:    true,
		})

		// User message without content should fail
		userMsg := &UserMessage{
			BaseMessage: BaseMessage{
				ID:   "test",
				Role: RoleUser,
			},
		}
		if err := v.ValidateMessage(userMsg); err == nil {
			t.Error("Expected validation error for user message without content")
		}

		// Assistant message without content but with tool calls should pass
		assistantMsg := NewAssistantMessageWithTools([]ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: Function{
					Name:      "test",
					Arguments: "{}",
				},
			},
		})
		assistantMsg.Content = nil
		if err := v.ValidateMessage(assistantMsg); err != nil {
			t.Errorf("Assistant message with tool calls should pass without content: %v", err)
		}

		// Assistant message without content or tool calls should fail
		emptyAssistant := &AssistantMessage{
			BaseMessage: BaseMessage{
				ID:   "test",
				Role: RoleAssistant,
			},
		}
		if err := v.ValidateMessage(emptyAssistant); err == nil {
			t.Error("Expected validation error for assistant message without content or tool calls")
		}
	})

	t.Run("Validate message list", func(t *testing.T) {
		v := NewValidator()

		// Valid message list with tool usage
		validList := MessageList{
			NewUserMessage("Call a function"),
			NewAssistantMessageWithTools([]ToolCall{
				{
					ID:   "call_123",
					Type: "function",
					Function: Function{
						Name:      "test",
						Arguments: "{}",
					},
				},
			}),
			NewToolMessage("Function result", "call_123"),
		}

		if err := v.ValidateMessageList(validList); err != nil {
			t.Errorf("Valid message list failed validation: %v", err)
		}

		// Invalid list - tool message references unknown tool call
		invalidList := MessageList{
			NewUserMessage("Call a function"),
			NewToolMessage("Function result", "call_unknown"),
		}

		if err := v.ValidateMessageList(invalidList); err == nil {
			t.Error("Expected validation error for tool message with unknown tool call ID")
		}
	})

	t.Run("Validate UTF-8 content", func(t *testing.T) {
		v := NewValidator()

		// Valid UTF-8
		validContent := "Hello 世界! 🌍"
		msg := NewUserMessage(validContent)
		if err := v.ValidateMessage(msg); err != nil {
			t.Errorf("Valid UTF-8 content failed validation: %v", err)
		}

		// Invalid UTF-8 would be caught during message creation in practice
		// but we can test control characters
		invalidContent := "Hello\x00World" // Null character
		msg2 := NewUserMessage(invalidContent)
		if err := v.ValidateMessage(msg2); err == nil {
			t.Error("Expected validation error for content with control characters")
		}
	})
}

func TestSanitizer(t *testing.T) {
	s := NewSanitizer()

	t.Run("Sanitize HTML content", func(t *testing.T) {
		content := "Hello <b>world</b>! <script>alert('xss')</script>"
		sanitized := s.SanitizeContent(content)

		if strings.Contains(sanitized, "<b>") {
			t.Error("Expected HTML tags to be removed")
		}
		if strings.Contains(sanitized, "<script>") {
			t.Error("Expected script tags to be removed")
		}
		if !strings.Contains(sanitized, "Hello world!") {
			t.Errorf("Expected sanitized content to contain 'Hello world!', got: %s", sanitized)
		}
	})

	t.Run("Normalize newlines", func(t *testing.T) {
		content := "Line1\r\nLine2\rLine3\n\n\n\n\nLine4"
		s := NewSanitizer(SanitizationOptions{
			NormalizeNewlines:      true,
			MaxConsecutiveNewlines: 2,
		})
		sanitized := s.SanitizeContent(content)

		// Count newlines
		newlineCount := strings.Count(sanitized, "\n")
		if newlineCount > 4 { // 3 line breaks = 4 lines
			t.Errorf("Expected max 2 consecutive newlines, content: %q", sanitized)
		}

		// Check all line types were normalized
		if strings.Contains(sanitized, "\r") {
			t.Error("Expected all \\r to be normalized to \\n")
		}
	})

	t.Run("Trim whitespace", func(t *testing.T) {
		content := "  \n\t  Hello World  \t\n  "
		sanitized := s.SanitizeContent(content)

		if sanitized != "Hello World" {
			t.Errorf("Expected trimmed content 'Hello World', got: %q", sanitized)
		}
	})

	t.Run("Sanitize message", func(t *testing.T) {
		msg := NewUserMessage("<p>Hello <script>alert('xss')</script>world!</p>")

		if err := s.SanitizeMessage(msg); err != nil {
			t.Errorf("Failed to sanitize message: %v", err)
		}

		content := msg.GetContent()
		if content == nil {
			t.Fatal("Expected content after sanitization")
		}

		if strings.Contains(*content, "<") || strings.Contains(*content, ">") {
			t.Errorf("Expected HTML to be removed, got: %s", *content)
		}
	})

	t.Run("Sanitize message list", func(t *testing.T) {
		messages := MessageList{
			NewUserMessage("<b>Bold</b> text"),
			NewAssistantMessage("Response with <script>code</script>"),
			NewSystemMessage("System <i>message</i>"),
		}

		if err := s.SanitizeMessageList(messages); err != nil {
			t.Errorf("Failed to sanitize message list: %v", err)
		}

		// Check all messages were sanitized
		for i, msg := range messages {
			content := msg.GetContent()
			if content != nil && strings.Contains(*content, "<") {
				t.Errorf("Message %d still contains HTML: %s", i, *content)
			}
		}
	})

	t.Run("Custom sanitization options", func(t *testing.T) {
		s := NewSanitizer(SanitizationOptions{
			RemoveHTML:        false,
			RemoveScripts:     true,
			TrimWhitespace:    false,
			NormalizeNewlines: false,
		})

		content := "  <b>Bold</b> with <script>alert()</script>  "
		sanitized := s.SanitizeContent(content)

		// HTML should remain
		if !strings.Contains(sanitized, "<b>") {
			t.Error("Expected HTML to remain when RemoveHTML is false")
		}

		// Scripts should be removed
		if strings.Contains(sanitized, "<script>") {
			t.Error("Expected scripts to be removed when RemoveScripts is true")
		}

		// Whitespace should remain
		if !strings.HasPrefix(sanitized, "  ") {
			t.Error("Expected whitespace to remain when TrimWhitespace is false")
		}
	})
}

func TestValidateAndSanitize(t *testing.T) {
	t.Run("Combined validation and sanitization", func(t *testing.T) {
		msg := NewUserMessage("<p>Hello world!</p>")

		validationOpts := DefaultValidationOptions()
		sanitizationOpts := DefaultSanitizationOptions()

		if err := ValidateAndSanitize(msg, validationOpts, sanitizationOpts); err != nil {
			t.Errorf("Failed to validate and sanitize: %v", err)
		}

		content := msg.GetContent()
		if content == nil {
			t.Fatal("Expected content after sanitization")
		}

		// Check HTML was removed
		if strings.Contains(*content, "<p>") {
			t.Error("Expected HTML to be removed")
		}

		// Check content is still valid
		if *content != "Hello world!" {
			t.Errorf("Expected 'Hello world!', got: %s", *content)
		}
	})

	t.Run("Sanitization makes content valid", func(t *testing.T) {
		// Create message with problematic content
		msg := NewUserMessage("  \n\n\n\nContent\n\n\n\n  ")

		validationOpts := ValidationOptions{
			MaxContentBytes: 100,
		}
		sanitizationOpts := SanitizationOptions{
			TrimWhitespace:         true,
			NormalizeNewlines:      true,
			MaxConsecutiveNewlines: 1,
		}

		if err := ValidateAndSanitize(msg, validationOpts, sanitizationOpts); err != nil {
			t.Errorf("Failed to validate and sanitize: %v", err)
		}

		content := msg.GetContent()
		if content == nil || *content != "Content" {
			t.Errorf("Expected sanitized content 'Content', got: %v", content)
		}
	})
}

func TestValidateConversationFlow(t *testing.T) {
	t.Run("Valid conversation flow", func(t *testing.T) {
		messages := MessageList{
			NewSystemMessage("You are helpful."),
			NewUserMessage("Hello"),
			NewAssistantMessage("Hi! How can I help?"),
			NewUserMessage("What's the weather?"),
			NewAssistantMessageWithTools([]ToolCall{
				{
					ID:   "call_123",
					Type: "function",
					Function: Function{
						Name:      "get_weather",
						Arguments: "{}",
					},
				},
			}),
			NewToolMessage("Sunny and 72°F", "call_123"),
			NewAssistantMessage("The weather is sunny and 72°F."),
		}

		if err := ValidateConversationFlow(messages); err != nil {
			t.Errorf("Valid conversation flow failed validation: %v", err)
		}
	})

	t.Run("Invalid flow - tool message without assistant", func(t *testing.T) {
		messages := MessageList{
			NewUserMessage("Hello"),
			NewToolMessage("Result", "call_123"), // No preceding assistant message
		}

		if err := ValidateConversationFlow(messages); err == nil {
			t.Error("Expected validation error for tool message without preceding assistant message")
		}
	})

	t.Run("Invalid flow - tool message after assistant without tools", func(t *testing.T) {
		messages := MessageList{
			NewUserMessage("Hello"),
			NewAssistantMessage("Hi!"), // No tool calls
			NewToolMessage("Result", "call_123"),
		}

		if err := ValidateConversationFlow(messages); err == nil {
			t.Error("Expected validation error for tool message after assistant without tool calls")
		}
	})
}
