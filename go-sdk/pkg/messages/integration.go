package messages

import (
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/core/events"
)

// ToEventMessage converts a Message to the events.Message format
func ToEventMessage(msg Message) (*events.Message, error) {
	eventMsg := &events.Message{
		ID:      msg.GetID(),
		Role:    string(msg.GetRole()),
		Content: msg.GetContent(),
		Name:    msg.GetName(),
	}

	// Handle specific message types
	switch m := msg.(type) {
	case *AssistantMessage:
		if len(m.ToolCalls) > 0 {
			eventMsg.ToolCalls = make([]events.ToolCall, len(m.ToolCalls))
			for i, tc := range m.ToolCalls {
				eventMsg.ToolCalls[i] = events.ToolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: events.Function{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}
			}
		}
	case *ToolMessage:
		eventMsg.ToolCallID = &m.ToolCallID
		// Tool messages have required content, so we need to ensure it's set
		eventMsg.Content = m.Content
	}

	return eventMsg, nil
}

// FromEventMessage converts an events.Message to the appropriate Message type
func FromEventMessage(eventMsg *events.Message) (Message, error) {
	if eventMsg == nil {
		return nil, fmt.Errorf("event message is nil")
	}

	role := MessageRole(eventMsg.Role)
	if err := role.Validate(); err != nil {
		return nil, fmt.Errorf("invalid role in event message: %w", err)
	}

	switch role {
	case RoleUser:
		if eventMsg.Content == nil {
			return nil, fmt.Errorf("user message requires content")
		}
		msg := NewUserMessage(*eventMsg.Content)
		msg.ID = eventMsg.ID
		msg.Name = eventMsg.Name
		return msg, nil

	case RoleAssistant:
		var msg *AssistantMessage
		if len(eventMsg.ToolCalls) > 0 {
			// Convert tool calls
			toolCalls := make([]ToolCall, len(eventMsg.ToolCalls))
			for i, etc := range eventMsg.ToolCalls {
				toolCalls[i] = ToolCall{
					ID:   etc.ID,
					Type: etc.Type,
					Function: Function{
						Name:      etc.Function.Name,
						Arguments: etc.Function.Arguments,
					},
				}
			}
			msg = NewAssistantMessageWithTools(toolCalls)
			msg.Content = eventMsg.Content
		} else {
			if eventMsg.Content == nil {
				return nil, fmt.Errorf("assistant message requires content or tool calls")
			}
			msg = NewAssistantMessage(*eventMsg.Content)
		}
		msg.ID = eventMsg.ID
		msg.Name = eventMsg.Name
		return msg, nil

	case RoleSystem:
		if eventMsg.Content == nil {
			return nil, fmt.Errorf("system message requires content")
		}
		msg := NewSystemMessage(*eventMsg.Content)
		msg.ID = eventMsg.ID
		msg.Name = eventMsg.Name
		return msg, nil

	case RoleTool:
		if eventMsg.Content == nil {
			return nil, fmt.Errorf("tool message requires content")
		}
		if eventMsg.ToolCallID == nil {
			return nil, fmt.Errorf("tool message requires tool call ID")
		}
		msg := NewToolMessage(*eventMsg.Content, *eventMsg.ToolCallID)
		msg.ID = eventMsg.ID
		return msg, nil

	case RoleDeveloper:
		if eventMsg.Content == nil {
			return nil, fmt.Errorf("developer message requires content")
		}
		msg := NewDeveloperMessage(*eventMsg.Content)
		msg.ID = eventMsg.ID
		msg.Name = eventMsg.Name
		return msg, nil

	default:
		return nil, fmt.Errorf("unsupported role: %s", role)
	}
}

// ToEventMessageList converts a MessageList to a slice of events.Message
func ToEventMessageList(msgs MessageList) ([]events.Message, error) {
	eventMsgs := make([]events.Message, 0, len(msgs))

	for i, msg := range msgs {
		eventMsg, err := ToEventMessage(msg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert message at index %d: %w", i, err)
		}
		eventMsgs = append(eventMsgs, *eventMsg)
	}

	return eventMsgs, nil
}

// FromEventMessageList converts a slice of events.Message to MessageList
func FromEventMessageList(eventMsgs []events.Message) (MessageList, error) {
	msgs := make(MessageList, 0, len(eventMsgs))

	for i, eventMsg := range eventMsgs {
		msg, err := FromEventMessage(&eventMsg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert event message at index %d: %w", i, err)
		}
		msgs = append(msgs, msg)
	}

	return msgs, nil
}

// CreateMessagesSnapshotEvent creates a MessagesSnapshotEvent from a MessageList
func CreateMessagesSnapshotEvent(msgs MessageList) (*events.MessagesSnapshotEvent, error) {
	eventMsgs, err := ToEventMessageList(msgs)
	if err != nil {
		return nil, fmt.Errorf("failed to convert messages: %w", err)
	}

	return events.NewMessagesSnapshotEvent(eventMsgs), nil
}

// ExtractMessagesFromSnapshot extracts MessageList from a MessagesSnapshotEvent
func ExtractMessagesFromSnapshot(snapshot *events.MessagesSnapshotEvent) (MessageList, error) {
	if snapshot == nil {
		return nil, fmt.Errorf("snapshot event is nil")
	}

	return FromEventMessageList(snapshot.Messages)
}
