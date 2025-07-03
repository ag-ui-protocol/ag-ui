package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
	"google.golang.org/protobuf/types/known/structpb"
)

// RawEvent contains raw event data that should be passed through without processing
type RawEvent struct {
	*BaseEvent
	Event  any     `json:"event"`
	Source *string `json:"source,omitempty"`
}

// NewRawEvent creates a new raw event
func NewRawEvent(event any, options ...RawEventOption) *RawEvent {
	rawEvent := &RawEvent{
		BaseEvent: NewBaseEvent(EventTypeRaw),
		Event:     event,
	}

	for _, opt := range options {
		opt(rawEvent)
	}

	return rawEvent
}

// RawEventOption defines options for creating raw events
type RawEventOption func(*RawEvent)

// WithSource sets the source for the raw event
func WithSource(source string) RawEventOption {
	return func(e *RawEvent) {
		e.Source = &source
	}
}

// Validate validates the raw event
func (e *RawEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Event == nil {
		return fmt.Errorf("event data is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *RawEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *RawEvent) ToProtobuf() (*generated.Event, error) {
	// Convert the event to protobuf Value
	eventValue, err := structpb.NewValue(e.Event)
	if err != nil {
		return nil, fmt.Errorf("failed to convert event to protobuf: %w", err)
	}

	pbEvent := &generated.RawEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Event:     eventValue,
	}

	if e.Source != nil {
		pbEvent.Source = e.Source
	}

	return &generated.Event{
		Event: &generated.Event_Raw{
			Raw: pbEvent,
		},
	}, nil
}

// CustomEvent contains custom application-specific event data
type CustomEvent struct {
	*BaseEvent
	Name  string `json:"name"`
	Value any    `json:"value,omitempty"`
}

// NewCustomEvent creates a new custom event
func NewCustomEvent(name string, options ...CustomEventOption) *CustomEvent {
	event := &CustomEvent{
		BaseEvent: NewBaseEvent(EventTypeCustom),
		Name:      name,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// CustomEventOption defines options for creating custom events
type CustomEventOption func(*CustomEvent)

// WithValue sets the value for the custom event
func WithValue(value any) CustomEventOption {
	return func(e *CustomEvent) {
		e.Value = value
	}
}

// Validate validates the custom event
func (e *CustomEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Name == "" {
		return fmt.Errorf("custom event name is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *CustomEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *CustomEvent) ToProtobuf() (*generated.Event, error) {
	pbEvent := &generated.CustomEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Name:      e.Name,
	}

	if e.Value != nil {
		value, err := structpb.NewValue(e.Value)
		if err != nil {
			return nil, fmt.Errorf("failed to convert value to protobuf: %w", err)
		}
		pbEvent.Value = value
	}

	return &generated.Event{
		Event: &generated.Event_Custom{
			Custom: pbEvent,
		},
	}, nil
}
