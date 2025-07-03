package client

import (
	"context"
	"errors"
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
	if config.BaseURL == "" {
		return nil, &core.ConfigError{
			Field: "BaseURL",
			Value: config.BaseURL,
			Err:   errors.New("base URL cannot be empty"),
		}
	}

	baseURL, err := url.Parse(config.BaseURL)
	if err != nil {
		return nil, &core.ConfigError{
			Field: "BaseURL",
			Value: config.BaseURL,
			Err:   fmt.Errorf("invalid base URL: %w", err),
		}
	}

	return &Client{
		baseURL: baseURL,
	}, nil
}

// SendEvent sends an event to the specified agent and returns the response.
func (c *Client) SendEvent(ctx context.Context, agentName string, event interface{}) ([]interface{}, error) {
	if agentName == "" {
		return nil, &core.ConfigError{
			Field: "agentName",
			Value: agentName,
			Err:   errors.New("agent name cannot be empty"),
		}
	}

	if event == nil {
		return nil, &core.ConfigError{
			Field: "event",
			Value: event,
			Err:   errors.New("event cannot be nil"),
		}
	}

	// TODO: Implement event sending via transport layer (Issue #123)
	return nil, fmt.Errorf("SendEvent for agent %s: %w", agentName, core.ErrNotImplemented)
}

// Stream opens a streaming connection to the specified agent.
func (c *Client) Stream(ctx context.Context, agentName string) (<-chan interface{}, error) {
	if agentName == "" {
		return nil, &core.ConfigError{
			Field: "agentName",
			Value: agentName,
			Err:   errors.New("agent name cannot be empty"),
		}
	}

	// TODO: Implement streaming connection (Issue #124)
	return nil, fmt.Errorf("Stream for agent %s: %w", agentName, core.ErrNotImplemented)
}

// Close closes the client and releases any resources.
func (c *Client) Close() error {
	// TODO: Implement resource cleanup
	return nil
}
