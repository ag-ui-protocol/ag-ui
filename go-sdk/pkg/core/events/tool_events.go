package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
)

// ToolCallStartEvent indicates the start of a tool call
type ToolCallStartEvent struct {
	*BaseEvent
	ToolCallID      string  `json:"toolCallId"`
	ToolCallName    string  `json:"toolCallName"`
	ParentMessageID *string `json:"parentMessageId,omitempty"`
}

// NewToolCallStartEvent creates a new tool call start event
func NewToolCallStartEvent(toolCallID, toolCallName string, options ...ToolCallStartOption) *ToolCallStartEvent {
	event := &ToolCallStartEvent{
		BaseEvent:    NewBaseEvent(EventTypeToolCallStart),
		ToolCallID:   toolCallID,
		ToolCallName: toolCallName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// ToolCallStartOption defines options for creating tool call start events
type ToolCallStartOption func(*ToolCallStartEvent)

// WithParentMessageID sets the parent message ID for the tool call
func WithParentMessageID(parentMessageID string) ToolCallStartOption {
	return func(e *ToolCallStartEvent) {
		e.ParentMessageID = &parentMessageID
	}
}

// Validate validates the tool call start event
func (e *ToolCallStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("tool call ID is required")
	}

	if e.ToolCallName == "" {
		return fmt.Errorf("tool call name is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *ToolCallStartEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.ToolCallStartEvent{
		BaseEvent:    e.BaseEvent.ToProtobufBase(),
		ToolCallId:   e.ToolCallID,
		ToolCallName: e.ToolCallName,
	}

	if e.ParentMessageID != nil {
		pbEvent.ParentMessageId = e.ParentMessageID
	}

	return &generated.Event{
		Event: &generated.Event_ToolCallStart{
			ToolCallStart: pbEvent,
		},
	}, nil
}

// ToolCallArgsEvent contains streaming tool call arguments
type ToolCallArgsEvent struct {
	*BaseEvent
	ToolCallID string `json:"toolCallId"`
	Delta      string `json:"delta"`
}

// NewToolCallArgsEvent creates a new tool call args event
func NewToolCallArgsEvent(toolCallID, delta string) *ToolCallArgsEvent {
	return &ToolCallArgsEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallArgs),
		ToolCallID: toolCallID,
		Delta:      delta,
	}
}

// Validate validates the tool call args event
func (e *ToolCallArgsEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("tool call ID is required")
	}

	if e.Delta == "" {
		return fmt.Errorf("delta must not be empty")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallArgsEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *ToolCallArgsEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.ToolCallArgsEvent{
		BaseEvent:  e.BaseEvent.ToProtobufBase(),
		ToolCallId: e.ToolCallID,
		Delta:      e.Delta,
	}

	return &generated.Event{
		Event: &generated.Event_ToolCallArgs{
			ToolCallArgs: pbEvent,
		},
	}, nil
}

// ToolCallEndEvent indicates the end of a tool call
type ToolCallEndEvent struct {
	*BaseEvent
	ToolCallID string `json:"toolCallId"`
}

// NewToolCallEndEvent creates a new tool call end event
func NewToolCallEndEvent(toolCallID string) *ToolCallEndEvent {
	return &ToolCallEndEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallEnd),
		ToolCallID: toolCallID,
	}
}

// Validate validates the tool call end event
func (e *ToolCallEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("tool call ID is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *ToolCallEndEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.ToolCallEndEvent{
		BaseEvent:  e.BaseEvent.ToProtobufBase(),
		ToolCallId: e.ToolCallID,
	}

	return &generated.Event{
		Event: &generated.Event_ToolCallEnd{
			ToolCallEnd: pbEvent,
		},
	}, nil
}
