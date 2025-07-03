package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
)

// TextMessageStartEvent indicates the start of a streaming text message
type TextMessageStartEvent struct {
	*BaseEvent
	MessageID string  `json:"messageId"`
	Role      *string `json:"role,omitempty"`
}

// NewTextMessageStartEvent creates a new text message start event
func NewTextMessageStartEvent(messageID string, options ...TextMessageStartOption) *TextMessageStartEvent {
	event := &TextMessageStartEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageStart),
		MessageID: messageID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// TextMessageStartOption defines options for creating text message start events
type TextMessageStartOption func(*TextMessageStartEvent)

// WithRole sets the role for the message
func WithRole(role string) TextMessageStartOption {
	return func(e *TextMessageStartEvent) {
		e.Role = &role
	}
}

// Validate validates the text message start event
func (e *TextMessageStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("message ID is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *TextMessageStartEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.TextMessageStartEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		MessageId: e.MessageID,
	}

	if e.Role != nil {
		pbEvent.Role = e.Role
	}

	return &generated.Event{
		Event: &generated.Event_TextMessageStart{
			TextMessageStart: pbEvent,
		},
	}, nil
}

// TextMessageContentEvent contains a piece of streaming text message content
type TextMessageContentEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	Delta     string `json:"delta"`
}

// NewTextMessageContentEvent creates a new text message content event
func NewTextMessageContentEvent(messageID, delta string) *TextMessageContentEvent {
	return &TextMessageContentEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageContent),
		MessageID: messageID,
		Delta:     delta,
	}
}

// Validate validates the text message content event
func (e *TextMessageContentEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("message ID is required")
	}

	if e.Delta == "" {
		return fmt.Errorf("delta must not be empty")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageContentEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *TextMessageContentEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.TextMessageContentEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		MessageId: e.MessageID,
		Delta:     e.Delta,
	}

	return &generated.Event{
		Event: &generated.Event_TextMessageContent{
			TextMessageContent: pbEvent,
		},
	}, nil
}

// TextMessageEndEvent indicates the end of a streaming text message
type TextMessageEndEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
}

// NewTextMessageEndEvent creates a new text message end event
func NewTextMessageEndEvent(messageID string) *TextMessageEndEvent {
	return &TextMessageEndEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageEnd),
		MessageID: messageID,
	}
}

// Validate validates the text message end event
func (e *TextMessageEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("message ID is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *TextMessageEndEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.TextMessageEndEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		MessageId: e.MessageID,
	}

	return &generated.Event{
		Event: &generated.Event_TextMessageEnd{
			TextMessageEnd: pbEvent,
		},
	}, nil
}
