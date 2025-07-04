package providers

import (
	"testing"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

func TestAnthropicConverter(t *testing.T) {
	converter := NewAnthropicConverter()

	t.Run("Convert simple messages to Anthropic format", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewSystemMessage("You are a helpful assistant."),
			messages.NewUserMessage("Hello!"),
			messages.NewAssistantMessage("Hi there! How can I help you?"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request, ok := result.(AnthropicRequest)
		if !ok {
			t.Fatalf("Expected AnthropicRequest, got %T", result)
		}

		// Check system prompt
		if request.System != "You are a helpful assistant." {
			t.Errorf("Expected system prompt, got %s", request.System)
		}

		// Check conversation messages
		if len(request.Messages) != 2 {
			t.Errorf("Expected 2 conversation messages, got %d", len(request.Messages))
		}

		// Check roles
		expectedRoles := []string{"user", "assistant"}
		for i, msg := range request.Messages {
			if msg.Role != expectedRoles[i] {
				t.Errorf("Message %d: expected role %s, got %s", i, expectedRoles[i], msg.Role)
			}
		}
	})

	t.Run("Convert assistant message with tool calls", func(t *testing.T) {
		toolCalls := []messages.ToolCall{
			{
				ID:   "toolu_abc123",
				Type: "function",
				Function: messages.Function{
					Name:      "get_weather",
					Arguments: `{"location": "San Francisco", "unit": "celsius"}`,
				},
			},
		}

		msg := messages.NewAssistantMessageWithTools(toolCalls)
		msgs := messages.MessageList{msg}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		if len(request.Messages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(request.Messages))
		}

		anthropicMsg := request.Messages[0]
		if len(anthropicMsg.Content) != 1 {
			t.Fatalf("Expected 1 content block, got %d", len(anthropicMsg.Content))
		}

		content := anthropicMsg.Content[0]
		if content.Type != "tool_use" {
			t.Errorf("Expected content type 'tool_use', got %s", content.Type)
		}
		if content.ID == nil || *content.ID != "toolu_abc123" {
			t.Error("Expected tool use ID 'toolu_abc123'")
		}
		if content.Name == nil || *content.Name != "get_weather" {
			t.Error("Expected tool name 'get_weather'")
		}
	})

	t.Run("Convert tool message to tool_result", func(t *testing.T) {
		// Create a converter that allows standalone tool messages for testing
		testConverter := NewAnthropicConverter().WithValidationOptions(ConversionValidationOptions{
			AllowStandaloneToolMessages: true,
		})
		
		msgs := messages.MessageList{
			messages.NewToolMessage("The weather in San Francisco is 18°C and sunny.", "toolu_abc123"),
		}

		result, err := testConverter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		if len(request.Messages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(request.Messages))
		}

		anthropicMsg := request.Messages[0]
		if anthropicMsg.Role != "user" {
			t.Errorf("Expected role 'user' for tool result, got %s", anthropicMsg.Role)
		}

		if len(anthropicMsg.Content) != 1 {
			t.Fatalf("Expected 1 content block, got %d", len(anthropicMsg.Content))
		}

		content := anthropicMsg.Content[0]
		if content.Type != "tool_result" {
			t.Errorf("Expected content type 'tool_result', got %s", content.Type)
		}
		if content.ToolUseID == nil || *content.ToolUseID != "toolu_abc123" {
			t.Error("Expected tool_use_id 'toolu_abc123'")
		}
	})

	t.Run("Convert developer message", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewDeveloperMessage("Debug: Processing request"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		if len(request.Messages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(request.Messages))
		}

		anthropicMsg := request.Messages[0]
		if anthropicMsg.Role != "assistant" {
			t.Errorf("Expected role 'assistant', got %s", anthropicMsg.Role)
		}

		content := anthropicMsg.Content[0]
		if content.Text == nil || *content.Text != "[Developer Message] Debug: Processing request" {
			t.Error("Expected developer message prefix")
		}
	})

	t.Run("Combine multiple system messages", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewSystemMessage("You are helpful."),
			messages.NewSystemMessage("Be concise."),
			messages.NewUserMessage("Hello"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		expectedSystem := "You are helpful.\n\nBe concise."
		if request.System != expectedSystem {
			t.Errorf("Expected combined system prompt '%s', got '%s'", expectedSystem, request.System)
		}
	})

	t.Run("Convert from Anthropic format", func(t *testing.T) {
		request := AnthropicRequest{
			System: "You are helpful.",
			Messages: []AnthropicMessage{
				{
					Role: "user",
					Content: []AnthropicContent{
						{
							Type: "text",
							Text: stringPtr("What's the weather?"),
						},
					},
				},
				{
					Role: "assistant",
					Content: []AnthropicContent{
						{
							Type: "text",
							Text: stringPtr("I'll check the weather for you."),
						},
						{
							Type: "tool_use",
							ID:   stringPtr("toolu_123"),
							Name: stringPtr("get_weather"),
							Input: map[string]interface{}{
								"location": "NYC",
							},
						},
					},
				},
				{
					Role: "user",
					Content: []AnthropicContent{
						{
							Type:      "tool_result",
							ToolUseID: stringPtr("toolu_123"),
							Content:   stringPtr("72°F and sunny"),
						},
					},
				},
			},
		}

		msgs, err := converter.FromProviderFormat(request)
		if err != nil {
			t.Fatalf("Failed to convert from Anthropic format: %v", err)
		}

		if len(msgs) != 4 {
			t.Errorf("Expected 4 messages, got %d", len(msgs))
		}

		// Check message types
		if _, ok := msgs[0].(*messages.SystemMessage); !ok {
			t.Errorf("Expected SystemMessage, got %T", msgs[0])
		}
		if _, ok := msgs[1].(*messages.UserMessage); !ok {
			t.Errorf("Expected UserMessage, got %T", msgs[1])
		}
		if _, ok := msgs[2].(*messages.AssistantMessage); !ok {
			t.Errorf("Expected AssistantMessage, got %T", msgs[2])
		}
		if _, ok := msgs[3].(*messages.ToolMessage); !ok {
			t.Errorf("Expected ToolMessage, got %T", msgs[3])
		}

		// Check assistant message has both content and tool calls
		assistantMsg := msgs[2].(*messages.AssistantMessage)
		if assistantMsg.Content == nil || *assistantMsg.Content != "I'll check the weather for you." {
			t.Error("Expected assistant message content")
		}
		if len(assistantMsg.ToolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %d", len(assistantMsg.ToolCalls))
		}
	})

	t.Run("Convert developer message from Anthropic", func(t *testing.T) {
		request := AnthropicRequest{
			Messages: []AnthropicMessage{
				{
					Role: "assistant",
					Content: []AnthropicContent{
						{
							Type: "text",
							Text: stringPtr("[Developer Message] Debug info"),
						},
					},
				},
			},
		}

		msgs, err := converter.FromProviderFormat(request)
		if err != nil {
			t.Fatalf("Failed to convert from Anthropic format: %v", err)
		}

		if len(msgs) != 1 {
			t.Errorf("Expected 1 message, got %d", len(msgs))
		}

		if devMsg, ok := msgs[0].(*messages.DeveloperMessage); !ok {
			t.Errorf("Expected DeveloperMessage, got %T", msgs[0])
		} else {
			if content := devMsg.GetContent(); content == nil || *content != "Debug info" {
				t.Errorf("Expected content 'Debug info', got %v", content)
			}
		}
	})

	t.Run("Streaming event processing", func(t *testing.T) {
		state := NewAnthropicStreamingState()

		// Process text content delta
		event1 := AnthropicStreamEvent{
			Type:  "content_block_delta",
			Index: intPtr(0),
			Delta: &AnthropicDelta{
				Type: stringPtr("text"),
				Text: stringPtr("Hello"),
			},
		}
		msg1, err := converter.ProcessStreamEvent(state, event1)
		if err != nil {
			t.Fatalf("Failed to process event: %v", err)
		}
		if content := msg1.GetContent(); content == nil || *content != "Hello" {
			t.Errorf("Expected content 'Hello', got %v", content)
		}

		// Process additional text
		event2 := AnthropicStreamEvent{
			Type:  "content_block_delta",
			Index: intPtr(0),
			Delta: &AnthropicDelta{
				Type: stringPtr("text"),
				Text: stringPtr(" world!"),
			},
		}
		msg2, err := converter.ProcessStreamEvent(state, event2)
		if err != nil {
			t.Fatalf("Failed to process event: %v", err)
		}
		if content := msg2.GetContent(); content == nil || *content != "Hello world!" {
			t.Errorf("Expected content 'Hello world!', got %v", content)
		}

		// Process tool use delta
		event3 := AnthropicStreamEvent{
			Type:  "content_block_delta",
			Index: intPtr(1),
			Delta: &AnthropicDelta{
				Type:      stringPtr("tool_use"),
				ToolUseID: stringPtr("toolu_123"),
				Name:      stringPtr("get_weather"),
				Input:     stringPtr(`{"location":`),
			},
		}
		_, err = converter.ProcessStreamEvent(state, event3)
		if err != nil {
			t.Fatalf("Failed to process event: %v", err)
		}

		// Complete tool input
		event4 := AnthropicStreamEvent{
			Type:  "content_block_delta",
			Index: intPtr(1),
			Delta: &AnthropicDelta{
				Type:  stringPtr("tool_use"),
				Input: stringPtr(`"NYC"}`),
			},
		}
		_, err = converter.ProcessStreamEvent(state, event4)
		if err != nil {
			t.Fatalf("Failed to process event: %v", err)
		}

		// Finalize
		event5 := AnthropicStreamEvent{
			Type: "content_block_stop",
		}
		msg5, err := converter.ProcessStreamEvent(state, event5)
		if err != nil {
			t.Fatalf("Failed to process event: %v", err)
		}

		if len(msg5.ToolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %d", len(msg5.ToolCalls))
		}
		tc := msg5.ToolCalls[0]
		if tc.Function.Arguments != `{"location":"NYC"}` {
			t.Errorf("Expected complete arguments, got %s", tc.Function.Arguments)
		}
	})
}

func TestAnthropicConverterEdgeCases(t *testing.T) {
	converter := NewAnthropicConverter()

	t.Run("Handle mixed content types", func(t *testing.T) {
		// Create assistant message with both text and tool use
		content := "Let me check that for you."
		assistantMsg := messages.NewAssistantMessage(content)
		assistantMsg.ToolCalls = []messages.ToolCall{
			{
				ID:   "toolu_123",
				Type: "function",
				Function: messages.Function{
					Name:      "search",
					Arguments: `{"query": "test"}`,
				},
			},
		}

		msgs := messages.MessageList{assistantMsg}
		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		anthropicMsg := request.Messages[0]

		// Should have 2 content blocks: text and tool_use
		if len(anthropicMsg.Content) != 2 {
			t.Errorf("Expected 2 content blocks, got %d", len(anthropicMsg.Content))
		}

		// Verify content types
		if anthropicMsg.Content[0].Type != "text" {
			t.Errorf("Expected first content to be text, got %s", anthropicMsg.Content[0].Type)
		}
		if anthropicMsg.Content[1].Type != "tool_use" {
			t.Errorf("Expected second content to be tool_use, got %s", anthropicMsg.Content[1].Type)
		}
	})

	t.Run("Handle invalid tool arguments JSON", func(t *testing.T) {
		// Create tool call with invalid JSON arguments
		toolCalls := []messages.ToolCall{
			{
				ID:   "toolu_123",
				Type: "function",
				Function: messages.Function{
					Name:      "test",
					Arguments: "not valid json",
				},
			},
		}

		msg := messages.NewAssistantMessageWithTools(toolCalls)
		msgs := messages.MessageList{msg}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		request := result.(AnthropicRequest)
		content := request.Messages[0].Content[0]

		// Should fallback to wrapping in an object
		if content.Input["arguments"] != "not valid json" {
			t.Error("Expected fallback handling for invalid JSON")
		}
	})
}

// Helper functions
func intPtr(i int) *int {
	return &i
}
