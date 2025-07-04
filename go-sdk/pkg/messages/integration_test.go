package messages_test

import (
	"encoding/json"
	"testing"

	"github.com/ag-ui/go-sdk/pkg/messages"
	"github.com/ag-ui/go-sdk/pkg/messages/providers"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCompleteMessageFlow(t *testing.T) {
	t.Run("OpenAI round-trip conversion", func(t *testing.T) {
		// Create a complete conversation
		conversation := messages.NewConversation()
		
		// Add system message
		sysMsg := messages.NewSystemMessage("You are a helpful assistant.")
		conversation.AddMessage(sysMsg)
		
		// Add user message
		userMsg := messages.NewUserMessage("What's the weather like?")
		conversation.AddMessage(userMsg)
		
		// Add assistant message with tool calls
		toolCalls := []messages.ToolCall{
			{
				ID:   "call_123",
				Type: "function",
				Function: messages.Function{
					Name:      "get_weather",
					Arguments: `{"location": "San Francisco"}`,
				},
			},
		}
		assistantMsg := messages.NewAssistantMessageWithTools(toolCalls)
		assistantMsg.Content = stringPtr("Let me check the weather for you.")
		conversation.AddMessage(assistantMsg)
		
		// Add tool response
		toolMsg := messages.NewToolMessage("The weather in San Francisco is 18°C and sunny.", "call_123")
		conversation.AddMessage(toolMsg)
		
		// Add final assistant response
		finalMsg := messages.NewAssistantMessage("The weather in San Francisco is currently 18°C and sunny. It's a beautiful day!")
		conversation.AddMessage(finalMsg)
		
		// Convert to OpenAI format
		converter := providers.NewOpenAIConverter()
		openaiData, err := converter.ToProviderFormat(conversation.Messages)
		require.NoError(t, err)
		require.NotNil(t, openaiData)
		
		// Verify the conversion maintains the message count
		openaiJSON, err := json.Marshal(openaiData)
		require.NoError(t, err)
		require.NotEmpty(t, openaiJSON)
		
		// Convert back from OpenAI format
		roundTrip, err := converter.FromProviderFormat(openaiData)
		require.NoError(t, err)
		require.NotNil(t, roundTrip)
		
		// Verify message count is preserved
		assert.Equal(t, len(conversation.Messages), len(roundTrip))
		
		// Verify each message type and content
		assert.IsType(t, &messages.SystemMessage{}, roundTrip[0])
		assert.Equal(t, "You are a helpful assistant.", *roundTrip[0].GetContent())
		
		assert.IsType(t, &messages.UserMessage{}, roundTrip[1])
		assert.Equal(t, "What's the weather like?", *roundTrip[1].GetContent())
		
		assert.IsType(t, &messages.AssistantMessage{}, roundTrip[2])
		assistantRoundTrip := roundTrip[2].(*messages.AssistantMessage)
		assert.Equal(t, "Let me check the weather for you.", *assistantRoundTrip.Content)
		assert.Len(t, assistantRoundTrip.ToolCalls, 1)
		assert.Equal(t, "get_weather", assistantRoundTrip.ToolCalls[0].Function.Name)
		
		assert.IsType(t, &messages.ToolMessage{}, roundTrip[3])
		toolRoundTrip := roundTrip[3].(*messages.ToolMessage)
		assert.Equal(t, "The weather in San Francisco is 18°C and sunny.", toolRoundTrip.Content)
		assert.Equal(t, "call_123", toolRoundTrip.ToolCallID)
		
		assert.IsType(t, &messages.AssistantMessage{}, roundTrip[4])
		assert.Equal(t, "The weather in San Francisco is currently 18°C and sunny. It's a beautiful day!", 
			*roundTrip[4].GetContent())
	})
	
	t.Run("Anthropic round-trip conversion", func(t *testing.T) {
		// Create conversation with Anthropic-specific features
		conversation := messages.NewConversation()
		
		// Add system message
		conversation.AddMessage(messages.NewSystemMessage("You are Claude, an AI assistant."))
		
		// Add user message
		conversation.AddMessage(messages.NewUserMessage("Hello!"))
		
		// Add developer message
		conversation.AddMessage(messages.NewDeveloperMessage("Debug: Processing greeting"))
		
		// Add assistant response
		conversation.AddMessage(messages.NewAssistantMessage("Hello! How can I help you today?"))
		
		// Convert to Anthropic format
		converter := providers.NewAnthropicConverter()
		anthropicData, err := converter.ToProviderFormat(conversation.Messages)
		require.NoError(t, err)
		require.NotNil(t, anthropicData)
		
		// Verify it's in the expected format
		request, ok := anthropicData.(providers.AnthropicRequest)
		require.True(t, ok)
		assert.Equal(t, "You are Claude, an AI assistant.", request.System)
		assert.Len(t, request.Messages, 3) // User, Developer (as assistant), Assistant
		
		// Convert back
		roundTrip, err := converter.FromProviderFormat(anthropicData)
		require.NoError(t, err)
		
		// System message is preserved in the system field, not in messages
		// So we expect 3 messages in the round trip
		assert.Len(t, roundTrip, 3)
		
		// Verify message types and content
		assert.IsType(t, &messages.UserMessage{}, roundTrip[0])
		assert.Equal(t, "Hello!", *roundTrip[0].GetContent())
		
		assert.IsType(t, &messages.DeveloperMessage{}, roundTrip[1])
		assert.Equal(t, "Debug: Processing greeting", *roundTrip[1].GetContent())
		
		assert.IsType(t, &messages.AssistantMessage{}, roundTrip[2])
		assert.Equal(t, "Hello! How can I help you today?", *roundTrip[2].GetContent())
	})
}

func TestValidationAndSanitizationFlow(t *testing.T) {
	t.Run("Complete validation and sanitization pipeline", func(t *testing.T) {
		// Create messages with content that needs sanitization
		conversation := messages.NewConversation()
		
		// Add message with HTML content
		userMsg := messages.NewUserMessage("<script>alert('xss')</script>Hello <b>world</b>!")
		conversation.AddMessage(userMsg)
		
		// Create validator and sanitizer
		validator := messages.NewValidator(messages.ValidationOptions{
			MaxContentLength:   1000,
			MaxNameLength:      50,
			MaxToolCalls:       10,
			MaxArgumentsLength: 1000,
			AllowEmptyContent:  false,
			StrictRoleCheck:    true,
			SanitizeContent:    true,
		})
		
		sanitizer := messages.NewSanitizer(messages.SanitizationOptions{
			RemoveHTML:             true,
			RemoveScripts:          true,
			TrimWhitespace:         true,
			NormalizeNewlines:      true,
			MaxConsecutiveNewlines: 2,
		})
		
		// Sanitize messages
		err := sanitizer.SanitizeMessageList(conversation.Messages)
		require.NoError(t, err)
		
		// Validate messages
		err = validator.ValidateMessageList(conversation.Messages)
		require.NoError(t, err)
		
		// Check that content was sanitized
		sanitizedContent := *conversation.Messages[0].GetContent()
		assert.NotContains(t, sanitizedContent, "<script>")
		assert.NotContains(t, sanitizedContent, "<b>")
		assert.Equal(t, "Hello world!", sanitizedContent)
	})
}

func TestStreamingMessageReconstruction(t *testing.T) {
	t.Run("Anthropic streaming state management", func(t *testing.T) {
		converter := providers.NewAnthropicConverter()
		
		// Get a streaming state from the pool
		state := providers.GetStreamingState()
		defer providers.PutStreamingState(state)
		
		// Simulate streaming events
		events := []providers.AnthropicStreamEvent{
			{
				Type: "content_block_delta",
				Index: intPtr(0),
				Delta: &providers.AnthropicDelta{
					Type: stringPtr("text"),
					Text: stringPtr("Hello, "),
				},
			},
			{
				Type: "content_block_delta",
				Index: intPtr(0),
				Delta: &providers.AnthropicDelta{
					Type: stringPtr("text"),
					Text: stringPtr("how can I help you?"),
				},
			},
			{
				Type: "content_block_delta",
				Index: intPtr(1),
				Delta: &providers.AnthropicDelta{
					Type:      stringPtr("tool_use"),
					ToolUseID: stringPtr("tool_123"),
					Name:      stringPtr("get_info"),
				},
			},
			{
				Type: "content_block_delta",
				Index: intPtr(1),
				Delta: &providers.AnthropicDelta{
					Type:  stringPtr("tool_use"),
					Input: stringPtr(`{"query": "test"}`),
				},
			},
			{
				Type: "content_block_stop",
			},
		}
		
		// Process events
		var finalMessage *messages.AssistantMessage
		for _, event := range events {
			msg, err := converter.ProcessStreamEvent(state, event)
			require.NoError(t, err)
			if event.Type == "content_block_stop" {
				finalMessage = msg
			}
		}
		
		// Verify final message
		require.NotNil(t, finalMessage)
		assert.Equal(t, "Hello, how can I help you?", *finalMessage.Content)
		assert.Len(t, finalMessage.ToolCalls, 1)
		assert.Equal(t, "tool_123", finalMessage.ToolCalls[0].ID)
		assert.Equal(t, "get_info", finalMessage.ToolCalls[0].Function.Name)
		assert.Equal(t, `{"query": "test"}`, finalMessage.ToolCalls[0].Function.Arguments)
		
		// Verify state was properly managed
		assert.Equal(t, 2, state.Size()) // 1 tool call + 1 tool input
	})
}

func TestErrorHandlingFlow(t *testing.T) {
	t.Run("Structured error handling", func(t *testing.T) {
		// Test validation error
		msg := messages.NewUserMessage("")
		validator := messages.NewValidator()
		err := validator.ValidateMessage(msg)
		require.Error(t, err)
		assert.True(t, messages.IsValidationError(err))
		
		// Test conversion error
		converter := providers.NewAnthropicConverter()
		invalidMsg := &customMessage{} // A type not supported by the converter
		_, err = converter.ToProviderFormat(messages.MessageList{invalidMsg})
		require.Error(t, err)
		// The error should contain information about the unsupported type
		assert.Contains(t, err.Error(), "unsupported")
		
		// Test content too long error
		longContent := make([]byte, 2000000) // 2MB of content
		for i := range longContent {
			longContent[i] = 'a'
		}
		longMsg := messages.NewUserMessage(string(longContent))
		
		validator = messages.NewValidator(messages.ValidationOptions{
			MaxContentLength: 1000000, // 1MB limit
		})
		err = validator.ValidateMessage(longMsg)
		require.Error(t, err)
		assert.True(t, messages.IsValidationError(err))
	})
}

func TestMessageHistory(t *testing.T) {
	t.Run("History management with conversations", func(t *testing.T) {
		history := messages.NewHistory()
		
		// Create and add conversations
		conv1 := messages.NewConversation()
		conv1.AddMessage(messages.NewUserMessage("Hello"))
		conv1.AddMessage(messages.NewAssistantMessage("Hi there!"))
		
		conv2 := messages.NewConversation()
		conv2.AddMessage(messages.NewUserMessage("How are you?"))
		conv2.AddMessage(messages.NewAssistantMessage("I'm doing well, thanks!"))
		
		// Add conversations to history
		for _, msg := range conv1.Messages {
			history.AddMessage(msg)
		}
		
		// Start a new thread
		history.StartNewThread()
		
		for _, msg := range conv2.Messages {
			history.AddMessage(msg)
		}
		
		// Verify thread management
		threads := history.GetThreads()
		assert.Len(t, threads, 2)
		
		// Get messages from first thread
		thread1Messages := history.GetThreadMessages(threads[0])
		assert.Len(t, thread1Messages, 2)
		assert.Equal(t, "Hello", *thread1Messages[0].GetContent())
		
		// Get messages from second thread
		thread2Messages := history.GetThreadMessages(threads[1])
		assert.Len(t, thread2Messages, 2)
		assert.Equal(t, "How are you?", *thread2Messages[0].GetContent())
		
		// Test filtering by role
		userMessages := history.FilterByRole(messages.RoleUser)
		assert.Len(t, userMessages, 2)
		
		assistantMessages := history.FilterByRole(messages.RoleAssistant)
		assert.Len(t, assistantMessages, 2)
	})
}

// Helper types and functions

type customMessage struct {
	messages.BaseMessage
}

func (m *customMessage) Validate() error {
	return nil
}

func (m *customMessage) ToJSON() ([]byte, error) {
	return json.Marshal(m)
}

func stringPtr(s string) *string {
	return &s
}

func intPtr(i int) *int {
	return &i
}