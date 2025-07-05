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
	// Validate event type is set early to provide immediate feedback
	if b.eventType == "" {
		return nil, fmt.Errorf("event type not set: use one of the builder methods " +
			"(e.g., RunStarted(), TextMessageStart()) to set the event type before calling Build()")
	}

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
	event, err := b.buildEventByType()
	if err != nil {
		return nil, fmt.Errorf("failed to build event: %w", err)
	}

	// Validate the constructed event before returning
	if err := event.Validate(); err != nil {
		return nil, fmt.Errorf("built event validation failed: %w", err)
	}

	return event, nil
}

// buildEventByType builds the appropriate event based on the event type
func (b *EventBuilder) buildEventByType() (Event, error) {
	switch b.eventType {
	case EventTypeRunStarted:
		return b.buildRunStartedEvent()
	case EventTypeRunFinished:
		return b.buildRunFinishedEvent()
	case EventTypeRunError:
		return b.buildRunErrorEvent()
	case EventTypeStepStarted:
		return b.buildStepStartedEvent()
	case EventTypeStepFinished:
		return b.buildStepFinishedEvent()
	case EventTypeTextMessageStart:
		return b.buildTextMessageStartEvent()
	case EventTypeTextMessageContent:
		return b.buildTextMessageContentEvent()
	case EventTypeTextMessageEnd:
		return b.buildTextMessageEndEvent()
	case EventTypeToolCallStart:
		return b.buildToolCallStartEvent()
	case EventTypeToolCallArgs:
		return b.buildToolCallArgsEvent()
	case EventTypeToolCallEnd:
		return b.buildToolCallEndEvent()
	case EventTypeStateSnapshot:
		return b.buildStateSnapshotEvent()
	case EventTypeStateDelta:
		return b.buildStateDeltaEvent()
	case EventTypeMessagesSnapshot:
		return b.buildMessagesSnapshotEvent()
	case EventTypeRaw:
		return b.buildRawEvent()
	case EventTypeCustom:
		return b.buildCustomEvent()
	default:
		return nil, fmt.Errorf("unknown event type: %s", b.eventType)
	}
}

// applyAutoGeneration generates IDs for empty fields
func (b *EventBuilder) applyAutoGeneration() {
	b.generateThreadIDIfNeeded()
	b.generateRunIDIfNeeded()
	b.generateMessageIDIfNeeded()
	b.generateToolCallIDIfNeeded()
	b.generateStepNameIfNeeded()
}

// generateThreadIDIfNeeded generates thread ID for events that need it
func (b *EventBuilder) generateThreadIDIfNeeded() {
	if b.threadID != "" {
		return
	}
	if b.eventType == EventTypeRunStarted || b.eventType == EventTypeRunFinished {
		b.threadID = GenerateThreadID()
	}
}

// generateRunIDIfNeeded generates run ID for events that need it
func (b *EventBuilder) generateRunIDIfNeeded() {
	if b.runID != "" {
		return
	}
	switch b.eventType {
	case EventTypeRunStarted, EventTypeRunFinished, EventTypeRunError:
		b.runID = GenerateRunID()
	}
}

// generateMessageIDIfNeeded generates message ID for events that need it
func (b *EventBuilder) generateMessageIDIfNeeded() {
	if b.messageID != "" {
		return
	}
	switch b.eventType {
	case EventTypeTextMessageStart, EventTypeTextMessageContent, EventTypeTextMessageEnd:
		b.messageID = GenerateMessageID()
	}
}

// generateToolCallIDIfNeeded generates tool call ID for events that need it
func (b *EventBuilder) generateToolCallIDIfNeeded() {
	if b.toolCallID != "" {
		return
	}
	switch b.eventType {
	case EventTypeToolCallStart, EventTypeToolCallArgs, EventTypeToolCallEnd:
		b.toolCallID = GenerateToolCallID()
	}
}

// generateStepNameIfNeeded generates step name for events that need it
func (b *EventBuilder) generateStepNameIfNeeded() {
	if b.stepName != "" {
		return
	}
	if b.eventType == EventTypeStepStarted || b.eventType == EventTypeStepFinished {
		b.stepName = GenerateStepID()
	}
}

// Build methods for each event type

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildRunStartedEvent() (*RunStartedEvent, error) {
	event := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ThreadID: b.threadID,
		RunID:    b.runID,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildRunFinishedEvent() (*RunFinishedEvent, error) {
	event := &RunFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ThreadID: b.threadID,
		RunID:    b.runID,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
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
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildStepStartedEvent() (*StepStartedEvent, error) {
	event := &StepStartedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		StepName: b.stepName,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildStepFinishedEvent() (*StepFinishedEvent, error) {
	event := &StepFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		StepName: b.stepName,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildTextMessageStartEvent() (*TextMessageStartEvent, error) {
	event := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
		Role:      b.role,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildTextMessageContentEvent() (*TextMessageContentEvent, error) {
	event := &TextMessageContentEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
		Delta:     b.delta,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildTextMessageEndEvent() (*TextMessageEndEvent, error) {
	event := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		MessageID: b.messageID,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
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
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildToolCallArgsEvent() (*ToolCallArgsEvent, error) {
	event := &ToolCallArgsEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ToolCallID: b.toolCallID,
		Delta:      b.delta,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildToolCallEndEvent() (*ToolCallEndEvent, error) {
	event := &ToolCallEndEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		ToolCallID: b.toolCallID,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildStateSnapshotEvent() (*StateSnapshotEvent, error) {
	event := &StateSnapshotEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Snapshot: b.snapshot,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildStateDeltaEvent() (*StateDeltaEvent, error) {
	event := &StateDeltaEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Delta: b.deltaOps,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildMessagesSnapshotEvent() (*MessagesSnapshotEvent, error) {
	event := &MessagesSnapshotEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Messages: b.messages,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildRawEvent() (*RawEvent, error) {
	event := &RawEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Event:  b.rawEvent,
		Source: b.rawSource,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}

//nolint:unparam // Error return is kept for future extensibility and API consistency
func (b *EventBuilder) buildCustomEvent() (*CustomEvent, error) {
	event := &CustomEvent{
		BaseEvent: &BaseEvent{
			EventType:   b.eventType,
			TimestampMs: b.timestamp,
		},
		Name:  b.customName,
		Value: b.customValue,
	}
	// Error return is kept for future extensibility (e.g., field validation)
	return event, nil
}
