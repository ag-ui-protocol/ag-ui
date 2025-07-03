package events

import (
	"fmt"
	"time"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
)

// EventType represents the type of AG-UI event
type EventType string

// AG-UI Event Type constants - matching the protocol specification
const (
	EventTypeTextMessageStart   EventType = "TEXT_MESSAGE_START"
	EventTypeTextMessageContent EventType = "TEXT_MESSAGE_CONTENT"
	EventTypeTextMessageEnd     EventType = "TEXT_MESSAGE_END"
	EventTypeToolCallStart      EventType = "TOOL_CALL_START"
	EventTypeToolCallArgs       EventType = "TOOL_CALL_ARGS"
	EventTypeToolCallEnd        EventType = "TOOL_CALL_END"
	EventTypeStateSnapshot      EventType = "STATE_SNAPSHOT"
	EventTypeStateDelta         EventType = "STATE_DELTA"
	EventTypeMessagesSnapshot   EventType = "MESSAGES_SNAPSHOT"
	EventTypeRaw                EventType = "RAW"
	EventTypeCustom             EventType = "CUSTOM"
	EventTypeRunStarted         EventType = "RUN_STARTED"
	EventTypeRunFinished        EventType = "RUN_FINISHED"
	EventTypeRunError           EventType = "RUN_ERROR"
	EventTypeStepStarted        EventType = "STEP_STARTED"
	EventTypeStepFinished       EventType = "STEP_FINISHED"
)

// Event defines the common interface for all AG-UI events
type Event interface {
	// Type returns the event type
	Type() EventType

	// Timestamp returns the event timestamp (Unix milliseconds)
	Timestamp() *int64

	// SetTimestamp sets the event timestamp
	SetTimestamp(timestamp int64)

	// Validate validates the event structure and content
	Validate() error

	// ToJSON serializes the event to JSON for cross-SDK compatibility
	ToJSON() ([]byte, error)

	// ToProtobuf converts the event to its protobuf representation
	ToProtobuf() (*generated.Event, error)

	// GetBaseEvent returns the underlying base event
	GetBaseEvent() *BaseEvent
}

// BaseEvent provides common fields and functionality for all events
type BaseEvent struct {
	EventType   EventType `json:"type"`
	TimestampMs *int64    `json:"timestamp,omitempty"`
	RawEvent    any       `json:"rawEvent,omitempty"`
}

// Type returns the event type
func (b *BaseEvent) Type() EventType {
	return b.EventType
}

// Timestamp returns the event timestamp
func (b *BaseEvent) Timestamp() *int64 {
	return b.TimestampMs
}

// SetTimestamp sets the event timestamp
func (b *BaseEvent) SetTimestamp(timestamp int64) {
	b.TimestampMs = &timestamp
}

// GetBaseEvent returns the base event
func (b *BaseEvent) GetBaseEvent() *BaseEvent {
	return b
}

// NewBaseEvent creates a new base event with the given type and current timestamp
func NewBaseEvent(eventType EventType) *BaseEvent {
	now := time.Now().UnixMilli()
	return &BaseEvent{
		EventType:   eventType,
		TimestampMs: &now,
	}
}

// Validate validates the base event structure
func (b *BaseEvent) Validate() error {
	if b.EventType == "" {
		return fmt.Errorf("BaseEvent validation failed: type field is required")
	}

	if !isValidEventType(b.EventType) {
		return fmt.Errorf("BaseEvent validation failed: invalid event type '%s'", b.EventType)
	}

	return nil
}

// ToProtobufBase converts the base event to its protobuf representation
func (b *BaseEvent) ToProtobufBase() *generated.BaseEvent {
	base := &generated.BaseEvent{
		Type: eventTypeToProtobuf(b.EventType),
	}

	if b.TimestampMs != nil {
		base.Timestamp = b.TimestampMs
	}

	return base
}

// isValidEventType checks if the given event type is valid
func isValidEventType(eventType EventType) bool {
	switch eventType {
	case EventTypeTextMessageStart, EventTypeTextMessageContent, EventTypeTextMessageEnd,
		EventTypeToolCallStart, EventTypeToolCallArgs, EventTypeToolCallEnd,
		EventTypeStateSnapshot, EventTypeStateDelta, EventTypeMessagesSnapshot,
		EventTypeRaw, EventTypeCustom, EventTypeRunStarted, EventTypeRunFinished,
		EventTypeRunError, EventTypeStepStarted, EventTypeStepFinished:
		return true
	default:
		return false
	}
}

// eventTypeToProtobuf converts EventType to protobuf EventType
func eventTypeToProtobuf(eventType EventType) generated.EventType {
	switch eventType {
	case EventTypeTextMessageStart:
		return generated.EventType_TEXT_MESSAGE_START
	case EventTypeTextMessageContent:
		return generated.EventType_TEXT_MESSAGE_CONTENT
	case EventTypeTextMessageEnd:
		return generated.EventType_TEXT_MESSAGE_END
	case EventTypeToolCallStart:
		return generated.EventType_TOOL_CALL_START
	case EventTypeToolCallArgs:
		return generated.EventType_TOOL_CALL_ARGS
	case EventTypeToolCallEnd:
		return generated.EventType_TOOL_CALL_END
	case EventTypeStateSnapshot:
		return generated.EventType_STATE_SNAPSHOT
	case EventTypeStateDelta:
		return generated.EventType_STATE_DELTA
	case EventTypeMessagesSnapshot:
		return generated.EventType_MESSAGES_SNAPSHOT
	case EventTypeRaw:
		return generated.EventType_RAW
	case EventTypeCustom:
		return generated.EventType_CUSTOM
	case EventTypeRunStarted:
		return generated.EventType_RUN_STARTED
	case EventTypeRunFinished:
		return generated.EventType_RUN_FINISHED
	case EventTypeRunError:
		return generated.EventType_RUN_ERROR
	case EventTypeStepStarted:
		return generated.EventType_STEP_STARTED
	case EventTypeStepFinished:
		return generated.EventType_STEP_FINISHED
	default:
		return generated.EventType_TEXT_MESSAGE_START // Default fallback
	}
}

// protobufToEventType converts protobuf EventType to EventType
func protobufToEventType(pbType generated.EventType) EventType {
	switch pbType {
	case generated.EventType_TEXT_MESSAGE_START:
		return EventTypeTextMessageStart
	case generated.EventType_TEXT_MESSAGE_CONTENT:
		return EventTypeTextMessageContent
	case generated.EventType_TEXT_MESSAGE_END:
		return EventTypeTextMessageEnd
	case generated.EventType_TOOL_CALL_START:
		return EventTypeToolCallStart
	case generated.EventType_TOOL_CALL_ARGS:
		return EventTypeToolCallArgs
	case generated.EventType_TOOL_CALL_END:
		return EventTypeToolCallEnd
	case generated.EventType_STATE_SNAPSHOT:
		return EventTypeStateSnapshot
	case generated.EventType_STATE_DELTA:
		return EventTypeStateDelta
	case generated.EventType_MESSAGES_SNAPSHOT:
		return EventTypeMessagesSnapshot
	case generated.EventType_RAW:
		return EventTypeRaw
	case generated.EventType_CUSTOM:
		return EventTypeCustom
	case generated.EventType_RUN_STARTED:
		return EventTypeRunStarted
	case generated.EventType_RUN_FINISHED:
		return EventTypeRunFinished
	case generated.EventType_RUN_ERROR:
		return EventTypeRunError
	case generated.EventType_STEP_STARTED:
		return EventTypeStepStarted
	case generated.EventType_STEP_FINISHED:
		return EventTypeStepFinished
	default:
		return EventTypeTextMessageStart // Default fallback
	}
}

// ValidateSequence validates a sequence of events according to AG-UI protocol rules
func ValidateSequence(events []Event) error {
	if len(events) == 0 {
		return nil
	}

	// Track active runs and message/tool call states
	activeRuns := make(map[string]bool)
	activeMessages := make(map[string]bool)
	activeToolCalls := make(map[string]bool)
	finishedRuns := make(map[string]bool)

	for i, event := range events {
		if err := event.Validate(); err != nil {
			return fmt.Errorf("event %d validation failed: %w", i, err)
		}

		// Check sequence-specific validation rules
		switch event.Type() {
		case EventTypeRunStarted:
			if runEvent, ok := event.(*RunStartedEvent); ok {
				if activeRuns[runEvent.RunID] {
					return fmt.Errorf("run %s already started", runEvent.RunID)
				}
				if finishedRuns[runEvent.RunID] {
					return fmt.Errorf("cannot restart finished run %s", runEvent.RunID)
				}
				activeRuns[runEvent.RunID] = true
			}

		case EventTypeRunFinished:
			if runEvent, ok := event.(*RunFinishedEvent); ok {
				if !activeRuns[runEvent.RunID] {
					return fmt.Errorf("cannot finish run %s that was not started", runEvent.RunID)
				}
				delete(activeRuns, runEvent.RunID)
				finishedRuns[runEvent.RunID] = true
			}

		case EventTypeRunError:
			if runEvent, ok := event.(*RunErrorEvent); ok {
				if runEvent.RunID != "" && !activeRuns[runEvent.RunID] {
					return fmt.Errorf("cannot error run %s that was not started", runEvent.RunID)
				}
				if runEvent.RunID != "" {
					delete(activeRuns, runEvent.RunID)
					finishedRuns[runEvent.RunID] = true
				}
			}

		case EventTypeTextMessageStart:
			if msgEvent, ok := event.(*TextMessageStartEvent); ok {
				if activeMessages[msgEvent.MessageID] {
					return fmt.Errorf("message %s already started", msgEvent.MessageID)
				}
				activeMessages[msgEvent.MessageID] = true
			}

		case EventTypeTextMessageEnd:
			if msgEvent, ok := event.(*TextMessageEndEvent); ok {
				if !activeMessages[msgEvent.MessageID] {
					return fmt.Errorf("cannot end message %s that was not started", msgEvent.MessageID)
				}
				delete(activeMessages, msgEvent.MessageID)
			}

		case EventTypeToolCallStart:
			if toolEvent, ok := event.(*ToolCallStartEvent); ok {
				if activeToolCalls[toolEvent.ToolCallID] {
					return fmt.Errorf("tool call %s already started", toolEvent.ToolCallID)
				}
				activeToolCalls[toolEvent.ToolCallID] = true
			}

		case EventTypeToolCallEnd:
			if toolEvent, ok := event.(*ToolCallEndEvent); ok {
				if !activeToolCalls[toolEvent.ToolCallID] {
					return fmt.Errorf("cannot end tool call %s that was not started", toolEvent.ToolCallID)
				}
				delete(activeToolCalls, toolEvent.ToolCallID)
			}
		}
	}

	return nil
}
