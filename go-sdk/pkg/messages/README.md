# AG-UI Go SDK Messages Package

The messages package provides a comprehensive, vendor-neutral message type system for the AG-UI Go SDK, enabling seamless communication between AI agents and front-end applications.

## Features

- **5 Standardized Message Types**: User, Assistant, System, Tool, and Developer messages
- **AI Provider Conversion**: Built-in converters for OpenAI and Anthropic APIs
- **Message History Management**: Thread-safe history with search and compaction
- **Streaming Support**: Real-time message construction and updates
- **Validation & Sanitization**: Comprehensive content validation and sanitization
- **Cross-SDK Compatibility**: Compatible with TypeScript and Python SDKs

## Installation

```go
import "github.com/ag-ui/go-sdk/pkg/messages"
```

## Quick Start

### Creating Messages

```go
// Create different message types
userMsg := messages.NewUserMessage("What's the weather like?")
assistantMsg := messages.NewAssistantMessage("I'll check the weather for you.")
systemMsg := messages.NewSystemMessage("You are a weather assistant.")
devMsg := messages.NewDeveloperMessage("Debug: API call initiated")

// Messages automatically get IDs and timestamps
fmt.Printf("Message ID: %s\n", userMsg.GetID())
fmt.Printf("Timestamp: %v\n", userMsg.GetMetadata().Timestamp)
```

### Working with Tool Calls

```go
// Create assistant message with tool calls
toolCalls := []messages.ToolCall{
    {
        ID:   "call_weather_123",
        Type: "function",
        Function: messages.Function{
            Name:      "get_current_weather",
            Arguments: `{"location": "San Francisco", "unit": "celsius"}`,
        },
    },
}

assistantMsg := messages.NewAssistantMessageWithTools(toolCalls)

// Create tool result message
toolResult := messages.NewToolMessage(
    "Temperature: 18°C, Conditions: Sunny",
    "call_weather_123",
)
```

### AI Provider Integration

```go
// Convert messages to OpenAI format
msgs := messages.MessageList{
    messages.NewSystemMessage("You are helpful."),
    messages.NewUserMessage("Hello!"),
    messages.NewAssistantMessage("Hi there!"),
}

openaiConverter := providers.NewOpenAIConverter()
openaiFormat, err := openaiConverter.ToProviderFormat(msgs)
if err != nil {
    log.Fatal(err)
}

// Convert to Anthropic format
anthropicConverter := providers.NewAnthropicConverter()
anthropicFormat, err := anthropicConverter.ToProviderFormat(msgs)
if err != nil {
    log.Fatal(err)
}
```

### Message History Management

```go
// Create history with configuration
history := messages.NewHistory(messages.HistoryOptions{
    MaxMessages:      1000,
    MaxAge:           24 * time.Hour,
    CompactThreshold: 500,
    EnableIndexing:   true,
})

// Add messages
history.Add(userMsg)
history.Add(assistantMsg)

// Search messages
results := history.Search(messages.SearchOptions{
    Query:      "weather",
    Role:       messages.RoleUser,
    MaxResults: 10,
})

// Get recent messages
recentMsgs := history.GetLast(5)

// Get messages by role
userMessages := history.GetByRole(messages.RoleUser)
```

### Streaming Message Construction

```go
// Create a stream builder for assistant responses
builder, err := messages.NewStreamBuilder(messages.RoleAssistant)
if err != nil {
    log.Fatal(err)
}

// Simulate streaming response
chunks := []string{"The ", "weather ", "in ", "San Francisco ", "is ", "sunny."}
for _, chunk := range chunks {
    if err := builder.AddContent(chunk); err != nil {
        log.Fatal(err)
    }
    
    // Get current state
    currentMsg := builder.GetMessage()
    fmt.Printf("Current content: %s\n", *currentMsg.GetContent())
}

// Complete the message
finalMsg, err := builder.Complete()
if err != nil {
    log.Fatal(err)
}
```

### Validation and Sanitization

```go
// Configure validation options
validator := messages.NewValidator(messages.ValidationOptions{
    MaxContentLength:   100000,  // 100KB
    MaxNameLength:      256,
    MaxToolCalls:       50,
    AllowEmptyContent:  false,
    StrictRoleCheck:    true,
})

// Validate a single message
if err := validator.ValidateMessage(userMsg); err != nil {
    fmt.Printf("Validation error: %v\n", err)
}

// Validate message list with conversation flow
msgList := messages.MessageList{userMsg, assistantMsg, toolResult}
if err := validator.ValidateMessageList(msgList); err != nil {
    fmt.Printf("Message list validation error: %v\n", err)
}

// Sanitize content
sanitizer := messages.NewSanitizer(messages.SanitizationOptions{
    RemoveHTML:             true,
    RemoveScripts:          true,
    TrimWhitespace:         true,
    NormalizeNewlines:      true,
    MaxConsecutiveNewlines: 2,
})

// Sanitize a message with HTML content
dirtyMsg := messages.NewUserMessage("<script>alert('xss')</script>Hello <b>world</b>!")
sanitizer.SanitizeMessage(dirtyMsg)
fmt.Printf("Sanitized content: %s\n", *dirtyMsg.GetContent())
// Output: Hello world!
```

### Conversation Management

```go
// Create a conversation with limits
conv := messages.NewConversation(messages.ConversationOptions{
    MaxMessages:            100,
    PreserveSystemMessages: true,
})

// Add messages to conversation
conv.AddMessage(messages.NewSystemMessage("You are helpful."))
conv.AddMessage(messages.NewUserMessage("What's 2+2?"))
conv.AddMessage(messages.NewAssistantMessage("2+2 equals 4."))

// Query conversation
lastMsg := conv.GetLastMessage()
lastUserMsg := conv.GetLastUserMessage()
systemMsgs := conv.GetMessagesByRole(messages.RoleSystem)

fmt.Printf("Total messages: %d\n", len(conv.Messages))
fmt.Printf("Last user message: %s\n", *lastUserMsg.GetContent())
```

### Provider-Specific Streaming

```go
// OpenAI streaming example
openaiConverter := providers.NewOpenAIConverter()
streamState := providers.NewStreamingState()

// Process OpenAI stream deltas
delta1 := providers.OpenAIStreamDelta{
    Content: stringPtr("Hello"),
}
msg, _ := openaiConverter.ProcessDelta(streamState, delta1)

delta2 := providers.OpenAIStreamDelta{
    Content: stringPtr(" world!"),
}
msg, _ = openaiConverter.ProcessDelta(streamState, delta2)

fmt.Printf("Accumulated content: %s\n", *msg.GetContent())
// Output: Hello world!
```

## Advanced Usage

### Threaded Conversations

```go
// Create threaded history manager
threadedHistory := messages.NewThreadedHistory(messages.HistoryOptions{
    MaxMessages: 1000,
})

// Get or create threads
thread1 := threadedHistory.GetThread("user-123-chat-1")
thread2 := threadedHistory.GetThread("user-123-chat-2")

// Add messages to specific threads
thread1.Add(messages.NewUserMessage("Thread 1 message"))
thread2.Add(messages.NewUserMessage("Thread 2 message"))

// List all threads
threads := threadedHistory.ListThreads()
fmt.Printf("Active threads: %v\n", threads)
```

### Custom Validation Rules

```go
// Create validator with strict limits
strictValidator := messages.NewValidator(messages.ValidationOptions{
    MaxContentLength:   5000,    // 5KB limit
    MaxNameLength:      50,      // Short names only
    MaxToolCalls:       5,       // Limit tool calls
    MaxArgumentsLength: 1000,    // 1KB for function arguments
    AllowEmptyContent:  false,   // No empty messages
    StrictRoleCheck:    true,    // Enforce valid roles
})

// Validate with custom rules
if err := strictValidator.ValidateMessage(msg); err != nil {
    // Handle validation error
}
```

### Message Conversion Options

```go
// Configure conversion behavior
converter := providers.NewOpenAIConverter()
converter.SetOptions(providers.ConversionOptions{
    MaxTokens:                0,     // No token limit
    TruncateStrategy:         providers.TruncateOldest,
    IncludeSystemMessages:    true,
    MergeConsecutiveMessages: true,  // Merge same-role messages
})

// Convert with options applied
result, err := converter.ToProviderFormat(messages)
```

## Performance Tips

1. **Use Message History Wisely**: Configure appropriate limits for `MaxMessages` and `CompactThreshold`
2. **Batch Operations**: Use `AddBatch()` when adding multiple messages to history
3. **Stream Processing**: Use `BufferedStream` for batch processing of stream events
4. **Validation Caching**: Reuse validator instances across multiple validations
5. **Provider Converters**: Register converters once and reuse them

## Cross-SDK Compatibility

Messages serialize to the same JSON format across all AG-UI SDKs:

```go
// Go SDK
msg := messages.NewUserMessage("Hello!")
jsonData, _ := msg.ToJSON()

// Compatible with TypeScript SDK:
// const msg: UserMessage = JSON.parse(jsonData)

// Compatible with Python SDK:
// msg = UserMessage.parse_raw(json_data)
```

## Thread Safety

All history and conversation management operations are thread-safe:

```go
var wg sync.WaitGroup

// Safe concurrent operations
for i := 0; i < 10; i++ {
    wg.Add(1)
    go func(idx int) {
        defer wg.Done()
        msg := messages.NewUserMessage(fmt.Sprintf("Message %d", idx))
        history.Add(msg)
    }(i)
}

wg.Wait()
```

## Error Handling

```go
// Handle validation errors
validator := messages.NewValidator()
if err := validator.ValidateMessage(msg); err != nil {
    switch {
    case strings.Contains(err.Error(), "content exceeds maximum length"):
        // Handle content too long
    case strings.Contains(err.Error(), "invalid role"):
        // Handle invalid role
    default:
        // Handle other validation errors
    }
}

// Handle conversion errors
result, err := converter.ToProviderFormat(messages)
if err != nil {
    if strings.Contains(err.Error(), "tool message without preceding assistant") {
        // Handle conversation flow error
    }
}
```

## Testing

Run the test suite:

```bash
go test ./pkg/messages/...
```

Run with coverage:

```bash
go test -coverprofile=coverage.out ./pkg/messages/...
go tool cover -html=coverage.out
```

## Contributing

When adding new features or providers:

1. Implement the appropriate interfaces
2. Add comprehensive tests
3. Update documentation
4. Ensure cross-SDK compatibility
5. Run benchmarks for performance-critical code

## License

See the main AG-UI Go SDK license.