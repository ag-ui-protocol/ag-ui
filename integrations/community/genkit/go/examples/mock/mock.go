package mock

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// MockResponse represents a simulated response configuration
type MockResponse struct {
	Text  string
	Delay time.Duration
}

// DefaultMockResponse returns a default mock response
func DefaultMockResponse() MockResponse {
	return MockResponse{
		Text:  "Hello! I'm a mock assistant running in demo mode. I can help you test the AG-UI protocol without requiring an API key. This response is being streamed word by word to demonstrate the SSE streaming capability.",
		Delay: 50 * time.Millisecond,
	}
}

// Generate simulates a streaming response by emitting AG-UI events
// It streams the response word by word with configurable delays
func Generate(ctx context.Context, response MockResponse, eventsCh chan<- events.Event) error {
	messageID := uuid.New().String()
	role := "assistant"

	// Emit TEXT_MESSAGE_START
	eventsCh <- events.NewTextMessageStartEvent(messageID, events.WithRole(role))

	// Split response into words and stream them
	words := strings.Fields(response.Text)
	for i, word := range words {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Add space before word (except first word)
		delta := word
		if i > 0 {
			delta = " " + word
		}

		// Emit TEXT_MESSAGE_CONTENT
		eventsCh <- events.NewTextMessageContentEvent(messageID, delta)

		// Simulate streaming delay
		if response.Delay > 0 {
			time.Sleep(response.Delay)
		}
	}

	// Emit TEXT_MESSAGE_END
	eventsCh <- events.NewTextMessageEndEvent(messageID)

	return nil
}

// GenerateFromPrompt generates a contextual mock response based on the user's message
func GenerateFromPrompt(ctx context.Context, userMessage string, eventsCh chan<- events.Event) error {
	var responseText string

	// Generate contextual responses based on keywords
	lowerMsg := strings.ToLower(userMessage)
	switch {
	case strings.Contains(lowerMsg, "hello") || strings.Contains(lowerMsg, "hi"):
		responseText = "Hello! I'm a mock Genkit assistant. I'm running in demo mode, which means I can demonstrate the AG-UI protocol without requiring an API key. How can I help you today?"
	case strings.Contains(lowerMsg, "help"):
		responseText = "I'm here to help! In demo mode, I can show you how the AG-UI protocol works with streaming responses. Try asking me questions or just chat with me to see the events flowing."
	case strings.Contains(lowerMsg, "test"):
		responseText = "Great! You're testing the Genkit AG-UI integration. This mock response demonstrates TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT (streaming chunks), and TEXT_MESSAGE_END events."
	case strings.Contains(lowerMsg, "stream"):
		responseText = "Streaming is a key feature of AG-UI! Each word you see appears one at a time, demonstrating real-time Server-Sent Events (SSE). This creates a smooth, ChatGPT-like experience."
	default:
		responseText = "Thank you for your message! I'm a mock assistant demonstrating the Genkit AG-UI integration. In production mode (without --mock-mode), I would connect to a real Genkit model to provide intelligent responses."
	}

	return Generate(ctx, MockResponse{
		Text:  responseText,
		Delay: 40 * time.Millisecond,
	}, eventsCh)
}
