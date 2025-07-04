package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/ag-ui/go-sdk/pkg/messages"
	"github.com/ag-ui/go-sdk/pkg/messages/providers"
)

func main() {
	fmt.Println("AG-UI Go SDK - Messages Example")
	fmt.Println("================================")

	// Demonstrate basic message creation
	demonstrateMessageCreation()

	// Demonstrate tool calls
	demonstrateToolCalls()

	// Demonstrate AI provider conversion
	demonstrateProviderConversion()

	// Demonstrate message history
	demonstrateMessageHistory()

	// Demonstrate streaming
	demonstrateStreaming()

	// Demonstrate validation and sanitization
	demonstrateValidationAndSanitization()

	// Demonstrate cross-SDK compatibility
	demonstrateCrossSDKCompatibility()
}

func demonstrateMessageCreation() {
	fmt.Println("1. Basic Message Creation")
	fmt.Println("-------------------------")

	// Create different message types
	userMsg := messages.NewUserMessage("What's the weather like in San Francisco?")
	fmt.Printf("User Message:\n  ID: %s\n  Content: %s\n  Timestamp: %v\n\n",
		userMsg.GetID(), *userMsg.GetContent(), userMsg.GetMetadata().Timestamp)

	assistantMsg := messages.NewAssistantMessage("I'll check the weather for you in San Francisco.")
	fmt.Printf("Assistant Message:\n  ID: %s\n  Content: %s\n\n",
		assistantMsg.GetID(), *assistantMsg.GetContent())

	systemMsg := messages.NewSystemMessage("You are a helpful weather assistant.")
	fmt.Printf("System Message:\n  ID: %s\n  Content: %s\n\n",
		systemMsg.GetID(), *systemMsg.GetContent())

	devMsg := messages.NewDeveloperMessage("Debug: Initiating weather API call")
	fmt.Printf("Developer Message:\n  ID: %s\n  Content: %s\n\n",
		devMsg.GetID(), *devMsg.GetContent())
}

func demonstrateToolCalls() {
	fmt.Println("2. Tool Calls")
	fmt.Println("-------------")

	// Create assistant message with tool calls
	toolCalls := []messages.ToolCall{
		{
			ID:   "call_weather_sf_123",
			Type: "function",
			Function: messages.Function{
				Name:      "get_current_weather",
				Arguments: `{"location": "San Francisco, CA", "unit": "fahrenheit"}`,
			},
		},
	}

	assistantMsg := messages.NewAssistantMessageWithTools(toolCalls)
	fmt.Printf("Assistant with tool calls:\n  Tool Call ID: %s\n  Function: %s\n  Arguments: %s\n\n",
		assistantMsg.ToolCalls[0].ID,
		assistantMsg.ToolCalls[0].Function.Name,
		assistantMsg.ToolCalls[0].Function.Arguments)

	// Create tool result message
	toolResult := messages.NewToolMessage(
		`{"temperature": 72, "conditions": "Sunny", "humidity": 65}`,
		"call_weather_sf_123",
	)
	fmt.Printf("Tool Result:\n  Tool Call ID: %s\n  Content: %s\n\n",
		toolResult.ToolCallID, *toolResult.GetContent())
}

func demonstrateProviderConversion() {
	fmt.Println("3. AI Provider Conversion")
	fmt.Println("------------------------")

	// Create a conversation
	conversation := messages.MessageList{
		messages.NewSystemMessage("You are a helpful weather assistant."),
		messages.NewUserMessage("What's the weather in NYC?"),
		messages.NewAssistantMessageWithTools([]messages.ToolCall{
			{
				ID:   "call_nyc_weather",
				Type: "function",
				Function: messages.Function{
					Name:      "get_current_weather",
					Arguments: `{"location": "New York, NY"}`,
				},
			},
		}),
		messages.NewToolMessage(`{"temperature": 68, "conditions": "Cloudy"}`, "call_nyc_weather"),
		messages.NewAssistantMessage("The weather in New York is 68°F and cloudy."),
	}

	// Convert to OpenAI format
	openaiConverter := providers.NewOpenAIConverter()
	openaiFormat, err := openaiConverter.ToProviderFormat(conversation)
	if err != nil {
		log.Printf("OpenAI conversion error: %v", err)
	} else {
		fmt.Println("OpenAI Format:")
		openaiJSON, _ := json.MarshalIndent(openaiFormat, "  ", "  ")
		fmt.Printf("  %s\n\n", string(openaiJSON))
	}

	// Convert to Anthropic format
	anthropicConverter := providers.NewAnthropicConverter()
	anthropicFormat, err := anthropicConverter.ToProviderFormat(conversation)
	if err != nil {
		log.Printf("Anthropic conversion error: %v", err)
	} else {
		fmt.Println("Anthropic Format:")
		anthropicJSON, _ := json.MarshalIndent(anthropicFormat, "  ", "  ")
		fmt.Printf("  %s\n\n", string(anthropicJSON))
	}
}

func demonstrateMessageHistory() {
	fmt.Println("4. Message History Management")
	fmt.Println("----------------------------")

	// Create history with options
	history := messages.NewHistory(messages.HistoryOptions{
		MaxMessages:      100,
		MaxAge:           24 * time.Hour,
		CompactThreshold: 50,
		EnableIndexing:   true,
	})

	// Add messages
	msgs := []messages.Message{
		messages.NewSystemMessage("You are a travel assistant."),
		messages.NewUserMessage("I want to visit Paris"),
		messages.NewAssistantMessage("Paris is beautiful! When would you like to visit?"),
		messages.NewUserMessage("Maybe in the spring"),
		messages.NewAssistantMessage("Spring is perfect for Paris. The weather is mild and the gardens are in bloom."),
	}

	for _, msg := range msgs {
		if err := history.Add(msg); err != nil {
			log.Printf("Failed to add message: %v", err)
		}
	}

	fmt.Printf("History size: %d messages\n", history.Size())
	fmt.Printf("Total messages ever: %d\n", history.TotalMessages())

	// Search messages
	results := history.Search(messages.SearchOptions{
		Query:      "Paris",
		MaxResults: 5,
	})
	fmt.Printf("\nSearch results for 'Paris': %d messages\n", len(results))
	for _, msg := range results {
		if content := msg.GetContent(); content != nil {
			fmt.Printf("  - [%s] %s\n", msg.GetRole(), *content)
		}
	}

	// Get messages by role
	userMessages := history.GetByRole(messages.RoleUser)
	fmt.Printf("\nUser messages: %d\n", len(userMessages))

	// Get last N messages
	recent := history.GetLast(3)
	fmt.Printf("\nLast 3 messages:\n")
	for _, msg := range recent {
		if content := msg.GetContent(); content != nil {
			fmt.Printf("  - [%s] %s\n", msg.GetRole(), *content)
		}
	}
	fmt.Println()
}

func demonstrateStreaming() {
	fmt.Println("5. Streaming Message Construction")
	fmt.Println("---------------------------------")

	// Create stream builder
	builder, err := messages.NewStreamBuilder(messages.RoleAssistant)
	if err != nil {
		log.Fatal(err)
	}

	// Simulate streaming response
	chunks := []string{
		"I've found ",
		"some great ",
		"restaurants ",
		"in Paris ",
		"for you. ",
		"Le Comptoir ",
		"du Relais ",
		"is highly ",
		"recommended!",
	}

	fmt.Println("Streaming response:")
	for i, chunk := range chunks {
		if err := builder.AddContent(chunk); err != nil {
			log.Printf("Error adding content: %v", err)
			continue
		}

		// Show progressive content
		current := builder.GetMessage()
		if content := current.GetContent(); content != nil {
			fmt.Printf("  [Chunk %d] Current: %s\n", i+1, *content)
		}
		time.Sleep(100 * time.Millisecond) // Simulate network delay
	}

	// Complete the message
	finalMsg, err := builder.Complete()
	if err != nil {
		log.Printf("Error completing message: %v", err)
	} else {
		fmt.Printf("\nFinal message: %s\n\n", *finalMsg.GetContent())
	}
}

func demonstrateValidationAndSanitization() {
	fmt.Println("6. Validation and Sanitization")
	fmt.Println("------------------------------")

	// Create validator
	validator := messages.NewValidator(messages.ValidationOptions{
		MaxContentLength: 1000,
		MaxToolCalls:     10,
		StrictRoleCheck:  true,
	})

	// Valid message
	validMsg := messages.NewUserMessage("This is a valid message")
	if err := validator.ValidateMessage(validMsg); err != nil {
		fmt.Printf("Validation error: %v\n", err)
	} else {
		fmt.Println("✓ Valid message passed validation")
	}

	// Invalid message (content too long)
	longContent := ""
	for i := 0; i < 200; i++ {
		longContent += "This is a very long message. "
	}
	invalidMsg := messages.NewUserMessage(longContent)
	if err := validator.ValidateMessage(invalidMsg); err != nil {
		fmt.Printf("✓ Invalid message caught: %v\n", err)
	}

	// Sanitization
	sanitizer := messages.NewSanitizer(messages.SanitizationOptions{
		RemoveHTML:        true,
		RemoveScripts:     true,
		TrimWhitespace:    true,
		NormalizeNewlines: true,
	})

	// Message with HTML and scripts
	dirtyMsg := messages.NewUserMessage(`
		<p>Hello <b>world</b>!</p>
		<script>alert('xss')</script>
		This is    a    message    with    extra    spaces.
	`)

	fmt.Printf("\nBefore sanitization: %s\n", *dirtyMsg.GetContent())
	if err := sanitizer.SanitizeMessage(dirtyMsg); err != nil {
		log.Printf("Sanitization error: %v", err)
	}
	fmt.Printf("After sanitization: %s\n\n", *dirtyMsg.GetContent())
}

func demonstrateCrossSDKCompatibility() {
	fmt.Println("7. Cross-SDK Compatibility")
	fmt.Println("--------------------------")

	// Create messages that match TypeScript/Python SDK format
	msg := messages.NewUserMessage("Hello from Go SDK!")
	msg.BaseMessage.Name = stringPtr("go_user")

	// Serialize to JSON
	jsonData, err := msg.ToJSON()
	if err != nil {
		log.Printf("JSON serialization error: %v", err)
		return
	}

	fmt.Println("JSON representation (compatible with TypeScript/Python SDKs):")
	var prettyJSON bytes.Buffer
	if err := json.Indent(&prettyJSON, jsonData, "", "  "); err == nil {
		fmt.Println(prettyJSON.String())
	}

	// Show how to handle tool messages across SDKs
	toolMsg := messages.NewAssistantMessageWithTools([]messages.ToolCall{
		{
			ID:   "call_123",
			Type: "function",
			Function: messages.Function{
				Name:      "cross_sdk_function",
				Arguments: `{"sdk": "go", "version": "1.0.0"}`,
			},
		},
	})

	toolJSON, _ := json.Marshal(toolMsg)
	fmt.Printf("\nTool message JSON:\n")
	var prettyToolJSON bytes.Buffer
	if err := json.Indent(&prettyToolJSON, toolJSON, "", "  "); err == nil {
		fmt.Println(prettyToolJSON.String())
	}

	fmt.Println("\nThis JSON format is identical across all AG-UI SDKs!")
}

// Helper function
func stringPtr(s string) *string {
	return &s
}