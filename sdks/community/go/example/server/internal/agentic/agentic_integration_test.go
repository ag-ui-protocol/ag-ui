package agentic

import (
	"context"
	_ "embed"
	"os"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/mcp"
	"github.com/stretchr/testify/require"
	"golang.org/x/sync/errgroup"
)

//go:embed data/client_prompt.md
var client_prompt string

//go:embed data/languages_prompt.md
var languages_prompt string

// Verifies agent communication is working and it can call tools we pass to it
func TestToolCalls(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test")
	}
	mcpServer, err := mcp.NewServer(mcp.DefaultPort)
	require.NoError(t, err)
	go func() {
		mcpErr := mcpServer.Start()
		if mcpErr != nil {
			require.NoError(t, mcpErr)
		}
	}()

	ctx := context.Background()
	resultChan := make(chan string)
	g, groupCtx := errgroup.WithContext(ctx)
	var results []string

	g.Go(func() error {
		for {
			select {
			case result := <-resultChan:
				if result == "" {
					return nil
				}
				results = append(results, result)
			case <-groupCtx.Done():
				return groupCtx.Err()
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})

	g.Go(func() error {
		callErr := CallLLM(groupCtx, languages_prompt, nil, resultChan)
		close(resultChan)
		return callErr
	})

	if err = g.Wait(); err != nil {
		require.NoError(t, err)
	}
	require.NoError(t, err)
	require.NotEmpty(t, results)
}
