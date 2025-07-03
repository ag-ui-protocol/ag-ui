// Package events provides comprehensive event types and utilities for the AG-UI protocol.
//
// The AG-UI (Agent-User Interaction) protocol defines 16 standardized event types
// that enable real-time streaming, bidirectional state synchronization, and
// human-in-the-loop collaboration between AI agents and front-end applications.
//
// # Event Types
//
// The package implements all 16 AG-UI event types:
//
// Run Lifecycle Events:
//   - RUN_STARTED: Agent execution initiation
//   - RUN_FINISHED: Successful agent execution completion
//   - RUN_ERROR: Agent execution error termination
//   - STEP_STARTED: Individual step initiation
//   - STEP_FINISHED: Individual step completion
//
// Message Events:
//   - TEXT_MESSAGE_START: Text message stream initiation
//   - TEXT_MESSAGE_CONTENT: Streaming text message content
//   - TEXT_MESSAGE_END: Text message stream completion
//
// Tool Events:
//   - TOOL_CALL_START: Tool invocation initiation
//   - TOOL_CALL_ARGS: Tool arguments specification
//   - TOOL_CALL_END: Tool execution completion
//
// State Events:
//   - STATE_SNAPSHOT: Complete state snapshot
//   - STATE_DELTA: Incremental state changes using JSON Patch (RFC 6902)
//   - MESSAGES_SNAPSHOT: Complete message history
//
// Custom Events:
//   - RAW: Raw data pass-through
//   - CUSTOM: Custom event types for extensibility
//
// # Basic Usage
//
//	import "github.com/ag-ui/go-sdk/pkg/core/events"
//
//	// Create a run started event
//	runEvent := events.NewRunStartedEvent("thread-123", "run-456")
//
//	// Create a text message with streaming content
//	msgStart := events.NewTextMessageStartEvent("msg-1", events.WithRole("user"))
//	msgContent := events.NewTextMessageContentEvent("msg-1", "Hello, ")
//	msgContent2 := events.NewTextMessageContentEvent("msg-1", "world!")
//	msgEnd := events.NewTextMessageEndEvent("msg-1")
//
//	// Validate event sequence
//	sequence := []events.Event{runEvent, msgStart, msgContent, msgContent2, msgEnd}
//	if err := events.ValidateSequence(sequence); err != nil {
//	    log.Fatal("Invalid event sequence:", err)
//	}
//
//	// Serialize to JSON
//	jsonData, err := msgStart.ToJSON()
//	if err != nil {
//	    log.Fatal("JSON serialization failed:", err)
//	}
//
//	// Parse from JSON
//	parsedEvent, err := events.EventFromJSON(jsonData)
//	if err != nil {
//	    log.Fatal("JSON parsing failed:", err)
//	}
//
//	// Convert to protobuf
//	pbEvent, err := msgStart.ToProtobuf()
//	if err != nil {
//	    log.Fatal("Protobuf conversion failed:", err)
//	}
//
// # Validation
//
// All events support validation at two levels:
//
//  1. Individual event validation (required fields, format checking)
//  2. Sequence validation (protocol compliance, state tracking)
//
// Sequence validation ensures that events follow AG-UI protocol rules:
//   - Runs must be started before they can be finished
//   - Messages and tool calls must have matching start/end pairs
//   - No duplicate starts for the same ID
//   - Proper nesting and lifecycle management
//
// # Cross-SDK Compatibility
//
// This implementation maintains compatibility with the TypeScript and Python SDKs:
//   - JSON field names match exactly (camelCase)
//   - Event validation rules are identical
//   - Protobuf binary format is compatible
//   - Timestamp handling uses consistent Unix milliseconds
//
// # Performance
//
// The package is designed for high-throughput scenarios:
//   - Minimal allocations in hot paths
//   - Efficient protobuf serialization
//   - Optional validation for performance-critical code
//   - Structured for concurrent usage
//
// # Error Handling
//
// All functions return descriptive errors with context:
//   - Validation errors specify which field failed
//   - Sequence errors identify the problematic event
//   - Serialization errors include the underlying cause
//
// For more details, see the individual event type documentation and examples.
package events
