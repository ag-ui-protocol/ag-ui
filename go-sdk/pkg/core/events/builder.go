package events

import (
	"fmt"
	"time"
)

// EventBuilder provides a fluent interface for building events
type EventBuilder struct {
	eventType EventType
	timestamp *int64

	// Common fields
	threadID   string
	runID      string
	messageID  string
	toolCallID string
	stepName   string

	// Message fields
	role  *string
	delta string

	// Tool fields
	toolCallName    string
	parentMessageID *string

	// Error fields
	errorMessage string
	errorCode    *string

	// State fields
	snapshot any
	deltaOps []JSONPatchOperation
	messages []Message

	// Custom fields
	customName  string
	customValue any
	rawEvent    any
	rawSource   *string

	// Auto-generation flags
	autoGenerateIDs bool
}

// NewEventBuilder creates a new event builder
func NewEventBuilder() *EventBuilder {
	return &EventBuilder{}
}

// Event Type Methods

// RunStarted configures the builder for a RUN_STARTED event
func (b *EventBuilder) RunStarted() *EventBuilder {
	b.eventType = EventTypeRunStarted
	return b
}

// RunFinished configures the builder for a RUN_FINISHED event
func (b *EventBuilder) RunFinished() *EventBuilder {
	b.eventType = EventTypeRunFinished
	return b
}

// RunError configures the builder for a RUN_ERROR event
func (b *EventBuilder) RunError() *EventBuilder {
	b.eventType = EventTypeRunError
	return b
}

// StepStarted configures the builder for a STEP_STARTED event
func (b *EventBuilder) StepStarted() *EventBuilder {
	b.eventType = EventTypeStepStarted
	return b
}

// StepFinished configures the builder for a STEP_FINISHED event
func (b *EventBuilder) StepFinished() *EventBuilder {
	b.eventType = EventTypeStepFinished
	return b
}

// TextMessageStart configures the builder for a TEXT_MESSAGE_START event
func (b *EventBuilder) TextMessageStart() *EventBuilder {
	b.eventType = EventTypeTextMessageStart
	return b
}

// TextMessageContent configures the builder for a TEXT_MESSAGE_CONTENT event
func (b *EventBuilder) TextMessageContent() *EventBuilder {
	b.eventType = EventTypeTextMessageContent
	return b
}

// TextMessageEnd configures the builder for a TEXT_MESSAGE_END event
func (b *EventBuilder) TextMessageEnd() *EventBuilder {
	b.eventType = EventTypeTextMessageEnd
	return b
}

// ToolCallStart configures the builder for a TOOL_CALL_START event
func (b *EventBuilder) ToolCallStart() *EventBuilder {
	b.eventType = EventTypeToolCallStart
	return b
}

// ToolCallArgs configures the builder for a TOOL_CALL_ARGS event
func (b *EventBuilder) ToolCallArgs() *EventBuilder {
	b.eventType = EventTypeToolCallArgs
	return b
}

// ToolCallEnd configures the builder for a TOOL_CALL_END event
func (b *EventBuilder) ToolCallEnd() *EventBuilder {
	b.eventType = EventTypeToolCallEnd
	return b
}

// StateSnapshot configures the builder for a STATE_SNAPSHOT event
func (b *EventBuilder) StateSnapshot() *EventBuilder {
	b.eventType = EventTypeStateSnapshot
	return b
}

// StateDelta configures the builder for a STATE_DELTA event
func (b *EventBuilder) StateDelta() *EventBuilder {
	b.eventType = EventTypeStateDelta
	return b
}

// MessagesSnapshot configures the builder for a MESSAGES_SNAPSHOT event
func (b *EventBuilder) MessagesSnapshot() *EventBuilder {
	b.eventType = EventTypeMessagesSnapshot
	return b
}

// Raw configures the builder for a RAW event
func (b *EventBuilder) Raw() *EventBuilder {
	b.eventType = EventTypeRaw
	return b
}

// Custom configures the builder for a CUSTOM event
func (b *EventBuilder) Custom() *EventBuilder {
	b.eventType = EventTypeCustom
	return b
}

// Field Configuration Methods

// WithTimestamp sets the event timestamp
func (b *EventBuilder) WithTimestamp(timestamp int64) *EventBuilder {
	b.timestamp = &timestamp
	return b
}

// WithCurrentTimestamp sets the event timestamp to the current time
func (b *EventBuilder) WithCurrentTimestamp() *EventBuilder {
	now := time.Now().UnixMilli()
	b.timestamp = &now
	return b
}

// WithThreadID sets the thread ID
func (b *EventBuilder) WithThreadID(threadID string) *EventBuilder {
	b.threadID = threadID
	return b
}

// WithRunID sets the run ID
func (b *EventBuilder) WithRunID(runID string) *EventBuilder {
	b.runID = runID
	return b
}

// WithMessageID sets the message ID
func (b *EventBuilder) WithMessageID(messageID string) *EventBuilder {
	b.messageID = messageID
	return b
}

// WithToolCallID sets the tool call ID
func (b *EventBuilder) WithToolCallID(toolCallID string) *EventBuilder {
	b.toolCallID = toolCallID
	return b
}

// WithStepName sets the step name
func (b *EventBuilder) WithStepName(stepName string) *EventBuilder {
	b.stepName = stepName
	return b
}

// WithRole sets the message role
func (b *EventBuilder) WithRole(role string) *EventBuilder {
	b.role = &role
	return b
}

// WithDelta sets the delta content
func (b *EventBuilder) WithDelta(delta string) *EventBuilder {
	b.delta = delta
	return b
}

// WithToolCallName sets the tool call name
func (b *EventBuilder) WithToolCallName(toolCallName string) *EventBuilder {
	b.toolCallName = toolCallName
	return b
}

// WithParentMessageID sets the parent message ID
func (b *EventBuilder) WithParentMessageID(parentMessageID string) *EventBuilder {
	b.parentMessageID = &parentMessageID
	return b
}

// WithErrorMessage sets the error message
func (b *EventBuilder) WithErrorMessage(message string) *EventBuilder {
	b.errorMessage = message
	return b
}

// WithErrorCode sets the error code
func (b *EventBuilder) WithErrorCode(code string) *EventBuilder {
	b.errorCode = &code
	return b
}

// WithSnapshot sets the state snapshot
func (b *EventBuilder) WithSnapshot(snapshot any) *EventBuilder {
	b.snapshot = snapshot
	return b
}

// WithDeltaOperations sets the JSON patch operations
func (b *EventBuilder) WithDeltaOperations(ops []JSONPatchOperation) *EventBuilder {
	b.deltaOps = ops
	return b
}

// WithMessages sets the messages for a snapshot
func (b *EventBuilder) WithMessages(messages []Message) *EventBuilder {
	b.messages = messages
	return b
}

// WithCustomName sets the custom event name
func (b *EventBuilder) WithCustomName(name string) *EventBuilder {
	b.customName = name
	return b
}

// WithCustomValue sets the custom event value
func (b *EventBuilder) WithCustomValue(value any) *EventBuilder {
	b.customValue = value
	return b
}

// WithRawEvent sets the raw event data
func (b *EventBuilder) WithRawEvent(event any) *EventBuilder {
	b.rawEvent = event
	return b
}

// WithRawSource sets the raw event source
func (b *EventBuilder) WithRawSource(source string) *EventBuilder {
	b.rawSource = &source
	return b
}

// WithAutoGenerateIDs enables automatic ID generation for empty fields
func (b *EventBuilder) WithAutoGenerateIDs() *EventBuilder {
	b.autoGenerateIDs = true
	return b
}

// Helper Methods for Complex Events

// AddDeltaOperation adds a single JSON patch operation
func (b *EventBuilder) AddDeltaOperation(op, path string, value any) *EventBuilder {
	if b.deltaOps == nil {
		b.deltaOps = make([]JSONPatchOperation, 0)
	}
	b.deltaOps = append(b.deltaOps, JSONPatchOperation{
		Op:    op,
		Path:  path,
		Value: value,
	})
	return b
}

// AddDeltaOperationWithFrom adds a JSON patch operation with a from path
func (b *EventBuilder) AddDeltaOperationWithFrom(op, path, from string) *EventBuilder {
	if b.deltaOps == nil {
		b.deltaOps = make([]JSONPatchOperation, 0)
	}
	b.deltaOps = append(b.deltaOps, JSONPatchOperation{
		Op:   op,
		Path: path,
		From: from,
	})
	return b
}

// AddMessage adds a message to the messages snapshot
func (b *EventBuilder) AddMessage(id, role, content string) *EventBuilder {
	if b.messages == nil {
		b.messages = make([]Message, 0)
	}
	msg := Message{
		ID:   id,
		Role: role,
	}
	if content != "" {
		msg.Content = &content
	}
	b.messages = append(b.messages, msg)
	return b
}

// Build constructs the final event
func (b *EventBuilder) Build() (Event, error) {
	// Apply auto-generation if enabled
	if b.autoGenerateIDs {
		b.applyAutoGeneration()
	}

	// Set timestamp if not provided
	if b.timestamp == nil {
		now := time.Now().UnixMilli()
		b.timestamp = &now
	}

	// Build the appropriate event type
	var event Event
	var err error

	switch b.eventType {
	case EventTypeRunStarted:
		event, err = b.buildRunStartedEvent()
	case EventTypeRunFinished:
		event, err = b.buildRunFinishedEvent()
	case EventTypeRunError:
		event, err = b.buildRunErrorEvent()
	case EventTypeStepStarted:
		event, err = b.buildStepStartedEvent()
	case EventTypeStepFinished:
		event, err = b.buildStepFinishedEvent()
	case EventTypeTextMessageStart:
		event, err = b.buildTextMessageStartEvent()
	case EventTypeTextMessageContent:
		event, err = b.buildTextMessageContentEvent()
	case EventTypeTextMessageEnd:
		event, err = b.buildTextMessageEndEvent()
	case EventTypeToolCallStart:
		event, err = b.buildToolCallStartEvent()
	case EventTypeToolCallArgs:
		event, err = b.buildToolCallArgsEvent()
	case EventTypeToolCallEnd:
		event, err = b.buildToolCallEndEvent()
	case EventTypeStateSnapshot:
		event, err = b.buildStateSnapshotEvent()
	case EventTypeStateDelta:
		event, err = b.buildStateDeltaEvent()
	case EventTypeMessagesSnapshot:
		event, err = b.buildMessagesSnapshotEvent()
	case EventTypeRaw:
		event, err = b.buildRawEvent()
	case EventTypeCustom:
		event, err = b.buildCustomEvent()
	default:
		return nil, fmt.Errorf("unknown event type: %s", b.eventType)
	}

	// Check for build errors
	if err != nil {
		return nil, fmt.Errorf("failed to build event: %w", err)
	}

	// Validate the constructed event before returning
	if err := event.Validate(); err != nil {
		return nil, fmt.Errorf("built event validation failed: %w", err)
	}

	return event, nil
}

// applyAutoGeneration generates IDs for empty fields
func (b *EventBuilder) applyAutoGeneration() {
	if b.threadID == "" && (b.eventType == EventTypeRunStarted || b.eventType == EventTypeRunFinished) {
		b.threadID = GenerateThreadID()
	}
	if b.runID == "" && (b.eventType == EventTypeRunStarted || b.eventType == EventTypeRunFinished || b.eventType == EventTypeRunError) {
		b.runID = GenerateRunID()
	}
	if b.messageID == "" && (b.eventType == EventTypeTextMessageStart || b.eventType == EventTypeTextMessageContent || b.eventType == EventTypeTextMessageEnd) {
		b.messageID = GenerateMessageID()
	}
	if b.toolCallID == "" && (b.eventType == EventTypeToolCallStart || b.eventType == EventTypeToolCallArgs || b.eventType == EventTypeToolCallEnd) {
		b.toolCallID = GenerateToolCallID()
	}
	if b.stepName == "" && (b.eventType == EventTypeStepStarted || b.eventType == EventTypeStepFinished) {
		b.stepName = GenerateStepID()
	}
}

// Build methods for each event type

func (b *EventBuilder) buildRunStartedEvent() (*RunStartedEvent, error) {
	event := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ThreadID: b.threadID,
		RunID:    b.runID,
	}
	return event, nil
}

func (b *EventBuilder) buildRunFinishedEvent() (*RunFinishedEvent, error) {
	event := &RunFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ThreadID: b.threadID,
		RunID:    b.runID,
	}
	return event, nil
}

func (b *EventBuilder) buildRunErrorEvent() (*RunErrorEvent, error) {
	event := &RunErrorEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Message: b.errorMessage,
		Code:    b.errorCode,
		RunID:   b.runID,
	}
	return event, nil
}

func (b *EventBuilder) buildStepStartedEvent() (*StepStartedEvent, error) {
	event := &StepStartedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		StepName: b.stepName,
	}
	return event, nil
}

func (b *EventBuilder) buildStepFinishedEvent() (*StepFinishedEvent, error) {
	event := &StepFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		StepName: b.stepName,
	}
	return event, nil
}

func (b *EventBuilder) buildTextMessageStartEvent() (*TextMessageStartEvent, error) {
	event := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
		Role:      b.role,
	}
	return event, nil
}

func (b *EventBuilder) buildTextMessageContentEvent() (*TextMessageContentEvent, error) {
	event := &TextMessageContentEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
		Delta:     b.delta,
	}
	return event, nil
}

func (b *EventBuilder) buildTextMessageEndEvent() (*TextMessageEndEvent, error) {
	event := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
	}
	return event, nil
}

func (b *EventBuilder) buildToolCallStartEvent() (*ToolCallStartEvent, error) {
	event := &ToolCallStartEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ToolCallID:      b.toolCallID,
		ToolCallName:    b.toolCallName,
		ParentMessageID: b.parentMessageID,
	}
	return event, nil
}

func (b *EventBuilder) buildToolCallArgsEvent() (*ToolCallArgsEvent, error) {
	event := &ToolCallArgsEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ToolCallID: b.toolCallID,
		Delta:      b.delta,
	}
	return event, nil
}

func (b *EventBuilder) buildToolCallEndEvent() (*ToolCallEndEvent, error) {
	event := &ToolCallEndEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ToolCallID: b.toolCallID,
	}
	return event, nil
}

func (b *EventBuilder) buildStateSnapshotEvent() (*StateSnapshotEvent, error) {
	event := &StateSnapshotEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Snapshot: b.snapshot,
	}
	return event, nil
}

func (b *EventBuilder) buildStateDeltaEvent() (*StateDeltaEvent, error) {
	event := &StateDeltaEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Delta: b.deltaOps,
	}
	return event, nil
}

func (b *EventBuilder) buildMessagesSnapshotEvent() (*MessagesSnapshotEvent, error) {
	event := &MessagesSnapshotEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Messages: b.messages,
	}
	return event, nil
}

func (b *EventBuilder) buildRawEvent() (*RawEvent, error) {
	event := &RawEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Event:  b.rawEvent,
		Source: b.rawSource,
	}
	return event, nil
}

func (b *EventBuilder) buildCustomEvent() (*CustomEvent, error) {
	event := &CustomEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Name:  b.customName,
		Value: b.customValue,
	}
	return event, nil
}
