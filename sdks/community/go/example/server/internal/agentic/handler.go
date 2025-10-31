package agentic

import (
	"context"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/tmc/langchaingo/llms"
	"github.com/tmc/langchaingo/schema"
)

type Handler struct {
	returnChan chan<- string
	// ID tracking for event correlation
	threadID   string
	runID      string
	messageID  string
	toolCallID string
	stepID     string
}

func NewHandler(returnChan chan<- string) *Handler {
	return &Handler{
		returnChan: returnChan,
		threadID:   events.GenerateThreadID(),
		runID:      events.GenerateRunID(),
	}
}

func (h *Handler) HandleText(ctx context.Context, text string) {
	message := events.NewTextMessageContentEvent("test", text)
	if jsonData, err := message.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleLLMStart(ctx context.Context, prompts []string) {
	// Generate new message ID for this LLM interaction
	h.messageID = events.GenerateMessageID()

	// Send run started event
	runStartedEvent := events.NewRunStartedEvent(h.threadID, h.runID)
	if jsonData, err := runStartedEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}

	// Send text message start event
	textStartEvent := events.NewTextMessageStartEvent(h.messageID, events.WithRole("assistant"))
	if jsonData, err := textStartEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleLLMGenerateContentStart(ctx context.Context, ms []llms.MessageContent) {
	// Generate new message ID if not already set
	if h.messageID == "" {
		h.messageID = events.GenerateMessageID()
	}

	// Determine role from message content
	role := "assistant"
	if len(ms) > 0 {
		// Check if this is from a tool or user
		for _, m := range ms {
			if len(m.Parts) > 0 {
				if _, ok := m.Parts[0].(llms.ToolCallResponse); ok {
					role = "tool"
					break
				}
			}
		}
	}

	// Send text message start event
	textStartEvent := events.NewTextMessageStartEvent(h.messageID, events.WithRole(role))
	if jsonData, err := textStartEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleLLMGenerateContentEnd(ctx context.Context, res *llms.ContentResponse) {
	// Send text message end event
	if h.messageID != "" {
		textEndEvent := events.NewTextMessageEndEvent(h.messageID)
		if jsonData, err := textEndEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
	}

	// Reset message ID for next interaction
	h.messageID = ""
}

func (h *Handler) HandleLLMError(ctx context.Context, err error) {
	// Send error as text message if we have an active message
	if h.messageID != "" {
		errorMessage := events.NewTextMessageContentEvent(h.messageID, "Error: "+err.Error())
		if jsonData, err := errorMessage.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		// End the message
		textEndEvent := events.NewTextMessageEndEvent(h.messageID)
		if jsonData, err := textEndEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
		h.messageID = ""
	}
}

func (h *Handler) HandleChainStart(ctx context.Context, inputs map[string]any) {
	// Generate step ID for this chain execution
	h.stepID = events.GenerateStepID()

	// Send step started event with step name
	stepStartedEvent := events.NewStepStartedEvent(h.stepID)
	if jsonData, err := stepStartedEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleChainEnd(ctx context.Context, outputs map[string]any) {
	// Send step finished event
	if h.stepID != "" {
		stepFinishedEvent := events.NewStepFinishedEvent(h.stepID)
		if jsonData, err := stepFinishedEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
		h.stepID = ""
	}
}

func (h *Handler) HandleChainError(ctx context.Context, err error) {
	// Send error event for chain
	if h.stepID != "" {
		// Create error message
		if h.messageID == "" {
			h.messageID = events.GenerateMessageID()
		}
		errorMessage := events.NewTextMessageContentEvent(h.messageID, "Chain error: "+err.Error())
		if jsonData, err := errorMessage.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		// Mark step as finished even with error
		stepFinishedEvent := events.NewStepFinishedEvent(h.stepID)
		if jsonData, err := stepFinishedEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
		h.stepID = ""
	}
}

func (h *Handler) HandleToolStart(ctx context.Context, input string) {
	// Generate tool call ID
	h.toolCallID = events.GenerateToolCallID()

	// Extract tool name from input if possible
	toolName := "tool"

	// Send tool call start event
	toolStartEvent := events.NewToolCallStartEvent(h.toolCallID, toolName)
	if h.messageID != "" {
		toolStartEvent = events.NewToolCallStartEvent(h.toolCallID, toolName, events.WithParentMessageID(h.messageID))
	}
	if jsonData, err := toolStartEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}

	// Send tool arguments
	toolArgsEvent := events.NewToolCallArgsEvent(h.toolCallID, input)
	if jsonData, err := toolArgsEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleToolEnd(ctx context.Context, output string) {
	if h.toolCallID != "" {
		// Send tool call end event
		toolEndEvent := events.NewToolCallEndEvent(h.toolCallID)
		if jsonData, err := toolEndEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		// Send tool call result event
		resultMessageID := events.GenerateMessageID()
		toolResultEvent := events.NewToolCallResultEvent(resultMessageID, h.toolCallID, output)
		if jsonData, err := toolResultEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		h.toolCallID = ""
	}
}

func (h *Handler) HandleToolError(ctx context.Context, err error) {
	if h.toolCallID != "" {
		// Send error as tool result
		resultMessageID := events.GenerateMessageID()
		toolResultEvent := events.NewToolCallResultEvent(resultMessageID, h.toolCallID, "Error: "+err.Error())
		if jsonData, err := toolResultEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		// Send tool call end event
		toolEndEvent := events.NewToolCallEndEvent(h.toolCallID)
		if jsonData, err := toolEndEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}

		h.toolCallID = ""
	}
}

func (h *Handler) HandleAgentAction(ctx context.Context, action schema.AgentAction) {
	// Agent is taking an action (usually a tool call)
	// Generate tool call ID if not already set
	if h.toolCallID == "" {
		h.toolCallID = events.GenerateToolCallID()
	}

	// Send tool call start event for the action
	toolStartEvent := events.NewToolCallStartEvent(h.toolCallID, action.Tool)
	if h.messageID != "" {
		toolStartEvent = events.NewToolCallStartEvent(h.toolCallID, action.Tool, events.WithParentMessageID(h.messageID))
	}
	if jsonData, err := toolStartEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}

	// Send the tool input as arguments
	toolArgsEvent := events.NewToolCallArgsEvent(h.toolCallID, action.ToolInput)
	if jsonData, err := toolArgsEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleAgentFinish(ctx context.Context, finish schema.AgentFinish) {
	// Agent has finished its run
	// Send final message if we have output
	if finish.ReturnValues != nil {
		if output, ok := finish.ReturnValues["output"].(string); ok && output != "" {
			if h.messageID == "" {
				h.messageID = events.GenerateMessageID()
			}
			finalMessage := events.NewTextMessageContentEvent(h.messageID, output)
			if jsonData, err := finalMessage.ToJSON(); err == nil {
				h.returnChan <- string(jsonData)
			}

			// End the message
			textEndEvent := events.NewTextMessageEndEvent(h.messageID)
			if jsonData, err := textEndEvent.ToJSON(); err == nil {
				h.returnChan <- string(jsonData)
			}
		}
	}

	// Send run finished event
	runFinishedEvent := events.NewRunFinishedEvent(h.threadID, h.runID)
	if jsonData, err := runFinishedEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleRetrieverStart(ctx context.Context, query string) {
	// Start a retrieval operation
	if h.messageID == "" {
		h.messageID = events.GenerateMessageID()
	}

	// Send a message indicating retrieval is starting
	retrievalMessage := events.NewTextMessageContentEvent(h.messageID, "Searching for: "+query)
	if jsonData, err := retrievalMessage.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}

func (h *Handler) HandleRetrieverEnd(ctx context.Context, query string, documents []schema.Document) {
	// Retrieval operation completed
	if h.messageID != "" {
		// Send message about retrieval results
		resultMsg := fmt.Sprintf("Found %d documents for query: %s", len(documents), query)
		retrievalResult := events.NewTextMessageContentEvent(h.messageID, resultMsg)
		if jsonData, err := retrievalResult.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
	}
}

func (h *Handler) HandleStreamingFunc(ctx context.Context, chunk []byte) {
	// Handle streaming content chunks
	if h.messageID == "" {
		h.messageID = events.GenerateMessageID()
		// Send start event for streaming
		textStartEvent := events.NewTextMessageStartEvent(h.messageID, events.WithRole("assistant"))
		if jsonData, err := textStartEvent.ToJSON(); err == nil {
			h.returnChan <- string(jsonData)
		}
	}

	// Send the chunk as content
	chunkStr := string(chunk)
	contentEvent := events.NewTextMessageContentEvent(h.messageID, chunkStr)
	if jsonData, err := contentEvent.ToJSON(); err == nil {
		h.returnChan <- string(jsonData)
	}
}
