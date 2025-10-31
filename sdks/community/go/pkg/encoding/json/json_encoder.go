package json

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
)

// Ensure JSONEncoder implements the focused interfaces
var (
	_ encoding.Encoder                     = (*JSONEncoder)(nil)
	_ encoding.ContentTypeProvider         = (*JSONEncoder)(nil)
	_ encoding.StreamingCapabilityProvider = (*JSONEncoder)(nil)
)

// JSONEncoder implements the Encoder interface for JSON format
// This encoder is stateless and thread-safe for concurrent use.
type JSONEncoder struct {
	options          *encoding.EncodingOptions
	activeOperations int32 // Track active encoding operations
	maxConcurrent    int32 // Maximum concurrent operations
}

// NewJSONEncoder creates a new JSON encoder with the given options
func NewJSONEncoder(options *encoding.EncodingOptions) *JSONEncoder {
	if options == nil {
		options = &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
		}
	}
	return &JSONEncoder{
		options:       options,
		maxConcurrent: 100, // Default limit of 100 concurrent operations
	}
}

// NewJSONEncoderWithConcurrencyLimit creates a new JSON encoder with specified concurrency limit
func NewJSONEncoderWithConcurrencyLimit(options *encoding.EncodingOptions, maxConcurrent int32) *JSONEncoder {
	if options == nil {
		options = &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
		}
	}
	return &JSONEncoder{
		options:       options,
		maxConcurrent: maxConcurrent,
	}
}

// Encode encodes a single event to JSON
func (e *JSONEncoder) Encode(ctx context.Context, event events.Event) ([]byte, error) {
	// Check context cancellation
	if err := ctx.Err(); err != nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "context cancelled",
			Cause:   err,
		}
	}

	// Check concurrency limits atomically to avoid race condition
	if e.maxConcurrent > 0 {
		// Atomically increment and check the limit
		current := atomic.AddInt32(&e.activeOperations, 1)
		if current > e.maxConcurrent {
			// Exceeded limit, decrement and return error
			atomic.AddInt32(&e.activeOperations, -1)
			return nil, &encoding.EncodingError{
				Format:  "json",
				Message: fmt.Sprintf("encoding concurrency limit exceeded: %d", e.maxConcurrent),
			}
		}
		// Operation is within limit, ensure decrement happens on exit
		defer atomic.AddInt32(&e.activeOperations, -1)
	}

	if event == nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "cannot encode nil event",
		}
	}

	// Validate the event before encoding if requested
	if e.options.ValidateOutput {
		if err := event.Validate(); err != nil {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: "event validation failed",
				Cause:   err,
			}
		}
	}

	// Use the event's ToJSON method for cross-SDK compatibility
	if e.options.CrossSDKCompatibility {
		data, err := event.ToJSON()
		if err != nil {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: "failed to encode event",
				Cause:   err,
			}
		}

		// Pretty print if requested
		if e.options.Pretty {
			buf := encoding.GetBufferSafe(len(data) * 2) // Estimate 2x size for pretty printing
			if buf == nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Event:   event,
					Message: "failed to allocate buffer for pretty printing: resource limits exceeded",
				}
			}
			defer encoding.PutBuffer(buf)

			if err := json.Indent(buf, data, "", "  "); err != nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Event:   event,
					Message: "failed to format JSON",
					Cause:   err,
				}
			}
			data = make([]byte, buf.Len())
			copy(data, buf.Bytes())
		}

		// Check size limits
		if e.options.MaxSize > 0 && int64(len(data)) > e.options.MaxSize {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: fmt.Sprintf("encoded event exceeds max size of %d bytes", e.options.MaxSize),
			}
		}

		return data, nil
	}

	// Standard JSON encoding with buffer pooling
	var data []byte
	var err error

	if e.options.Pretty {
		// Use buffer pooling for pretty printing with optimized size
		optimalSize := encoding.GetOptimalBufferSizeForEvent(event)
		buf := encoding.GetBufferSafe(optimalSize * 2) // Pretty printing needs more space
		if buf == nil {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: "failed to allocate buffer for pretty printing: resource limits exceeded",
			}
		}
		defer encoding.PutBuffer(buf)

		encoder := json.NewEncoder(buf)
		encoder.SetIndent("", "  ")
		err = encoder.Encode(event)
		if err == nil {
			data = make([]byte, buf.Len())
			copy(data, buf.Bytes())
		}
	} else {
		// Use buffer pooling for compact encoding with optimized size
		optimalSize := encoding.GetOptimalBufferSizeForEvent(event)
		buf := encoding.GetBufferSafe(optimalSize)
		if buf == nil {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: "failed to allocate buffer: resource limits exceeded",
			}
		}
		defer encoding.PutBuffer(buf)

		encoder := json.NewEncoder(buf)
		err = encoder.Encode(event)
		if err == nil {
			// Remove trailing newline added by json.Encoder
			bytes := buf.Bytes()
			if len(bytes) > 0 && bytes[len(bytes)-1] == '\n' {
				bytes = bytes[:len(bytes)-1]
			}
			data = make([]byte, len(bytes))
			copy(data, bytes)
		}
	}

	if err != nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Event:   event,
			Message: "failed to marshal event",
			Cause:   err,
		}
	}

	// Check size limits
	if e.options.MaxSize > 0 && int64(len(data)) > e.options.MaxSize {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Event:   event,
			Message: fmt.Sprintf("encoded event exceeds max size of %d bytes", e.options.MaxSize),
		}
	}

	return data, nil
}

// EncodeMultiple encodes multiple events efficiently
func (e *JSONEncoder) EncodeMultiple(ctx context.Context, events []events.Event) ([]byte, error) {
	// Check context cancellation
	if err := ctx.Err(); err != nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "context cancelled",
			Cause:   err,
		}
	}

	// Check concurrency limits atomically to avoid race condition
	if e.maxConcurrent > 0 {
		// Atomically increment and check the limit
		current := atomic.AddInt32(&e.activeOperations, 1)
		if current > e.maxConcurrent {
			// Exceeded limit, decrement and return error
			atomic.AddInt32(&e.activeOperations, -1)
			return nil, &encoding.EncodingError{
				Format:  "json",
				Message: fmt.Sprintf("encoding concurrency limit exceeded: %d", e.maxConcurrent),
			}
		}
		// Operation is within limit, ensure decrement happens on exit
		defer atomic.AddInt32(&e.activeOperations, -1)
	}

	if len(events) == 0 {
		return []byte("[]"), nil
	}

	// Validate all events first if requested
	if e.options.ValidateOutput {
		for i, event := range events {
			if event == nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Message: fmt.Sprintf("cannot encode nil event at index %d", i),
				}
			}
			if err := event.Validate(); err != nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Event:   event,
					Message: fmt.Sprintf("event validation failed at index %d", i),
					Cause:   err,
				}
			}
		}
	}

	// Create a slice to hold all encoded events
	encodedEvents := make([]json.RawMessage, 0, len(events))
	totalSize := int64(2) // Account for "[]"

	// Use a pooled buffer for better memory efficiency - estimate based on actual events
	estimatedSize := encoding.GetOptimalBufferSizeForMultiple(events)
	mainBuf := encoding.GetBufferSafe(estimatedSize)
	if mainBuf == nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "failed to allocate main buffer: resource limits exceeded",
		}
	}
	defer encoding.PutBuffer(mainBuf)

	for i, event := range events {
		// Check context cancellation periodically
		if i%100 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Message: "context cancelled during encoding",
					Cause:   err,
				}
			}
		}

		var data []byte
		var err error

		if e.options.CrossSDKCompatibility {
			// Use ToJSON for cross-SDK compatibility
			data, err = event.ToJSON()
		} else {
			// Use buffer pooling for standard JSON encoding with optimized size
			optimalSize := encoding.GetOptimalBufferSizeForEvent(event)
			eventBuf := encoding.GetBufferSafe(optimalSize)
			if eventBuf == nil {
				return nil, &encoding.EncodingError{
					Format:  "json",
					Event:   event,
					Message: fmt.Sprintf("failed to allocate event buffer at index %d: resource limits exceeded", i),
				}
			}

			// Use the buffer and ensure it's returned to pool immediately after use
			encoder := json.NewEncoder(eventBuf)
			err = encoder.Encode(event)
			if err == nil {
				// Remove trailing newline added by json.Encoder
				bytes := eventBuf.Bytes()
				if len(bytes) > 0 && bytes[len(bytes)-1] == '\n' {
					bytes = bytes[:len(bytes)-1]
				}
				data = make([]byte, len(bytes))
				copy(data, bytes)
			}

			// Return buffer to pool immediately after use to reduce memory pressure
			encoding.PutBuffer(eventBuf)
		}

		if err != nil {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Event:   event,
				Message: fmt.Sprintf("failed to encode event at index %d", i),
				Cause:   err,
			}
		}

		// Check cumulative size
		totalSize += int64(len(data))
		if i > 0 {
			totalSize++ // Account for comma separator
		}

		if e.options.MaxSize > 0 && totalSize > e.options.MaxSize {
			return nil, &encoding.EncodingError{
				Format:  "json",
				Message: fmt.Sprintf("encoded events exceed max size of %d bytes", e.options.MaxSize),
			}
		}

		encodedEvents = append(encodedEvents, json.RawMessage(data))
	}

	// Marshal the array of raw messages using buffer pooling
	var result []byte
	var err error

	// Use buffer pooling for the final array marshalling
	arrayBuf := encoding.GetBufferSafe(int(totalSize)) // Use estimated total size
	if arrayBuf == nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "failed to allocate array buffer: resource limits exceeded",
		}
	}
	defer encoding.PutBuffer(arrayBuf)

	if e.options.Pretty {
		encoder := json.NewEncoder(arrayBuf)
		encoder.SetIndent("", "  ")
		err = encoder.Encode(encodedEvents)
		if err == nil {
			// Remove trailing newline added by json.Encoder
			bytes := arrayBuf.Bytes()
			if len(bytes) > 0 && bytes[len(bytes)-1] == '\n' {
				bytes = bytes[:len(bytes)-1]
			}
			result = make([]byte, len(bytes))
			copy(result, bytes)
		}
	} else {
		encoder := json.NewEncoder(arrayBuf)
		err = encoder.Encode(encodedEvents)
		if err == nil {
			// Remove trailing newline added by json.Encoder
			bytes := arrayBuf.Bytes()
			if len(bytes) > 0 && bytes[len(bytes)-1] == '\n' {
				bytes = bytes[:len(bytes)-1]
			}
			result = make([]byte, len(bytes))
			copy(result, bytes)
		}
	}

	if err != nil {
		return nil, &encoding.EncodingError{
			Format:  "json",
			Message: "failed to marshal event array",
			Cause:   err,
		}
	}

	return result, nil
}

// ContentType returns the MIME type for JSON
func (e *JSONEncoder) ContentType() string {
	return "application/json"
}

// CanStream indicates that JSON encoder supports streaming (backward compatibility)
func (e *JSONEncoder) CanStream() bool {
	return true
}

// SupportsStreaming indicates that JSON encoder supports streaming
func (e *JSONEncoder) SupportsStreaming() bool {
	return true
}

// Reset resets the encoder with new options (for pooling)
func (e *JSONEncoder) Reset(options *encoding.EncodingOptions) {
	if options == nil {
		options = &encoding.EncodingOptions{
			CrossSDKCompatibility: true,
			ValidateOutput:        true,
		}
	}
	e.options = options
}
