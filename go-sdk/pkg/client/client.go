package client

import (
	"context"
	"fmt"
	"net/url"

	"github.com/ag-ui/go-sdk/pkg/core"
)

// Client represents a connection to an AG-UI server.
type Client struct {
	// baseURL is the base URL of the AG-UI server
	baseURL *url.URL

	// TODO: Add transport layer, connection pool, and other client state
}

// Config contains configuration options for the client.
type Config struct {
	// BaseURL is the base URL of the AG-UI server
	BaseURL string

	// TODO: Add authentication, timeout, retry configuration, etc.
}

// New creates a new AG-UI client with the specified configuration.
func New(config Config) (*Client, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid base URL: %w", err)
	}

	return &Client{
		baseURL: baseURL,
	}, nil
}

// SendEvent sends an event to the specified agent and returns the response.
func (c *Client) SendEvent(ctx context.Context, agentName string, event core.Event) ([]core.Event, error) {
	// TODO: Implement event sending via transport layer
	return nil, fmt.Errorf("not implemented")
}

// Stream opens a streaming connection to the specified agent.
func (c *Client) Stream(ctx context.Context, agentName string) (<-chan core.Event, error) {
	// TODO: Implement streaming connection
	return nil, fmt.Errorf("not implemented")
}

// Close closes the client and releases any resources.
func (c *Client) Close() error {
	// TODO: Implement resource cleanup
	return nil
}
