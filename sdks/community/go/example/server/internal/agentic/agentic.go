package agentic

import (
	"bufio"
	"context"
	_ "embed"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/mcp"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/tmc/langchaingo/agents"
	"github.com/tmc/langchaingo/chains"
	"github.com/tmc/langchaingo/llms/anthropic"
	"golang.org/x/sync/errgroup"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	langchaingoTools "github.com/tmc/langchaingo/tools"
)

// reminder is a reminder for the AI to output in our expected format.
//
//go:embed data/reminder.md
var reminder string

func CallLLM(ctx context.Context, input string, tools []langchaingoTools.Tool, returnChan chan<- string) error {
	// adapter for the mcp server defined in sdks/community/go/example/server/internal/mcp
	// this mcp server starts with the Fiber server in sdks/community/go/example/server/cmd/main.go
	adapter, err := mcp.NewAdapter(fmt.Sprintf("http://127.0.0.1:%d/mcp", mcp.DefaultPort))

	if err != nil {
		return fmt.Errorf("new mcp adapter: %w", err)
	}

	_, err = adapter.Tools()
	if err != nil {
		return fmt.Errorf("append tools: %w", err)
	}

	llm, err := anthropic.New(anthropic.WithModel("claude-3-haiku-20240307"))
	if err != nil {
		return fmt.Errorf("failed to create LLM client: %w", err)
	}

	agent := agents.NewOneShotAgent(llm,
		tools,
		agents.WithMaxIterations(50))

	executor := agents.NewExecutor(agent, agents.WithCallbacksHandler(NewHandler(returnChan)))

	inputMap := make(map[string]any)
	inputMap["input"] = input + "\n" + reminder

	result, err := chains.Call(ctx, executor, inputMap)
	if err != nil {
		return fmt.Errorf("run chain: %w", err)
	}
	output := result["output"].(string)

	// Create a proper event for the final output
	messageID := events.GenerateMessageID()
	finalMessage := events.NewTextMessageContentEvent(messageID, output)
	if jsonData, err := finalMessage.ToJSON(); err == nil {
		returnChan <- string(jsonData)
	}

	return nil
}

func ProcessInput(ctx context.Context, w *bufio.Writer, sseWriter *sse.SSEWriter, input string) error {
	resultChan := make(chan string)
	g, groupCtx := errgroup.WithContext(ctx)

	g.Go(func() error {
		for {
			select {
			case result := <-resultChan:
				if result == "" {
					return nil
				}

				// All messages from the handler should now be proper JSON events
				// WriteBytes will format them as SSE frames with "data: " prefix
				if err := sseWriter.WriteBytes(ctx, w, []byte(result)); err != nil {
					return fmt.Errorf("failed to write event: %w", err)
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})

	g.Go(func() error {
		callLLMErr := CallLLM(groupCtx, input, nil, resultChan)
		close(resultChan)
		return callLLMErr
	})

	return g.Wait()
}
