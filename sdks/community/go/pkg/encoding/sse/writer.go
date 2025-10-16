package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/encoder"
)

// SSEWriter provides utilities for writing Server-Sent Events with proper framing
type SSEWriter struct {
	encoder *encoder.EventEncoder
	logger  *slog.Logger
}

// NewSSEWriter creates a new SSE writer
func NewSSEWriter() *SSEWriter {
	return &SSEWriter{
		encoder: encoder.NewEventEncoder(),
		logger:  slog.Default(),
	}
}

// WithLogger sets a custom logger for the SSE writer
func (w *SSEWriter) WithLogger(logger *slog.Logger) *SSEWriter {
	w.logger = logger
	return w
}

// WriteEvent writes a single event as SSE format to the writer with proper framing
// Format: data: <json>\n\n with proper escaping and flushing
func (w *SSEWriter) WriteEvent(ctx context.Context, writer io.Writer, event events.Event) error {
	return w.WriteEventWithType(ctx, writer, event, "")
}

// WriteBytes writes an event
func (w *SSEWriter) WriteBytes(ctx context.Context, writer io.Writer, event []byte) error {

	// Create SSE frame
	sseFrame, err := w.createSSEFrame(event, "", nil)
	if err != nil {
		w.logger.ErrorContext(ctx, "Failed to create SSE frame",
			"error", err)
		return fmt.Errorf("SSE frame creation failed: %w", err)
	}

	// Write the SSE frame
	_, err = writer.Write([]byte(sseFrame))
	if err != nil {
		w.logger.ErrorContext(ctx, "Failed to write SSE frame",
			"error", err)
		return fmt.Errorf("SSE write failed: %w", err)
	}

	// Flush if the writer supports it
	if flusher, ok := writer.(flusher); ok {
		if err := flusher.Flush(); err != nil {
			w.logger.ErrorContext(ctx, "Failed to flush SSE frame",
				"error", err)
			return fmt.Errorf("SSE flush failed: %w", err)
		}
	}
	return nil
}

// WriteEventWithType writes an event with a specific SSE event type
func (w *SSEWriter) WriteEventWithType(ctx context.Context, writer io.Writer, event events.Event, eventType string) error {
	if event == nil {
		return fmt.Errorf("event cannot be nil")
	}

	if writer == nil {
		return fmt.Errorf("writer cannot be nil")
	}

	// Encode the event to JSON
	jsonData, err := w.encoder.EncodeEvent(ctx, event, "application/json")
	if err != nil {
		w.logger.ErrorContext(ctx, "Failed to encode event",
			"error", err,
			"event_type", event.Type())
		return fmt.Errorf("event encoding failed: %w", err)
	}

	// Create SSE frame
	sseFrame, err := w.createSSEFrame(jsonData, eventType, event)
	if err != nil {
		w.logger.ErrorContext(ctx, "Failed to create SSE frame",
			"error", err,
			"event_type", event.Type())
		return fmt.Errorf("SSE frame creation failed: %w", err)
	}

	// Write the SSE frame
	_, err = writer.Write([]byte(sseFrame))
	if err != nil {
		w.logger.ErrorContext(ctx, "Failed to write SSE frame",
			"error", err,
			"event_type", event.Type())
		return fmt.Errorf("SSE write failed: %w", err)
	}

	// Flush if the writer supports it
	if flusher, ok := writer.(flusher); ok {
		if err := flusher.Flush(); err != nil {
			w.logger.ErrorContext(ctx, "Failed to flush SSE frame",
				"error", err,
				"event_type", event.Type())
			return fmt.Errorf("SSE flush failed: %w", err)
		}
	}

	return nil
}

// WriteEventWithNegotiation writes an event after performing content negotiation
func (w *SSEWriter) WriteEventWithNegotiation(ctx context.Context, writer io.Writer, event events.Event, acceptHeader string) error {
	// Perform content negotiation
	_, err := w.encoder.NegotiateContentType(acceptHeader)
	if err != nil {
		w.logger.WarnContext(ctx, "Content negotiation failed, using JSON",
			"error", err,
			"accept_header", acceptHeader)
		// Continue with JSON fallback
	}

	// For now, we only support JSON, so we use JSON regardless of negotiated type
	return w.WriteEvent(ctx, writer, event)
}

// WriteErrorEvent writes an error as an SSE event
func (w *SSEWriter) WriteErrorEvent(ctx context.Context, writer io.Writer, err error, requestID string) error {
	// Create a custom error event
	errorEvent := &CustomEvent{
		BaseEvent: events.BaseEvent{
			EventType: events.EventTypeCustom,
		},
	}
	errorEvent.SetData(map[string]interface{}{
		"error":      true,
		"message":    err.Error(),
		"request_id": requestID,
	})

	// Set timestamp
	errorEvent.SetTimestamp(getCurrentTimestamp())

	return w.WriteEventWithType(ctx, writer, errorEvent, "error")
}

// createSSEFrame creates a properly formatted SSE frame
func (w *SSEWriter) createSSEFrame(jsonData []byte, eventType string, event events.Event) (string, error) {
	var frame strings.Builder

	// Add event type if specified
	if eventType != "" {
		frame.WriteString(fmt.Sprintf("event: %s\n", eventType))
	}

	// Add event ID if available
	if event != nil && event.Timestamp() != nil {
		frame.WriteString(fmt.Sprintf("id: %s_%d\n", event.Type(), *event.Timestamp()))
	}

	// Escape newlines in JSON data to maintain SSE format integrity
	escapedData := strings.ReplaceAll(string(jsonData), "\n", "\\n")
	escapedData = strings.ReplaceAll(escapedData, "\r", "\\r")

	// Write data line
	frame.WriteString(fmt.Sprintf("data: %s\n", escapedData))

	// End with empty line to complete the SSE event
	frame.WriteString("\n")

	return frame.String(), nil
}

// flusher interface for writers that support flushing
type flusher interface {
	Flush() error
}

// CustomEvent is a simple implementation of events.Event for error and custom events
type CustomEvent struct {
	events.BaseEvent
	mu   sync.RWMutex           // Protect concurrent map access
	data map[string]interface{} // Thread-safe access via Data()/SetData() methods
}

// Data returns a thread-safe copy of the data map
func (e *CustomEvent) Data() map[string]interface{} {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.data == nil {
		return nil
	}
	// Return a copy to prevent external mutation
	result := make(map[string]interface{}, len(e.data))
	for k, v := range e.data {
		result[k] = v
	}
	return result
}

// SetData safely sets data in the map
func (e *CustomEvent) SetData(data map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.data = data
}

// SetDataField safely sets a single field in the data map
func (e *CustomEvent) SetDataField(key string, value interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.data == nil {
		e.data = make(map[string]interface{})
	}
	e.data[key] = value
}

// ThreadID returns empty string for custom events
func (e *CustomEvent) ThreadID() string {
	return ""
}

// RunID returns empty string for custom events
func (e *CustomEvent) RunID() string {
	return ""
}

// Validate validates the custom event
func (e *CustomEvent) Validate() error {
	if e.EventType == "" {
		return fmt.Errorf("event type cannot be empty")
	}
	return nil
}

// ToJSON serializes the custom event to JSON
func (e *CustomEvent) ToJSON() ([]byte, error) {
	eventData := map[string]interface{}{
		"type": e.EventType,
	}

	if e.TimestampMs != nil {
		eventData["timestamp"] = *e.TimestampMs
	}

	// Thread-safe data access
	e.mu.RLock()
	if e.data != nil {
		dataCopy := make(map[string]interface{}, len(e.data))
		for k, v := range e.data {
			dataCopy[k] = v
		}
		eventData["data"] = dataCopy
	}
	e.mu.RUnlock()

	return jsonMarshal(eventData)
}

// Helper function to get current timestamp
func getCurrentTimestamp() int64 {
	return time.Now().UnixMilli()
}

// Helper function for JSON marshaling (allows for future customization)
func jsonMarshal(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}
