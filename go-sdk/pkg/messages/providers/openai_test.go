package providers

import (
	"encoding/json"
	"testing"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

func TestOpenAIConverter(t *testing.T) {
	converter := NewOpenAIConverter()

	t.Run("Convert simple messages to OpenAI format", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewSystemMessage("You are a helpful assistant."),
			messages.NewUserMessage("Hello!"),
			messages.NewAssistantMessage("Hi there! How can I help you?"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		openAIMessages, ok := result.([]OpenAIMessage)
		if !ok {
			t.Fatalf("Expected []OpenAIMessage, got %T", result)
		}

		if len(openAIMessages) != 3 {
			t.Errorf("Expected 3 messages, got %d", len(openAIMessages))
		}

		// Check roles
		expectedRoles := []string{"system", "user", "assistant"}
		for i, msg := range openAIMessages {
			if msg.Role != expectedRoles[i] {
				t.Errorf("Message %d: expected role %s, got %s", i, expectedRoles[i], msg.Role)
			}
		}
	})

	t.Run("Convert assistant message with tool calls", func(t *testing.T) {
		toolCalls := []messages.ToolCall{
			{
				ID:   "call_abc123",
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

		openAIMessages := result.([]OpenAIMessage)
		if len(openAIMessages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(openAIMessages))
		}

		openAIMsg := openAIMessages[0]
		if len(openAIMsg.ToolCalls) != 1 {
			t.Fatalf("Expected 1 tool call, got %d", len(openAIMsg.ToolCalls))
		}

		tc := openAIMsg.ToolCalls[0]
		if tc.ID != "call_abc123" {
			t.Errorf("Expected tool call ID 'call_abc123', got %s", tc.ID)
		}
		if tc.Function.Name != "get_weather" {
			t.Errorf("Expected function name 'get_weather', got %s", tc.Function.Name)
		}
	})

	t.Run("Convert tool message", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewToolMessage("The weather in San Francisco is 18°C and sunny.", "call_abc123"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		openAIMessages := result.([]OpenAIMessage)
		if len(openAIMessages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(openAIMessages))
		}

		openAIMsg := openAIMessages[0]
		if openAIMsg.Role != "tool" {
			t.Errorf("Expected role 'tool', got %s", openAIMsg.Role)
		}
		if openAIMsg.ToolCallID == nil || *openAIMsg.ToolCallID != "call_abc123" {
			t.Error("Expected tool call ID 'call_abc123'")
		}
	})

	t.Run("Convert developer message to system", func(t *testing.T) {
		msgs := messages.MessageList{
			messages.NewDeveloperMessage("Debug: Processing request"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		openAIMessages := result.([]OpenAIMessage)
		if len(openAIMessages) != 1 {
			t.Fatalf("Expected 1 message, got %d", len(openAIMessages))
		}

		openAIMsg := openAIMessages[0]
		if openAIMsg.Role != "system" {
			t.Errorf("Expected role 'system', got %s", openAIMsg.Role)
		}
		if openAIMsg.Name == nil || *openAIMsg.Name != "developer" {
			t.Error("Expected name 'developer' for converted developer message")
		}
	})

	t.Run("Convert from OpenAI format", func(t *testing.T) {
		openAIMessages := []OpenAIMessage{
			{
				Role:    "system",
				Content: stringPtr("You are helpful."),
			},
			{
				Role:    "user",
				Content: stringPtr("What's the weather?"),
			},
			{
				Role: "assistant",
				ToolCalls: []OpenAIToolCall{
					{
						ID:   "call_123",
						Type: "function",
						Function: OpenAIFunctionCall{
							Name:      "get_weather",
							Arguments: `{"location": "NYC"}`,
						},
					},
				},
			},
			{
				Role:       "tool",
				Content:    stringPtr("72°F and sunny"),
				ToolCallID: stringPtr("call_123"),
			},
		}

		msgs, err := converter.FromProviderFormat(openAIMessages)
		if err != nil {
			t.Fatalf("Failed to convert from OpenAI format: %v", err)
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

		// Check assistant message has tool calls
		assistantMsg := msgs[2].(*messages.AssistantMessage)
		if len(assistantMsg.ToolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %d", len(assistantMsg.ToolCalls))
		}
	})

	t.Run("Convert from JSON", func(t *testing.T) {
		jsonData := `[
			{"role": "user", "content": "Hello"},
			{"role": "assistant", "content": "Hi!"}
		]`

		msgs, err := converter.FromProviderFormat([]byte(jsonData))
		if err != nil {
			t.Fatalf("Failed to convert from JSON: %v", err)
		}

		if len(msgs) != 2 {
			t.Errorf("Expected 2 messages, got %d", len(msgs))
		}
	})

	t.Run("Streaming delta processing", func(t *testing.T) {
		state := NewStreamingState()

		// Process content delta
		delta1 := OpenAIStreamDelta{
			Content: stringPtr("Hello"),
		}
		msg1, err := converter.ProcessDelta(state, delta1)
		if err != nil {
			t.Fatalf("Failed to process delta: %v", err)
		}
		if content := msg1.GetContent(); content == nil || *content != "Hello" {
			t.Errorf("Expected content 'Hello', got %v", content)
		}

		// Process additional content
		delta2 := OpenAIStreamDelta{
			Content: stringPtr(" world!"),
		}
		msg2, err := converter.ProcessDelta(state, delta2)
		if err != nil {
			t.Fatalf("Failed to process delta: %v", err)
		}
		if content := msg2.GetContent(); content == nil || *content != "Hello world!" {
			t.Errorf("Expected content 'Hello world!', got %v", content)
		}

		// Process tool call delta
		delta3 := OpenAIStreamDelta{
			ToolCalls: []OpenAIToolCallDelta{
				{
					Index: 0,
					ID:    stringPtr("call_123"),
					Type:  stringPtr("function"),
					Function: &OpenAIFunctionCallDelta{
						Name:      stringPtr("get_weather"),
						Arguments: stringPtr(`{"location":`),
					},
				},
			},
		}
		msg3, err := converter.ProcessDelta(state, delta3)
		if err != nil {
			t.Fatalf("Failed to process tool call delta: %v", err)
		}
		if len(msg3.ToolCalls) != 1 {
			t.Errorf("Expected 1 tool call, got %d", len(msg3.ToolCalls))
		}

		// Complete tool call arguments
		delta4 := OpenAIStreamDelta{
			ToolCalls: []OpenAIToolCallDelta{
				{
					Index: 0,
					Function: &OpenAIFunctionCallDelta{
						Arguments: stringPtr(`"NYC"}`),
					},
				},
			},
		}
		msg4, err := converter.ProcessDelta(state, delta4)
		if err != nil {
			t.Fatalf("Failed to process tool call delta: %v", err)
		}
		tc := msg4.ToolCalls[0]
		if tc.Function.Arguments != `{"location":"NYC"}` {
			t.Errorf("Expected complete arguments, got %s", tc.Function.Arguments)
		}
	})
}

func TestOpenAIConverterOptions(t *testing.T) {
	converter := NewOpenAIConverter()

	t.Run("Merge consecutive messages", func(t *testing.T) {
		converter.SetOptions(ConversionOptions{
			IncludeSystemMessages:    true,
			MergeConsecutiveMessages: true,
		})

		msgs := messages.MessageList{
			messages.NewUserMessage("Hello"),
			messages.NewUserMessage("How are you?"),
			messages.NewAssistantMessage("I'm good!"),
			messages.NewAssistantMessage("How can I help?"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		openAIMessages := result.([]OpenAIMessage)
		if len(openAIMessages) != 2 {
			t.Errorf("Expected 2 merged messages, got %d", len(openAIMessages))
		}

		// Check merged content
		if content := openAIMessages[0].Content; content == nil || *content != "Hello\n\nHow are you?" {
			t.Errorf("Expected merged user content, got %v", content)
		}
		if content := openAIMessages[1].Content; content == nil || *content != "I'm good!\n\nHow can I help?" {
			t.Errorf("Expected merged assistant content, got %v", content)
		}
	})

	t.Run("Exclude system messages", func(t *testing.T) {
		converter.SetOptions(ConversionOptions{
			IncludeSystemMessages:    false,
			MergeConsecutiveMessages: false,
		})

		msgs := messages.MessageList{
			messages.NewSystemMessage("You are helpful."),
			messages.NewUserMessage("Hello"),
			messages.NewAssistantMessage("Hi!"),
		}

		result, err := converter.ToProviderFormat(msgs)
		if err != nil {
			t.Fatalf("Failed to convert messages: %v", err)
		}

		openAIMessages := result.([]OpenAIMessage)
		if len(openAIMessages) != 2 {
			t.Errorf("Expected 2 messages (system excluded), got %d", len(openAIMessages))
		}

		// Check that system message was filtered
		for _, msg := range openAIMessages {
			if msg.Role == "system" {
				t.Error("System message should have been filtered out")
			}
		}
	})
}

func TestOpenAIValidation(t *testing.T) {
	t.Run("Validate tool message ordering", func(t *testing.T) {
		// Tool message without preceding assistant message with tool calls
		msgs := messages.MessageList{
			messages.NewUserMessage("Hello"),
			messages.NewToolMessage("Result", "call_123"),
		}

		err := ValidateMessages(msgs)
		if err == nil {
			t.Error("Expected validation error for tool message without preceding assistant message")
		}
	})

	t.Run("Validate tool call ID reference", func(t *testing.T) {
		// Tool message with invalid tool call ID
		msgs := messages.MessageList{
			messages.NewAssistantMessageWithTools([]messages.ToolCall{
				{
					ID:   "call_123",
					Type: "function",
					Function: messages.Function{
						Name:      "test",
						Arguments: "{}",
					},
				},
			}),
			messages.NewToolMessage("Result", "call_wrong"),
		}

		err := ValidateMessages(msgs)
		if err == nil {
			t.Error("Expected validation error for tool message with invalid tool call ID")
		}
	})
}

// Helper function
func stringPtr(s string) *string {
	return &s
}