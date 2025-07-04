/*
Package messages provides a comprehensive message type system for the AG-UI Go SDK,
enabling vendor-neutral communication between AI agents and front-end applications.

# Overview

The messages package implements the AG-UI protocol's standardized message types,
providing a unified interface for agent-user interactions across different AI providers.
It includes five core message types (User, Assistant, System, Tool, Developer),
AI provider conversion capabilities, message history management, streaming support,
and comprehensive validation.

# Core Message Types

The package defines five standardized message types:

  - UserMessage: Messages from human users
  - AssistantMessage: Messages from AI assistants (with optional tool calls)
  - SystemMessage: System-level instructions and context
  - ToolMessage: Tool execution results
  - DeveloperMessage: Debug and development information

Each message type implements the Message interface and includes automatic ID generation,
timestamp tracking, and metadata support.

# Basic Usage

Creating and validating messages:

	// Create messages
	userMsg := messages.NewUserMessage("Hello, AI!")
	assistantMsg := messages.NewAssistantMessage("Hello! How can I help you?")
	systemMsg := messages.NewSystemMessage("You are a helpful assistant.")

	// Messages are automatically assigned IDs and timestamps
	fmt.Println(userMsg.GetID())        // e.g., "550e8400-e29b-41d4-a716-446655440000"
	fmt.Println(userMsg.GetMetadata().Timestamp)

	// Validate messages
	validator := messages.NewValidator()
	if err := validator.ValidateMessage(userMsg); err != nil {
	    log.Fatal("Invalid message:", err)
	}

# Working with Tool Calls

Assistant messages can include tool/function calls:

	// Create assistant message with tool calls
	toolCalls := []messages.ToolCall{
	    {
	        ID:   "call_123",
	        Type: "function",
	        Function: messages.Function{
	            Name:      "get_weather",
	            Arguments: `{"location": "San Francisco", "unit": "celsius"}`,
	        },
	    },
	}
	assistantMsg := messages.NewAssistantMessageWithTools(toolCalls)

	// Create corresponding tool result message
	toolMsg := messages.NewToolMessage("18°C and sunny", "call_123")

# AI Provider Integration

The package provides converters for major AI providers:

	// Convert to OpenAI format
	openaiConverter := providers.NewOpenAIConverter()
	openaiMessages, err := openaiConverter.ToProviderFormat(messageList)

	// Convert to Anthropic format
	anthropicConverter := providers.NewAnthropicConverter()
	anthropicRequest, err := anthropicConverter.ToProviderFormat(messageList)

	// Convert back from provider format
	agMessages, err := openaiConverter.FromProviderFormat(openaiResponse)

# Message History Management

Efficient history management with thread safety:

	// Create history with options
	history := messages.NewHistory(messages.HistoryOptions{
	    MaxMessages:      1000,
	    MaxAge:           24 * time.Hour,
	    CompactThreshold: 500,
	})

	// Add messages
	history.Add(userMsg)
	history.Add(assistantMsg)

	// Search messages
	results := history.Search(messages.SearchOptions{
	    Query: "weather",
	    Role:  messages.RoleUser,
	    MaxResults: 10,
	})

	// Get conversation snapshot
	snapshot := history.Snapshot()

# Streaming Support

Handle streaming message updates:

	// Create stream builder
	builder, _ := messages.NewStreamBuilder(messages.RoleAssistant)

	// Process streaming deltas
	builder.AddContent("The weather ")
	builder.AddContent("is sunny")

	// Add tool calls during streaming
	builder.AddToolCall(0, messages.ToolCall{
	    ID:   "call_456",
	    Type: "function",
	    Function: messages.Function{
	        Name: "get_temperature",
	    },
	})

	// Complete the message
	finalMsg, _ := builder.Complete()

# Validation and Sanitization

Comprehensive validation and content sanitization:

	// Configure validation
	validator := messages.NewValidator(messages.ValidationOptions{
	    MaxContentBytes:   100000,
	    MaxToolCalls:      50,
	    StrictRoleCheck:   true,
	})

	// Validate message list
	if err := validator.ValidateMessageList(messages); err != nil {
	    log.Fatal("Invalid messages:", err)
	}

	// Sanitize content
	sanitizer := messages.NewSanitizer(messages.SanitizationOptions{
	    RemoveHTML:        true,
	    RemoveScripts:     true,
	    TrimWhitespace:    true,
	})
	sanitizer.SanitizeMessage(userMsg)

# Conversation Management

Manage conversations with automatic pruning:

	// Create conversation with limits
	conv := messages.NewConversation(messages.ConversationOptions{
	    MaxMessages:            100,
	    PreserveSystemMessages: true,
	})

	// Add messages
	conv.AddMessage(systemMsg)
	conv.AddMessage(userMsg)
	conv.AddMessage(assistantMsg)

	// Query conversation
	lastUser := conv.GetLastUserMessage()
	systemMsgs := conv.GetMessagesByRole(messages.RoleSystem)

# Thread Safety

All history and conversation management operations are thread-safe:

	// Concurrent operations are safe
	go history.Add(msg1)
	go history.Add(msg2)
	go history.Search(options)

# Cross-SDK Compatibility

The message format is compatible with TypeScript and Python SDKs:

	// Messages serialize to the same JSON format across all SDKs
	jsonData, _ := msg.ToJSON()
	// {"id":"...","role":"user","content":"Hello!","metadata":{...}}

# Performance Considerations

  - Message validation is optimized for performance
  - History compaction runs automatically based on thresholds
  - Streaming builders minimize allocations during updates
  - Provider converters use efficient transformation algorithms

For more examples and detailed API documentation, see the individual type
and function documentation throughout the package.
*/
package messages