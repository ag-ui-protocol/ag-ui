package encoding

import (
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// Buffer size constants optimized for different event types
const (
	// Small events (typically 100-500 bytes)
	SmallEventBufferSize = 512

	// Medium events (typically 500-2KB)
	MediumEventBufferSize = 2048

	// Large events (typically 2KB-8KB)
	LargeEventBufferSize = 8192

	// Very large events (8KB+)
	VeryLargeEventBufferSize = 16384

	// Default buffer size for unknown events
	DefaultEventBufferSize = 1024

	// Array processing buffer size per event
	ArrayProcessingBufferSize = 1024
)

// GetOptimalBufferSize returns the optimal buffer size for a given event type
func GetOptimalBufferSize(eventType events.EventType) int {
	switch eventType {
	case events.EventTypeTextMessageStart:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeTextMessageContent:
		return MediumEventBufferSize // Text content can vary
	case events.EventTypeTextMessageEnd:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeToolCallStart:
		return SmallEventBufferSize // Tool metadata
	case events.EventTypeToolCallArgs:
		return LargeEventBufferSize // Tool arguments can be large
	case events.EventTypeToolCallEnd:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeStateSnapshot:
		return VeryLargeEventBufferSize // State snapshots can be very large
	case events.EventTypeStateDelta:
		return MediumEventBufferSize // Delta operations are usually medium
	case events.EventTypeMessagesSnapshot:
		return VeryLargeEventBufferSize // Message snapshots can be very large
	case events.EventTypeRaw:
		return LargeEventBufferSize // Raw events are unpredictable
	case events.EventTypeCustom:
		return MediumEventBufferSize // Custom events are usually medium
	case events.EventTypeRunStarted:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeRunFinished:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeRunError:
		return MediumEventBufferSize // Error details can be medium
	case events.EventTypeStepStarted:
		return SmallEventBufferSize // Simple metadata
	case events.EventTypeStepFinished:
		return SmallEventBufferSize // Simple metadata
	default:
		return DefaultEventBufferSize
	}
}

// GetOptimalBufferSizeForEvent returns the optimal buffer size for a specific event instance
func GetOptimalBufferSizeForEvent(event events.Event) int {
	if event == nil {
		return DefaultEventBufferSize
	}

	baseSize := GetOptimalBufferSize(event.Type())

	// For certain event types, we can make more precise estimates
	switch e := event.(type) {
	case *events.TextMessageContentEvent:
		// Estimate based on delta length
		if len(e.Delta) > 0 {
			// Add some overhead for JSON encoding
			return max(baseSize, len(e.Delta)*2)
		}
	case *events.ToolCallArgsEvent:
		// Estimate based on delta length
		if len(e.Delta) > 0 {
			// Add some overhead for JSON encoding
			return max(baseSize, len(e.Delta)*2)
		}
	case *events.StateSnapshotEvent:
		// State snapshots can be very large, but we can't easily estimate
		// without serializing first, so stick with the base size
		return baseSize
	case *events.StateDeltaEvent:
		// Estimate based on number of operations
		if len(e.Delta) > 0 {
			// Rough estimate: 100 bytes per operation
			return max(baseSize, len(e.Delta)*100)
		}
	case *events.MessagesSnapshotEvent:
		// Estimate based on number of messages
		if len(e.Messages) > 0 {
			// Rough estimate: 500 bytes per message
			return max(baseSize, len(e.Messages)*500)
		}
	case *events.CustomEvent:
		// For custom events, we can't easily estimate without knowing the value
		return baseSize
	}

	return baseSize
}

// GetOptimalBufferSizeForMultiple returns the optimal buffer size for encoding multiple events
func GetOptimalBufferSizeForMultiple(events []events.Event) int {
	if len(events) == 0 {
		return DefaultEventBufferSize
	}

	totalSize := 0
	for _, event := range events {
		totalSize += GetOptimalBufferSizeForEvent(event)
	}

	// Add some overhead for array structure
	arrayOverhead := 50 * len(events) // Rough estimate for JSON array overhead
	return totalSize + arrayOverhead
}

// max returns the maximum of two integers
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
