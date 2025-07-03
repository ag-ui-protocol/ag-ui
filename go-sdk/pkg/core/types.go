package core

import (
	"context"
	"time"
)

// Event represents a protocol event in the AG-UI system with type-safe data.
// Events flow bidirectionally between agents and front-end applications.
type Event[T any] interface {
	// ID returns the unique identifier for this event
	ID() string

	// Type returns the event type (e.g., "message", "state_update", "tool_call")
	Type() string

	// Timestamp returns when the event was created
	Timestamp() time.Time

	// Data returns the typed event payload
	Data() T
}

// BaseEvent provides a common implementation for events
type BaseEvent[T any] struct {
	id        string
	eventType string
	timestamp time.Time
	data      T
}

func (e BaseEvent[T]) ID() string           { return e.id }
func (e BaseEvent[T]) Type() string         { return e.eventType }
func (e BaseEvent[T]) Timestamp() time.Time { return e.timestamp }
func (e BaseEvent[T]) Data() T              { return e.data }

// NewEvent creates a new event with the given parameters
func NewEvent[T any](id, eventType string, data T) Event[T] {
	return BaseEvent[T]{
		id:        id,
		eventType: eventType,
		timestamp: time.Now(),
		data:      data,
	}
}

// Concrete event data types
type MessageData struct {
	Content string `json:"content"`
	Sender  string `json:"sender"`
}

type StateData struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
}

type ToolData struct {
	ToolName string                 `json:"tool_name"`
	Args     map[string]interface{} `json:"args"`
	Result   interface{}            `json:"result,omitempty"`
}

// Concrete event types
type MessageEvent = Event[MessageData]
type StateEvent = Event[StateData]
type ToolEvent = Event[ToolData]

// Agent represents an AI agent that can process events and generate responses.
// Agents are the core abstraction in the AG-UI protocol.
type Agent interface {
	// HandleEvent processes an incoming event and optionally returns response events
	// Note: Returns generic events - agents must handle type assertions as needed
	HandleEvent(ctx context.Context, event interface{}) ([]interface{}, error)

	// Name returns the agent's identifier
	Name() string

	// Description returns a human-readable description of the agent's capabilities
	Description() string
}

// EventHandler is a function type for handling specific event types.
type EventHandler[T any] func(ctx context.Context, event Event[T]) ([]interface{}, error)

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
