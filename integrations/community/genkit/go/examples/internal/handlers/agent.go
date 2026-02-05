package handlers

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"sync"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"

	"github.com/ag-ui-protocol/ag-ui/integrations/community/genkit/go/examples/internal/agents"
)

// AgentHandler handles agent-related HTTP requests
type AgentHandler struct {
	registry  *agents.Registry
	sseWriter *sse.SSEWriter
}

// NewAgentHandler creates a new agent handler
func NewAgentHandler(registry *agents.Registry) *AgentHandler {
	return &AgentHandler{
		registry:  registry,
		sseWriter: sse.NewSSEWriter(),
	}
}

// HandleAgentRun handles POST requests to run an agent
func (h *AgentHandler) HandleAgentRun(c fiber.Ctx) error {
	agentName := c.Params("agent")

	// Get the agent from registry
	agent, ok := h.registry.Get(agentName)
	if !ok {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "agent not found",
			"name":  agentName,
		})
	}

	// Parse the request body
	var input agents.RunAgentInput
	if err := json.Unmarshal(c.Body(), &input); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":   "invalid request body",
			"details": err.Error(),
		})
	}

	// Generate IDs if not provided
	if input.ThreadID == "" {
		input.ThreadID = uuid.New().String()
	}
	if input.RunID == "" {
		input.RunID = uuid.New().String()
	}

	// Set SSE headers
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("Transfer-Encoding", "chunked")
	c.Set("X-Accel-Buffering", "no")

	// Create a pipe for streaming
	pr, pw := io.Pipe()

	// Create a channel for events
	eventsCh := make(chan events.Event, 100)

	// Use a WaitGroup to ensure the agent completes before we exit
	var wg sync.WaitGroup
	wg.Add(1)

	// Create a context for the agent that we control
	ctx, cancel := context.WithCancel(context.Background())

	// Start the agent in a goroutine
	go func() {
		defer wg.Done()
		defer close(eventsCh)

		// Send RUN_STARTED event
		eventsCh <- events.NewRunStartedEvent(input.ThreadID, input.RunID)

		// Run the agent
		if err := agent.Run(ctx, input, eventsCh); err != nil {
			// Send error event
			eventsCh <- events.NewRunErrorEvent(err.Error(), events.WithRunID(input.RunID))
			return
		}

		// Send RUN_FINISHED event
		eventsCh <- events.NewRunFinishedEvent(input.ThreadID, input.RunID)
	}()

	// Start a goroutine to write events to the pipe
	go func() {
		defer pw.Close()
		defer cancel()

		// Stream events as they come in
		for event := range eventsCh {
			if err := h.sseWriter.WriteEvent(ctx, pw, event); err != nil {
				log.Printf("Error writing SSE event: %v", err)
				break
			}
		}

		// Wait for the agent to complete
		wg.Wait()
	}()

	// Stream the response
	return c.SendStream(pr)
}

// HandleListAgents handles GET requests to list all agents
func (h *AgentHandler) HandleListAgents(c fiber.Ctx) error {
	agentList := h.registry.List()
	response := make([]fiber.Map, 0, len(agentList))
	for _, agent := range agentList {
		response = append(response, fiber.Map{
			"name":        agent.Name(),
			"description": agent.Description(),
		})
	}
	return c.JSON(fiber.Map{
		"agents": response,
	})
}
