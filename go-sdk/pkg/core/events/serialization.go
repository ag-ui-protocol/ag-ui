package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
	"google.golang.org/protobuf/proto"
)

// EventFromJSON parses an event from JSON data
func EventFromJSON(data []byte) (Event, error) {
	// First, parse the base event to determine the type
	var base struct {
		Type EventType `json:"type"`
	}

	if err := json.Unmarshal(data, &base); err != nil {
		return nil, fmt.Errorf("failed to parse event type: %w", err)
	}

	// Create the appropriate event type based on the type field
	var event Event
	switch base.Type {
	case EventTypeRunStarted:
		event = &RunStartedEvent{}
	case EventTypeRunFinished:
		event = &RunFinishedEvent{}
	case EventTypeRunError:
		event = &RunErrorEvent{}
	case EventTypeStepStarted:
		event = &StepStartedEvent{}
	case EventTypeStepFinished:
		event = &StepFinishedEvent{}
	case EventTypeTextMessageStart:
		event = &TextMessageStartEvent{}
	case EventTypeTextMessageContent:
		event = &TextMessageContentEvent{}
	case EventTypeTextMessageEnd:
		event = &TextMessageEndEvent{}
	case EventTypeToolCallStart:
		event = &ToolCallStartEvent{}
	case EventTypeToolCallArgs:
		event = &ToolCallArgsEvent{}
	case EventTypeToolCallEnd:
		event = &ToolCallEndEvent{}
	case EventTypeStateSnapshot:
		event = &StateSnapshotEvent{}
	case EventTypeStateDelta:
		event = &StateDeltaEvent{}
	case EventTypeMessagesSnapshot:
		event = &MessagesSnapshotEvent{}
	case EventTypeRaw:
		event = &RawEvent{}
	case EventTypeCustom:
		event = &CustomEvent{}
	default:
		return nil, fmt.Errorf("unknown event type: %s", base.Type)
	}

	// Unmarshal into the specific event type
	if err := json.Unmarshal(data, event); err != nil {
		return nil, fmt.Errorf("failed to unmarshal event: %w", err)
	}

	return event, nil
}

// EventFromProtobuf converts a protobuf Event to a Go Event interface
func EventFromProtobuf(pbEvent *generated.Event) (Event, error) {
	if pbEvent == nil {
		return nil, fmt.Errorf("protobuf event is nil")
	}

	switch pbEventType := pbEvent.Event.(type) {
	case *generated.Event_RunStarted:
		return protobufToRunStartedEvent(pbEventType.RunStarted), nil
	case *generated.Event_RunFinished:
		return protobufToRunFinishedEvent(pbEventType.RunFinished), nil
	case *generated.Event_RunError:
		return protobufToRunErrorEvent(pbEventType.RunError), nil
	case *generated.Event_StepStarted:
		return protobufToStepStartedEvent(pbEventType.StepStarted), nil
	case *generated.Event_StepFinished:
		return protobufToStepFinishedEvent(pbEventType.StepFinished), nil
	case *generated.Event_TextMessageStart:
		return protobufToTextMessageStartEvent(pbEventType.TextMessageStart), nil
	case *generated.Event_TextMessageContent:
		return protobufToTextMessageContentEvent(pbEventType.TextMessageContent), nil
	case *generated.Event_TextMessageEnd:
		return protobufToTextMessageEndEvent(pbEventType.TextMessageEnd), nil
	case *generated.Event_ToolCallStart:
		return protobufToToolCallStartEvent(pbEventType.ToolCallStart), nil
	case *generated.Event_ToolCallArgs:
		return protobufToToolCallArgsEvent(pbEventType.ToolCallArgs), nil
	case *generated.Event_ToolCallEnd:
		return protobufToToolCallEndEvent(pbEventType.ToolCallEnd), nil
	case *generated.Event_StateSnapshot:
		return protobufToStateSnapshotEvent(pbEventType.StateSnapshot), nil
	case *generated.Event_StateDelta:
		return protobufToStateDeltaEvent(pbEventType.StateDelta), nil
	case *generated.Event_MessagesSnapshot:
		return protobufToMessagesSnapshotEvent(pbEventType.MessagesSnapshot), nil
	case *generated.Event_Raw:
		return protobufToRawEvent(pbEventType.Raw), nil
	case *generated.Event_Custom:
		return protobufToCustomEvent(pbEventType.Custom), nil
	default:
		return nil, fmt.Errorf("unknown protobuf event type: %T", pbEventType)
	}
}

// EventToProtobufBytes serializes an event to protobuf binary data
func EventToProtobufBytes(event Event) ([]byte, error) {
	pbEvent, err := event.ToProtobuf()
	if err != nil {
		return nil, fmt.Errorf("failed to convert to protobuf: %w", err)
	}

	return proto.Marshal(pbEvent)
}

// EventFromProtobufBytes deserializes an event from protobuf binary data
func EventFromProtobufBytes(data []byte) (Event, error) {
	var pbEvent generated.Event
	if err := proto.Unmarshal(data, &pbEvent); err != nil {
		return nil, fmt.Errorf("failed to unmarshal protobuf: %w", err)
	}

	return EventFromProtobuf(&pbEvent)
}

// Helper functions to convert protobuf events to Go events
func protobufToBaseEvent(pbBase *generated.BaseEvent) *BaseEvent {
	if pbBase == nil {
		// Return a base event with unknown type that will fail validation
		return &BaseEvent{
			EventType: EventTypeUnknown,
		}
	}

	base := &BaseEvent{
		EventType: protobufToEventType(pbBase.Type),
	}

	if pbBase.Timestamp != nil {
		base.TimestampMs = pbBase.Timestamp
	}

	return base
}

func protobufToRunStartedEvent(pb *generated.RunStartedEvent) *RunStartedEvent {
	return &RunStartedEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		ThreadID:  pb.ThreadId,
		RunID:     pb.RunId,
	}
}

func protobufToRunFinishedEvent(pb *generated.RunFinishedEvent) *RunFinishedEvent {
	return &RunFinishedEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		ThreadID:  pb.ThreadId,
		RunID:     pb.RunId,
	}
}

func protobufToRunErrorEvent(pb *generated.RunErrorEvent) *RunErrorEvent {
	event := &RunErrorEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Message:   pb.Message,
	}

	if pb.Code != nil {
		event.Code = pb.Code
	}

	return event
}

func protobufToStepStartedEvent(pb *generated.StepStartedEvent) *StepStartedEvent {
	return &StepStartedEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		StepName:  pb.StepName,
	}
}

func protobufToStepFinishedEvent(pb *generated.StepFinishedEvent) *StepFinishedEvent {
	return &StepFinishedEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		StepName:  pb.StepName,
	}
}

func protobufToTextMessageStartEvent(pb *generated.TextMessageStartEvent) *TextMessageStartEvent {
	event := &TextMessageStartEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		MessageID: pb.MessageId,
	}

	if pb.Role != nil {
		event.Role = pb.Role
	}

	return event
}

func protobufToTextMessageContentEvent(pb *generated.TextMessageContentEvent) *TextMessageContentEvent {
	return &TextMessageContentEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		MessageID: pb.MessageId,
		Delta:     pb.Delta,
	}
}

func protobufToTextMessageEndEvent(pb *generated.TextMessageEndEvent) *TextMessageEndEvent {
	return &TextMessageEndEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		MessageID: pb.MessageId,
	}
}

func protobufToToolCallStartEvent(pb *generated.ToolCallStartEvent) *ToolCallStartEvent {
	event := &ToolCallStartEvent{
		BaseEvent:    protobufToBaseEvent(pb.BaseEvent),
		ToolCallID:   pb.ToolCallId,
		ToolCallName: pb.ToolCallName,
	}

	if pb.ParentMessageId != nil {
		event.ParentMessageID = pb.ParentMessageId
	}

	return event
}

func protobufToToolCallArgsEvent(pb *generated.ToolCallArgsEvent) *ToolCallArgsEvent {
	return &ToolCallArgsEvent{
		BaseEvent:  protobufToBaseEvent(pb.BaseEvent),
		ToolCallID: pb.ToolCallId,
		Delta:      pb.Delta,
	}
}

func protobufToToolCallEndEvent(pb *generated.ToolCallEndEvent) *ToolCallEndEvent {
	return &ToolCallEndEvent{
		BaseEvent:  protobufToBaseEvent(pb.BaseEvent),
		ToolCallID: pb.ToolCallId,
	}
}

func protobufToStateSnapshotEvent(pb *generated.StateSnapshotEvent) *StateSnapshotEvent {
	var snapshot any
	if pb.Snapshot != nil {
		snapshot = pb.Snapshot.AsInterface()
	}

	return &StateSnapshotEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Snapshot:  snapshot,
	}
}

func protobufToStateDeltaEvent(pb *generated.StateDeltaEvent) *StateDeltaEvent {
	var delta []JSONPatchOperation
	for _, pbOp := range pb.Delta {
		op := JSONPatchOperation{
			Op:   protobufToJsonPatchOperationType(pbOp.Op),
			Path: pbOp.Path,
		}

		if pbOp.Value != nil {
			op.Value = pbOp.Value.AsInterface()
		}

		if pbOp.From != nil {
			op.From = *pbOp.From
		}

		delta = append(delta, op)
	}

	return &StateDeltaEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Delta:     delta,
	}
}

func protobufToJsonPatchOperationType(pbOp generated.JsonPatchOperationType) string {
	switch pbOp {
	case generated.JsonPatchOperationType_ADD:
		return "add"
	case generated.JsonPatchOperationType_REMOVE:
		return "remove"
	case generated.JsonPatchOperationType_REPLACE:
		return "replace"
	case generated.JsonPatchOperationType_MOVE:
		return "move"
	case generated.JsonPatchOperationType_COPY:
		return "copy"
	case generated.JsonPatchOperationType_TEST:
		return "test"
	default:
		// Return an invalid operation type that will be caught during validation
		return fmt.Sprintf("unknown_%d", pbOp)
	}
}

func protobufToMessagesSnapshotEvent(pb *generated.MessagesSnapshotEvent) *MessagesSnapshotEvent {
	var messages []Message
	for _, pbMsg := range pb.Messages {
		msg := Message{
			ID:   pbMsg.Id,
			Role: pbMsg.Role,
		}

		if pbMsg.Content != nil {
			msg.Content = pbMsg.Content
		}

		if pbMsg.Name != nil {
			msg.Name = pbMsg.Name
		}

		if pbMsg.ToolCallId != nil {
			msg.ToolCallID = pbMsg.ToolCallId
		}

		for _, pbToolCall := range pbMsg.ToolCalls {
			toolCall := ToolCall{
				ID:   pbToolCall.Id,
				Type: pbToolCall.Type,
				Function: Function{
					Name:      pbToolCall.Function.Name,
					Arguments: pbToolCall.Function.Arguments,
				},
			}
			msg.ToolCalls = append(msg.ToolCalls, toolCall)
		}

		messages = append(messages, msg)
	}

	return &MessagesSnapshotEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Messages:  messages,
	}
}

func protobufToRawEvent(pb *generated.RawEvent) *RawEvent {
	var event any
	if pb.Event != nil {
		event = pb.Event.AsInterface()
	}

	rawEvent := &RawEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Event:     event,
	}

	if pb.Source != nil {
		rawEvent.Source = pb.Source
	}

	return rawEvent
}

func protobufToCustomEvent(pb *generated.CustomEvent) *CustomEvent {
	customEvent := &CustomEvent{
		BaseEvent: protobufToBaseEvent(pb.BaseEvent),
		Name:      pb.Name,
	}

	if pb.Value != nil {
		customEvent.Value = pb.Value.AsInterface()
	}

	return customEvent
}
