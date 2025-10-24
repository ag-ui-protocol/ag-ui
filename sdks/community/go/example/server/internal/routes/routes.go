package routes

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/agentic"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/gofiber/fiber/v3"
)

// AgenticInput represents the input structure for the tool-based generative UI endpoint
type AgenticInput struct {
	ThreadID       string                   `json:"thread_id"`
	RunID          string                   `json:"run_id"`
	State          interface{}              `json:"state"`
	Messages       []map[string]interface{} `json:"messages"`
	Tools          []interface{}            `json:"tools"`
	Context        []interface{}            `json:"context"`
	ForwardedProps interface{}              `json:"forwarded_props"`
}

// AgenticHandler creates a Fiber handler for the tool-based generative UI route
func AgenticHandler(cfg *config.Config) fiber.Handler {
	logger := slog.Default()
	sseWriter := sse.NewSSEWriter().WithLogger(logger)

	return func(c fiber.Ctx) error {
		// Extract request metadata
		requestID := c.Locals("requestid")
		if requestID == nil {
			requestID = "unknown"
		}

		logCtx := []any{
			"request_id", requestID,
			"route", c.Route().Path,
			"method", c.Method(),
		}

		// Parse request body first before setting headers
		var input AgenticInput
		if err := c.Bind().JSON(&input); err != nil {
			logger.Error("Failed to parse request body", append(logCtx, "error", err)...)
			return c.Status(400).JSON(fiber.Map{
				"error": "Invalid request body",
			})
		}

		// Set SSE headers after validation
		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("Access-Control-Allow-Origin", "*")
		c.Set("Access-Control-Allow-Headers", "Cache-Control")

		logger.Info("Tool-based generative UI SSE connection established", logCtx...)

		// Get request context for cancellation
		ctx := c.RequestCtx()

		// Start streaming
		return c.SendStreamWriter(func(w *bufio.Writer) {
			if err := streamAgenticEvents(ctx, w, sseWriter, &input, cfg, logger, logCtx); err != nil {
				logger.Error("Error streaming tool-based generative UI events", append(logCtx, "error", err)...)
			}
		})
	}
}

// streamAgenticEvents implements the tool-based generative UI event sequence
func streamAgenticEvents(reqCtx context.Context, w *bufio.Writer, sseWriter *sse.SSEWriter, input *AgenticInput, _ *config.Config, logger *slog.Logger, logCtx []any) error {
	// Use IDs from input or generate new ones if not provided
	threadID := input.ThreadID
	if threadID == "" {
		threadID = events.GenerateThreadID()
	}
	runID := input.RunID
	if runID == "" {
		runID = events.GenerateRunID()
	}

	// Create a wrapped context for our operations
	ctx := context.Background()

	// Send RUN_STARTED event
	runStarted := events.NewRunStartedEvent(threadID, runID)
	if err := sseWriter.WriteEvent(ctx, w, runStarted); err != nil {
		return fmt.Errorf("failed to write RUN_STARTED event: %w", err)
	}

	// Check for cancellation
	if err := reqCtx.Err(); err != nil {
		logger.Debug("Client disconnected during RUN_STARTED", append(logCtx, "reason", "context_canceled")...)
		return nil
	}

	// Grab last message from input, will be a user message
	var lastMessage map[string]interface{}
	if len(input.Messages) > 0 {
		lastMessage = input.Messages[len(input.Messages)-1]
	}
	// grab "content" field if it exists
	content, ok := lastMessage["content"].(string)
	if !ok {
		return fmt.Errorf("last message does not have content")
	}

	err := agentic.ProcessInput(ctx, w, sseWriter, content)
	if err != nil {
		return fmt.Errorf("failed to process input: %w", err)

	}

	// Check for cancellation before final event
	if err = reqCtx.Err(); err != nil {
		return fmt.Errorf("client disconnected before RUN_FINISHED: %w", err)
	}

	// Send RUN_FINISHED event
	runFinished := events.NewRunFinishedEvent(threadID, runID)
	if err := sseWriter.WriteEvent(ctx, w, runFinished); err != nil {
		return fmt.Errorf("failed to write RUN_FINISHED event: %w", err)
	}

	return nil
}
