package encoder

import (
	"context"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/json"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/negotiation"
)

// EventEncoder provides a high-level interface for encoding AG-UI events
// This adapter bridges the Go SDK encoding package with example server needs
type EventEncoder struct {
	negotiator *negotiation.ContentNegotiator
	jsonCodec  encoding.Codec
}

// NewEventEncoder creates a new event encoder with content negotiation support
func NewEventEncoder() *EventEncoder {
	// Create content negotiator with JSON as preferred type
	negotiator := negotiation.NewContentNegotiator("application/json")

	return &EventEncoder{
		negotiator: negotiator,
		jsonCodec:  json.NewCodec(),
	}
}

// EncodeEvent encodes a single event using the specified content type
func (e *EventEncoder) EncodeEvent(ctx context.Context, event events.Event, contentType string) ([]byte, error) {
	if event == nil {
		return nil, fmt.Errorf("event cannot be nil")
	}

	// Validate the event before encoding
	if err := event.Validate(); err != nil {
		return nil, fmt.Errorf("event validation failed: %w", err)
	}

	// For now, we only support JSON encoding as specified in the task
	// Protobuf support can be added later
	switch contentType {
	case "application/json", "":
		return e.jsonCodec.Encode(ctx, event)
	default:
		// Try to negotiate to a supported type
		supportedType, err := e.negotiator.Negotiate(contentType)
		if err != nil {
			return nil, fmt.Errorf("unsupported content type %q: %w", contentType, err)
		}

		// For now, fallback to JSON
		if supportedType == "application/json" {
			return e.jsonCodec.Encode(ctx, event)
		}

		return nil, fmt.Errorf("content type %q not implemented yet", supportedType)
	}
}

// NegotiateContentType performs content negotiation based on Accept header
func (e *EventEncoder) NegotiateContentType(acceptHeader string) (string, error) {
	if acceptHeader == "" {
		return "application/json", nil // Default to JSON
	}

	contentType, err := e.negotiator.Negotiate(acceptHeader)
	if err != nil {
		// If negotiation fails, fallback to JSON with a clear message
		return "application/json", fmt.Errorf("content negotiation failed, falling back to JSON: %w", err)
	}

	return contentType, nil
}

// SupportedContentTypes returns the list of supported content types
func (e *EventEncoder) SupportedContentTypes() []string {
	return e.negotiator.SupportedTypes()
}

// GetContentType returns the content type that this encoder will produce
func (e *EventEncoder) GetContentType(acceptHeader string) string {
	contentType, err := e.NegotiateContentType(acceptHeader)
	if err != nil {
		// Log the error but continue with fallback
		return "application/json"
	}
	return contentType
}
