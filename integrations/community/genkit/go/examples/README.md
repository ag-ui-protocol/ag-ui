# Genkit AG-UI Example Server

This example demonstrates how to build an AG-UI compatible server using Firebase Genkit and Go.

## Quick Start

### Demo Mode (No API Key Required)

Run the server in mock mode to test the AG-UI protocol without needing an API key:

```bash
cd integrations/community/genkit/go/examples
go run ./cmd/server --mock-mode
```

### Production Mode

To use real Genkit models, set your Google API key:

```bash
export GOOGLE_API_KEY=your_api_key_here
go run ./cmd/server
```

## Configuration

The server can be configured via environment variables or command-line flags:

| Environment Variable | Flag | Default | Description |
|---------------------|------|---------|-------------|
| `GENKIT_HOST` | `--host` | `0.0.0.0` | Server host address |
| `GENKIT_PORT` | `--port` | `8000` | Server port |
| `GENKIT_MOCK_MODE` | `--mock-mode` | `false` | Enable mock mode |
| `GOOGLE_API_KEY` | `--api-key` | - | Google/Genkit API key |
| `GENKIT_MODEL` | `--model` | `googleai/gemini-2.0-flash` | Genkit model to use |

## API Endpoints

### Health Check
```bash
GET /
```

Returns server health status:
```json
{
  "status": "healthy",
  "service": "genkit-ag-ui-example",
  "mock_mode": true
}
```

### List Agents
```bash
GET /agents
```

Returns available agents:
```json
{
  "agents": [
    {
      "name": "agentic_chat",
      "description": "An example agentic chat flow using Firebase Genkit and AG-UI protocol."
    }
  ]
}
```

### Run Agent
```bash
POST /agent/:name
Content-Type: application/json

{
  "threadId": "optional-thread-id",
  "runId": "optional-run-id",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ]
}
```

Returns a Server-Sent Events (SSE) stream:
```
data: {"type":"RUN_STARTED","threadId":"...","runId":"...","timestamp":...}

data: {"type":"TEXT_MESSAGE_START","messageId":"...","role":"assistant","timestamp":...}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"Hello","timestamp":...}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"!","timestamp":...}

data: {"type":"TEXT_MESSAGE_END","messageId":"...","timestamp":...}

data: {"type":"RUN_FINISHED","threadId":"...","runId":"...","timestamp":...}
```

## Testing with cURL

### Basic Request
```bash
curl -X POST http://localhost:8000/agent/agentic_chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

### With Thread ID
```bash
curl -X POST http://localhost:8000/agent/agentic_chat \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "my-thread-1",
    "runId": "run-1",
    "messages": [
      {"role": "user", "content": "What is AG-UI?"}
    ]
  }'
```

## Testing with AG-UI Dojo

1. Start the server:
   ```bash
   go run ./cmd/server --mock-mode
   ```

2. Open the AG-UI Dojo app

3. Configure a custom agent endpoint:
   - URL: `http://localhost:8000/agent/agentic_chat`
   - Method: POST

4. Send messages and observe the SSE event stream

## Event Flow

The server emits events in the following order:

```
RUN_STARTED
  ↓
TEXT_MESSAGE_START (role: assistant)
  ↓
TEXT_MESSAGE_CONTENT (delta: "word1") ← repeated for each chunk
TEXT_MESSAGE_CONTENT (delta: " word2")
TEXT_MESSAGE_CONTENT (delta: " word3")
  ↓
TEXT_MESSAGE_END
  ↓
RUN_FINISHED
```

## Project Structure

```
examples/
├── cmd/
│   └── server/
│       └── main.go           # Server entry point
├── internal/
│   ├── config/
│   │   └── config.go         # Configuration management
│   ├── handlers/
│   │   └── agent.go          # HTTP handlers
│   └── agents/
│       ├── registry.go       # Agent registration
│       └── agentic_chat/
│           └── agent.go      # Agentic chat implementation
├── mock/
│   └── mock.go               # Mock model for demo mode
├── go.mod
├── go.sum
└── README.md
```

## Extending the Server

### Adding a New Agent

1. Create a new package under `internal/agents/`:
   ```go
   package my_agent

   import (
       "context"
       "github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/examples/internal/agents"
       "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
   )

   type MyAgent struct{}

   func NewMyAgent() *MyAgent {
       return &MyAgent{}
   }

   func (a *MyAgent) Name() string {
       return "my_agent"
   }

   func (a *MyAgent) Description() string {
       return "Description of my agent"
   }

   func (a *MyAgent) Run(ctx context.Context, input agents.RunAgentInput, eventsCh chan<- events.Event) error {
       // Emit TEXT_MESSAGE_START
       messageID := "msg-1"
       eventsCh <- events.NewTextMessageStartEvent(messageID, events.WithRole("assistant"))

       // Emit content chunks
       eventsCh <- events.NewTextMessageContentEvent(messageID, "Hello from my agent!")

       // Emit TEXT_MESSAGE_END
       eventsCh <- events.NewTextMessageEndEvent(messageID)

       return nil
   }
   ```

2. Register the agent in `main.go`:
   ```go
   myAgent := my_agent.NewMyAgent()
   registry.Register(myAgent)
   ```

3. Access via: `POST /agent/my_agent`

## License

See the main AG-UI repository for license information.
