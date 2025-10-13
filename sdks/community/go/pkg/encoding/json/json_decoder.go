package json

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
)

// Ensure JSONDecoder implements the focused interfaces
var (
	_ encoding.Decoder                     = (*JSONDecoder)(nil)
	_ encoding.ContentTypeProvider         = (*JSONDecoder)(nil)
	_ encoding.StreamingCapabilityProvider = (*JSONDecoder)(nil)
)

// JSONDecoder implements the Decoder interface for JSON format
// This decoder is stateless and thread-safe for concurrent use.
type JSONDecoder struct {
	options          *encoding.DecodingOptions
	activeOperations int32 // Track active decoding operations
	maxConcurrent    int32 // Maximum concurrent operations
}

// NewJSONDecoder creates a new JSON decoder with the given options
func NewJSONDecoder(options *encoding.DecodingOptions) *JSONDecoder {
	if options == nil {
		options = &encoding.DecodingOptions{
			Strict:         true,
			ValidateEvents: true,
		}
	}
	return &JSONDecoder{
		options:       options,
		maxConcurrent: 100, // Default limit of 100 concurrent operations
	}
}

// NewJSONDecoderWithConcurrencyLimit creates a new JSON decoder with specified concurrency limit
func NewJSONDecoderWithConcurrencyLimit(options *encoding.DecodingOptions, maxConcurrent int32) *JSONDecoder {
	if options == nil {
		options = &encoding.DecodingOptions{
			Strict:         true,
			ValidateEvents: true,
		}
	}
	return &JSONDecoder{
		options:       options,
		maxConcurrent: maxConcurrent,
	}
}

// eventTypeWrapper is used to extract the event type from JSON
type eventTypeWrapper struct {
	Type string `json:"type"`
}

// Decode decodes a single event from JSON data
func (d *JSONDecoder) Decode(ctx context.Context, data []byte) (events.Event, error) {
	// Check context cancellation
	if err := ctx.Err(); err != nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Message: "context cancelled",
			Cause:   err,
		}
	}

	// Check concurrency limits atomically to avoid race condition
	if d.maxConcurrent > 0 {
		// Atomically increment and check the limit
		current := atomic.AddInt32(&d.activeOperations, 1)
		if current > d.maxConcurrent {
			// Exceeded limit, decrement and return error
			atomic.AddInt32(&d.activeOperations, -1)
			return nil, &encoding.DecodingError{
				Format:  "json",
				Data:    data,
				Message: fmt.Sprintf("decoding concurrency limit exceeded: %d", d.maxConcurrent),
			}
		}
		// Operation is within limit, ensure decrement happens on exit
		defer atomic.AddInt32(&d.activeOperations, -1)
	}

	if len(data) == 0 {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: "empty data",
		}
	}

	// Check size limits
	if d.options.MaxSize > 0 && int64(len(data)) > d.options.MaxSize {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: fmt.Sprintf("data exceeds max size of %d bytes", d.options.MaxSize),
		}
	}

	// First, decode just the type field without strict checking
	var typeWrapper eventTypeWrapper
	if err := json.Unmarshal(data, &typeWrapper); err != nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: "failed to decode event type",
			Cause:   err,
		}
	}

	// Create the appropriate event type based on the type field
	event, err := d.createEvent(events.EventType(typeWrapper.Type), data)
	if err != nil {
		return nil, err
	}

	// Validate the event if requested
	if d.options.ValidateEvents {
		if err := event.Validate(); err != nil {
			return nil, &encoding.DecodingError{
				Format:  "json",
				Data:    data,
				Message: "event validation failed",
				Cause:   err,
			}
		}
	}

	return event, nil
}

// DecodeMultiple decodes multiple events from JSON array data
func (d *JSONDecoder) DecodeMultiple(ctx context.Context, data []byte) ([]events.Event, error) {
	// Check context cancellation
	if err := ctx.Err(); err != nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Message: "context cancelled",
			Cause:   err,
		}
	}

	// Check concurrency limits atomically to avoid race condition
	if d.maxConcurrent > 0 {
		// Atomically increment and check the limit
		current := atomic.AddInt32(&d.activeOperations, 1)
		if current > d.maxConcurrent {
			// Exceeded limit, decrement and return error
			atomic.AddInt32(&d.activeOperations, -1)
			return nil, &encoding.DecodingError{
				Format:  "json",
				Data:    data,
				Message: fmt.Sprintf("decoding concurrency limit exceeded: %d", d.maxConcurrent),
			}
		}
		// Operation is within limit, ensure decrement happens on exit
		defer atomic.AddInt32(&d.activeOperations, -1)
	}

	if len(data) == 0 {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: "empty data",
		}
	}

	// Check size limits
	if d.options.MaxSize > 0 && int64(len(data)) > d.options.MaxSize {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: fmt.Sprintf("data exceeds max size of %d bytes", d.options.MaxSize),
		}
	}

	// First, decode as an array of raw messages
	var rawEvents []json.RawMessage
	if err := json.Unmarshal(data, &rawEvents); err != nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: "failed to decode event array",
			Cause:   err,
		}
	}

	// Decode each event
	events := make([]events.Event, 0, len(rawEvents))
	for i, rawEvent := range rawEvents {
		event, err := d.Decode(ctx, rawEvent)
		if err != nil {
			// Enhance error with index information
			if decErr, ok := err.(*encoding.DecodingError); ok {
				decErr.Message = fmt.Sprintf("failed to decode event at index %d: %s", i, decErr.Message)
			}
			return nil, err
		}
		events = append(events, event)
	}

	return events, nil
}

// createEvent creates the appropriate event type based on the type string
func (d *JSONDecoder) createEvent(eventType events.EventType, data []byte) (events.Event, error) {
	// Use buffer pooling for creating a byte reader
	buf := encoding.GetBufferSafe(len(data))
	if buf == nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: "failed to allocate buffer: resource limits exceeded",
		}
	}
	defer encoding.PutBuffer(buf)

	buf.Write(data)

	decoder := json.NewDecoder(buf)
	if d.options.Strict && !d.options.AllowUnknownFields {
		decoder.DisallowUnknownFields()
	}

	var err error
	var event events.Event

	switch eventType {
	case events.EventTypeTextMessageStart:
		var e events.TextMessageStartEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeTextMessageContent:
		var e events.TextMessageContentEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeTextMessageEnd:
		var e events.TextMessageEndEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeToolCallStart:
		var e events.ToolCallStartEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeToolCallArgs:
		var e events.ToolCallArgsEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeToolCallEnd:
		var e events.ToolCallEndEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeStateSnapshot:
		var e events.StateSnapshotEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeStateDelta:
		var e events.StateDeltaEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeMessagesSnapshot:
		var e events.MessagesSnapshotEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeRaw:
		var e events.RawEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeCustom:
		var e events.CustomEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeRunStarted:
		var e events.RunStartedEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeRunFinished:
		var e events.RunFinishedEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeRunError:
		var e events.RunErrorEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeStepStarted:
		var e events.StepStartedEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	case events.EventTypeStepFinished:
		var e events.StepFinishedEvent
		err = decoder.Decode(&e)
		if err == nil {
			event = &e
		}

	default:
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: fmt.Sprintf("unknown event type: %s", eventType),
		}
	}

	if err != nil {
		return nil, &encoding.DecodingError{
			Format:  "json",
			Data:    data,
			Message: fmt.Sprintf("failed to decode %s event", eventType),
			Cause:   err,
		}
	}

	// Ensure the base event is properly initialized
	if event != nil && event.GetBaseEvent() != nil {
		baseEvent := event.GetBaseEvent()
		baseEvent.EventType = eventType
	}

	return event, nil
}

// ContentType returns the MIME type this decoder handles
func (d *JSONDecoder) ContentType() string {
	return "application/json"
}

// CanStream indicates that JSON decoder supports streaming (backward compatibility)
func (d *JSONDecoder) CanStream() bool {
	return true
}

// SupportsStreaming indicates that JSON decoder supports streaming
func (d *JSONDecoder) SupportsStreaming() bool {
	return true
}

// Reset resets the decoder with new options (for pooling)
func (d *JSONDecoder) Reset(options *encoding.DecodingOptions) {
	if options == nil {
		options = &encoding.DecodingOptions{
			Strict:         true,
			ValidateEvents: true,
		}
	}
	d.options = options
}
