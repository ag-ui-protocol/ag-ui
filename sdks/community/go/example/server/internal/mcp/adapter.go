package mcp

import (
	"fmt"
	"time"

	mcpadapter "github.com/i2y/langchaingo-mcp-adapter"
	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	langchaingoTools "github.com/tmc/langchaingo/tools"
)

type Adapter struct {
	adapter   *mcpadapter.MCPAdapter
	mcpClient *client.Client
}

func NewAdapter(endpoint string) (*Adapter, error) {
	httpTransport, err := getTransport(endpoint)
	if err != nil {
		return nil, err
	}
	mcpClient := client.NewClient(httpTransport)

	adapter, err := mcpadapter.New(mcpClient, mcpadapter.WithToolTimeout(30*time.Second))
	if err != nil {
		return nil, fmt.Errorf("new mcp adapter: %w", err)
	}
	return &Adapter{
		adapter:   adapter,
		mcpClient: mcpClient,
	}, nil
}

func (a *Adapter) Close() error {
	return a.mcpClient.Close()
}

func (a *Adapter) Tools() ([]langchaingoTools.Tool, error) {
	return a.adapter.Tools()
}

func getTransport(endpoint string) (transport.Interface, error) {
	httpTransport, err := transport.NewStreamableHTTP(
		endpoint, // Replace with your MCP server URL
		// You can add HTTP-specific options here like headers, OAuth, etc.
	)
	if err != nil {
		return nil, fmt.Errorf("create transport: %w", err)
	}
	return httpTransport, nil
}
