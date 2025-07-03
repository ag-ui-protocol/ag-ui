package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
	"google.golang.org/protobuf/types/known/structpb"
)

// validJSONPatchOps contains the valid JSON Patch operations for efficient lookup
var validJSONPatchOps = map[string]bool{
	"add":     true,
	"remove":  true,
	"replace": true,
	"move":    true,
	"copy":    true,
	"test":    true,
}

// StateSnapshotEvent contains a complete snapshot of the state
type StateSnapshotEvent struct {
	*BaseEvent
	Snapshot any `json:"snapshot"`
}

// NewStateSnapshotEvent creates a new state snapshot event
func NewStateSnapshotEvent(snapshot any) *StateSnapshotEvent {
	return &StateSnapshotEvent{
		BaseEvent: NewBaseEvent(EventTypeStateSnapshot),
		Snapshot:  snapshot,
	}
}

// Validate validates the state snapshot event
func (e *StateSnapshotEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Snapshot == nil {
		return fmt.Errorf("StateSnapshotEvent validation failed: snapshot field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StateSnapshotEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *StateSnapshotEvent) ToProtobuf() (*generated.Event, error) {
	// Convert the snapshot to protobuf Value
	snapshotValue, err := structpb.NewValue(e.Snapshot)
	if err != nil {
		return nil, fmt.Errorf("failed to convert snapshot to protobuf: %w", err)
	}

	pbEvent := &generated.StateSnapshotEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Snapshot:  snapshotValue,
	}

	return &generated.Event{
		Event: &generated.Event_StateSnapshot{
			StateSnapshot: pbEvent,
		},
	}, nil
}

// JSONPatchOperation represents a JSON Patch operation (RFC 6902)
type JSONPatchOperation struct {
	Op    string `json:"op"`              // "add", "remove", "replace", "move", "copy", "test"
	Path  string `json:"path"`            // JSON Pointer path
	Value any    `json:"value,omitempty"` // Value for add, replace, test operations
	From  string `json:"from,omitempty"`  // Source path for move, copy operations
}

// StateDeltaEvent contains incremental state changes using JSON Patch
type StateDeltaEvent struct {
	*BaseEvent
	Delta []JSONPatchOperation `json:"delta"`
}

// NewStateDeltaEvent creates a new state delta event
func NewStateDeltaEvent(delta []JSONPatchOperation) *StateDeltaEvent {
	return &StateDeltaEvent{
		BaseEvent: NewBaseEvent(EventTypeStateDelta),
		Delta:     delta,
	}
}

// Validate validates the state delta event
func (e *StateDeltaEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if len(e.Delta) == 0 {
		return fmt.Errorf("StateDeltaEvent validation failed: delta field must contain at least one operation")
	}

	// Validate each JSON patch operation
	for i, op := range e.Delta {
		if err := validateJSONPatchOperation(op); err != nil {
			return fmt.Errorf("StateDeltaEvent validation failed: invalid operation at index %d: %w", i, err)
		}
	}

	return nil
}

// validateJSONPatchOperation validates a single JSON patch operation
func validateJSONPatchOperation(op JSONPatchOperation) error {
	// Validate operation type using map lookup for better performance
	if !validJSONPatchOps[op.Op] {
		return fmt.Errorf("op field must be one of: add, remove, replace, move, copy, test, got: %s", op.Op)
	}

	// Validate path
	if op.Path == "" {
		return fmt.Errorf("path field is required")
	}

	// Validate value for operations that require it
	if (op.Op == "add" || op.Op == "replace" || op.Op == "test") && op.Value == nil {
		return fmt.Errorf("value field is required for %s operation", op.Op)
	}

	// Validate from for operations that require it
	if (op.Op == "move" || op.Op == "copy") && op.From == "" {
		return fmt.Errorf("from field is required for %s operation", op.Op)
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StateDeltaEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// stringToJsonPatchOperationType converts string operation to protobuf enum
func stringToJsonPatchOperationType(op string) generated.JsonPatchOperationType {
	switch op {
	case "add":
		return generated.JsonPatchOperationType_ADD
	case "remove":
		return generated.JsonPatchOperationType_REMOVE
	case "replace":
		return generated.JsonPatchOperationType_REPLACE
	case "move":
		return generated.JsonPatchOperationType_MOVE
	case "copy":
		return generated.JsonPatchOperationType_COPY
	case "test":
		return generated.JsonPatchOperationType_TEST
	default:
		return generated.JsonPatchOperationType_ADD // Default fallback
	}
}

// ToProtobuf converts the event to its protobuf representation
func (e *StateDeltaEvent) ToProtobuf() (*generated.Event, error) {
	// Convert JSON patch operations to protobuf
	var pbOps []*generated.JsonPatchOperation
	for _, op := range e.Delta {
		pbOp := &generated.JsonPatchOperation{
			Op:   stringToJsonPatchOperationType(op.Op),
			Path: op.Path,
		}

		if op.Value != nil {
			value, err := structpb.NewValue(op.Value)
			if err != nil {
				return nil, fmt.Errorf("failed to convert patch value to protobuf: %w", err)
			}
			pbOp.Value = value
		}

		if op.From != "" {
			pbOp.From = &op.From
		}

		pbOps = append(pbOps, pbOp)
	}

	pbEvent := &generated.StateDeltaEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Delta:     pbOps,
	}

	return &generated.Event{
		Event: &generated.Event_StateDelta{
			StateDelta: pbEvent,
		},
	}, nil
}

// Message represents a message in the conversation
type Message struct {
	ID         string     `json:"id"`
	Role       string     `json:"role"`
	Content    *string    `json:"content,omitempty"`
	Name       *string    `json:"name,omitempty"`
	ToolCalls  []ToolCall `json:"toolCalls,omitempty"`
	ToolCallID *string    `json:"toolCallId,omitempty"`
}

// ToolCall represents a tool call within a message
type ToolCall struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Function Function `json:"function"`
}

// Function represents a function call
type Function struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// MessagesSnapshotEvent contains a snapshot of all messages
type MessagesSnapshotEvent struct {
	*BaseEvent
	Messages []Message `json:"messages"`
}

// NewMessagesSnapshotEvent creates a new messages snapshot event
func NewMessagesSnapshotEvent(messages []Message) *MessagesSnapshotEvent {
	return &MessagesSnapshotEvent{
		BaseEvent: NewBaseEvent(EventTypeMessagesSnapshot),
		Messages:  messages,
	}
}

// Validate validates the messages snapshot event
func (e *MessagesSnapshotEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	// Validate each message
	for i, msg := range e.Messages {
		if err := validateMessage(msg); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}
	}

	return nil
}

// validateMessage validates a single message
func validateMessage(msg Message) error {
	if msg.ID == "" {
		return fmt.Errorf("message id field is required")
	}

	if msg.Role == "" {
		return fmt.Errorf("message role field is required")
	}

	// Validate tool calls if present
	for i, toolCall := range msg.ToolCalls {
		if err := validateToolCall(toolCall); err != nil {
			return fmt.Errorf("invalid tool call at index %d: %w", i, err)
		}
	}

	return nil
}

// validateToolCall validates a single tool call
func validateToolCall(toolCall ToolCall) error {
	if toolCall.ID == "" {
		return fmt.Errorf("tool call id field is required")
	}

	if toolCall.Type == "" {
		return fmt.Errorf("tool call type field is required")
	}

	if toolCall.Function.Name == "" {
		return fmt.Errorf("function name field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *MessagesSnapshotEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToProtobuf converts the event to its protobuf representation
func (e *MessagesSnapshotEvent) ToProtobuf() (*generated.Event, error) {
	// Convert messages to protobuf
	var pbMessages []*generated.Message
	for _, msg := range e.Messages {
		pbMsg := &generated.Message{
			Id:   msg.ID,
			Role: msg.Role,
		}

		if msg.Content != nil {
			pbMsg.Content = msg.Content
		}

		if msg.Name != nil {
			pbMsg.Name = msg.Name
		}

		if msg.ToolCallID != nil {
			pbMsg.ToolCallId = msg.ToolCallID
		}

		// Convert tool calls
		for _, toolCall := range msg.ToolCalls {
			pbToolCall := &generated.ToolCall{
				Id:   toolCall.ID,
				Type: toolCall.Type,
				Function: &generated.ToolCall_Function{
					Name:      toolCall.Function.Name,
					Arguments: toolCall.Function.Arguments,
				},
			}
			pbMsg.ToolCalls = append(pbMsg.ToolCalls, pbToolCall)
		}

		pbMessages = append(pbMessages, pbMsg)
	}

	pbEvent := &generated.MessagesSnapshotEvent{
		BaseEvent: e.BaseEvent.ToProtobufBase(),
		Messages:  pbMessages,
	}

	return &generated.Event{
		Event: &generated.Event_MessagesSnapshot{
			MessagesSnapshot: pbEvent,
		},
	}, nil
}
