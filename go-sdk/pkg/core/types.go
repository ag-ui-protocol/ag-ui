package core

import (
	"context"
	"time"
)

// Event represents a protocol event in the AG-UI system.
// Events flow bidirectionally between agents and front-end applications.
type Event interface {
	// ID returns the unique identifier for this event
	ID() string

	// Type returns the event type (e.g., "message", "state_update", "tool_call")
	Type() string

	// Timestamp returns when the event was created
	Timestamp() time.Time

	// Data returns the event payload
	Data() interface{}
}

// Agent represents an AI agent that can process events and generate responses.
// Agents are the core abstraction in the AG-UI protocol.
type Agent interface {
	// HandleEvent processes an incoming event and optionally returns response events
	HandleEvent(ctx context.Context, event Event) ([]Event, error)

	// Name returns the agent's identifier
	Name() string

	// Description returns a human-readable description of the agent's capabilities
	Description() string
}

// EventHandler is a function type for handling specific event types.
type EventHandler func(ctx context.Context, event Event) ([]Event, error)

// StreamConfig contains configuration for event streaming.
type StreamConfig struct {
	// BufferSize is the size of the event buffer
	BufferSize int

	// Timeout is the maximum time to wait for events
	Timeout time.Duration

	// EnableCompression enables event compression during transport
	EnableCompression bool
}

// TODO: Additional core types will be defined here as the protocol specification
// is implemented in subsequent development phases.
