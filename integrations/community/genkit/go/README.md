# AG-UI Genkit Integration (Go)

Implementation of the AG-UI protocol for Firebase Genkit in Go.

Connects Genkit to frontend applications via the AG-UI protocol. Provides a streaming function adapter that translates Genkit model response chunks into AG-UI protocol events.

## Installation

```bash
go get github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/genkit
```

## Usage

```go
import (
    "context"

    "github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/genkit"
    "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
    "github.com/firebase/genkit/go/ai"
)

// Create an events channel
eventsCh := make(chan events.Event, 100)

// Create a streaming function adapter
streamFunc := genkit.StreamingFunc("thread-id", "run-id", eventsCh)

// Use with Genkit's Generate function
response, err := ai.Generate(ctx, model,
    ai.WithTextPrompt("Hello, world!"),
    ai.WithStreaming(streamFunc),
)

// Process events from the channel
for event := range eventsCh {
    switch event.Type() {
    case events.EventTypeTextMessageStart:
        // Handle message start
    case events.EventTypeTextMessageChunk:
        // Handle text chunk
    case events.EventTypeToolCallStart:
        // Handle tool call start
    case events.EventTypeToolCallArgs:
        // Handle tool call arguments
    case events.EventTypeToolCallResult:
        // Handle tool call result
    }
}
```

## Features

- **Streaming adapter** - Translates Genkit `ModelResponseChunk` to AG-UI events
- **Text message support** - Emits `TEXT_MESSAGE_START` and `TEXT_MESSAGE_CHUNK` events
- **Tool call support** - Full support for tool requests and responses via `TOOL_CALL_*` events
- **State management** - Tracks chat status and message IDs across streaming chunks

## Event Types

The integration emits the following AG-UI events:

| Genkit Content | AG-UI Event |
|----------------|-------------|
| Text content (first chunk) | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CHUNK` |
| Text content (subsequent) | `TEXT_MESSAGE_CHUNK` |
| Tool request | `TOOL_CALL_START` + `TOOL_CALL_ARGS` |
| Tool response | `TOOL_CALL_RESULT` |

## Client Example

To connect to a Genkit server from a Go client using SSE:

```go
import (
    "context"
    "time"

    "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/client/sse"
    "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// Configure the SSE client
sseConfig := sse.Config{
    Endpoint:       "http://localhost:8000/agentic",
    ConnectTimeout: 30 * time.Second,
    ReadTimeout:    5 * time.Minute,
    BufferSize:     100,
}

client := sse.NewClient(sseConfig)
defer client.Close()

// Prepare the request payload
content := "Hello!"
payload := types.RunAgentInput{
    ThreadId: "session-123",
    RunId:    "run-456",
    Messages: []types.Message{
        {
            ID:      "msg-1",
            Role:    "user",
            Content: &content,
        },
    },
}

// Start the SSE stream
frames, errorCh, err := client.Stream(sse.StreamOptions{
    Context: ctx,
    Payload: payload,
})

// Process incoming events
for frame := range frames {
    // Parse and handle AG-UI events
}
```

## Running Tests

```bash
cd integrations/community/genkit/go/genkit
go test -v ./...
```
