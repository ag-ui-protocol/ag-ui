package agentic_chat

import (
	"context"
	"fmt"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/genkit"
	"github.com/google/uuid"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"

	"github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/examples/internal/agents"
	"github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/examples/mock"
)

// AgenticChatAgent implements a simple chat agent using Genkit
type AgenticChatAgent struct {
	mockMode  bool
	registry  *genkit.Genkit
	modelName string
}

// NewAgenticChatAgent creates a new agentic chat agent
func NewAgenticChatAgent(mockMode bool, registry *genkit.Genkit, modelName string) *AgenticChatAgent {
	return &AgenticChatAgent{
		mockMode:  mockMode,
		registry:  registry,
		modelName: modelName,
	}
}

// Name returns the agent's name
func (a *AgenticChatAgent) Name() string {
	return "agentic_chat"
}

// Description returns a brief description of the agent
func (a *AgenticChatAgent) Description() string {
	return "An example agentic chat flow using Firebase Genkit and AG-UI protocol."
}

// Run executes the agent with the given input and streams events to the channel
func (a *AgenticChatAgent) Run(ctx context.Context, input agents.RunAgentInput, eventsCh chan<- events.Event) error {
	// Get the last user message
	var userMessage string
	for i := len(input.Messages) - 1; i >= 0; i-- {
		if input.Messages[i].Role == "user" {
			userMessage = input.Messages[i].Content
			break
		}
	}

	if a.mockMode {
		// Use mock generation for demo mode
		return mock.GenerateFromPrompt(ctx, userMessage, eventsCh)
	}

	// Real mode: use Genkit to generate a response
	return a.runWithGenkit(ctx, input, eventsCh)
}

// runWithGenkit runs the agent using the real Genkit model
func (a *AgenticChatAgent) runWithGenkit(ctx context.Context, input agents.RunAgentInput, eventsCh chan<- events.Event) error {
	if a.registry == nil {
		return fmt.Errorf("genkit registry not configured - ensure GOOGLE_API_KEY is set or use --mock-mode")
	}

	// Convert messages to Genkit format
	var genkitMessages []*ai.Message
	for _, msg := range input.Messages {
		genkitMessages = append(genkitMessages, ai.NewUserTextMessage(msg.Content))
	}

	// Generate message ID for tracking
	messageID := uuid.New().String()
	messageStarted := false
	role := "assistant"

	// Stream the response using GenerateStream
	for chunk, err := range genkit.GenerateStream(ctx, a.registry,
		ai.WithModelName(a.modelName),
		ai.WithMessages(genkitMessages...),
	) {
		if err != nil {
			return fmt.Errorf("genkit generation failed: %w", err)
		}

		if chunk.Done {
			// Final response - close the message if one was started
			if messageStarted {
				eventsCh <- events.NewTextMessageEndEvent(messageID)
			}
			break
		}

		// Process the streaming chunk
		text := chunk.Chunk.Text()
		if text != "" {
			if !messageStarted {
				// Start a new message
				eventsCh <- events.NewTextMessageStartEvent(messageID, events.WithRole(role))
				messageStarted = true
			}
			// Stream the content chunk
			eventsCh <- events.NewTextMessageContentEvent(messageID, text)
		}
	}

	return nil
}
