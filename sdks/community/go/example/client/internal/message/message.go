package message

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/charmbracelet/lipgloss"
)

var serverStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("21"))

type Message struct {
	contents []string
}

func (m *Message) Strings() []string {
	return m.contents
}

func NewMessage(event events.Event) *Message {
	return getMessageFromEvent(event)
}

func getMessageFromEvent(event events.Event) *Message {
	eventType := event.Type()
	switch eventType {
	case events.EventTypeRunStarted:
		_, ok := event.(*events.RunStartedEvent)
		if !ok {
			return nil
		}
		content := "Run started"
		return &Message{
			contents: []string{content},
		}

	case events.EventTypeRunFinished:
		_, ok := event.(*events.RunFinishedEvent)
		if !ok {
			return nil
		}
		content := "Run finished"
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeRunError:
		errorEvent, ok := event.(*events.RunErrorEvent)
		if !ok {
			return nil
		}
		content := fmt.Sprintf("Run error: %s", errorEvent.Message)
		if errorEvent.Code != nil {
			content = fmt.Sprintf("Run error [%s]: %s", *errorEvent.Code, errorEvent.Message)
		}
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeTextMessageStart:
		_, ok := event.(*events.TextMessageStartEvent)
		if !ok {
			return nil
		}
		curMsg := "text message started"
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeTextMessageContent:
		msg, ok := event.(*events.TextMessageContentEvent)
		if !ok {
			return nil
		}
		return &Message{
			contents: []string{msg.Delta},
		}
	case events.EventTypeTextMessageEnd:
		_, ok := event.(*events.TextMessageEndEvent)
		if !ok {
			return nil
		}
		curMsg := "text message ended"
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeToolCallStart:
		_, ok := event.(*events.ToolCallStartEvent)
		if !ok {
			return nil
		}
		curMsg := "tool call started"
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeToolCallArgs:
		args, ok := event.(*events.ToolCallArgsEvent)
		if !ok {
			return nil
		}
		curMsg := fmt.Sprintf("tool call args: %s", args.Delta)
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeToolCallEnd:
		_, ok := event.(*events.ToolCallEndEvent)
		if !ok {
			return nil
		}
		curMsg := "tool call ended"
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeToolCallResult:
		result, ok := event.(*events.ToolCallResultEvent)
		if !ok {
			return nil
		}
		curMsg := result.Content
		return &Message{
			contents: []string{curMsg},
		}
	case events.EventTypeStateSnapshot:
		snapshot, ok := event.(*events.StateSnapshotEvent)
		if !ok {
			return nil
		}
		var contents []string
		if snapshot.Snapshot != nil {
			jsonData, err := json.Marshal(snapshot.Snapshot)
			if err != nil {
				fmt.Println("Error marshaling JSON:", err)
				return nil
			}
			contents = append(contents, string(jsonData))

		}
		return &Message{
			contents: contents,
		}
	case events.EventTypeStateDelta:
		delta, ok := event.(*events.StateDeltaEvent)
		if !ok {
			return nil
		}
		var contents []string
		for _, op := range delta.Delta {
			currOp := fmt.Sprintf("%s Operation: %s, Path: %s, Value: %s", serverStyle.Render("Server:"), op.Op, op.Path, op.Value)
			contents = append(contents, currOp)
		}
		return &Message{
			contents: contents,
		}
	case events.EventTypeMessagesSnapshot:
		snapshot, ok := event.(*events.MessagesSnapshotEvent)
		if !ok {
			return nil
		}
		var contents []string
		for _, msg := range snapshot.Messages {
			if msg.Content != nil && msg.Role != "user" {
				contents = append(contents, *msg.Content)
			}
			if msg.ToolCalls != nil {
				for _, toolCall := range msg.ToolCalls {
					toolCallContent := serverStyle.Render("Tool Call: ") + toolCall.Function.Name + " - " + toolCall.Function.Arguments
					contents = append(contents, toolCallContent)
				}
			}
		}

		return &Message{
			contents: contents,
		}
	case events.EventTypeStepStarted:
		stepEvent, ok := event.(*events.StepStartedEvent)
		if !ok {
			return nil
		}
		content := fmt.Sprintf("Step started: %s", stepEvent.StepName)
		return &Message{
			contents: []string{content},
		}

	case events.EventTypeStepFinished:
		stepEvent, ok := event.(*events.StepFinishedEvent)
		if !ok {
			return nil
		}
		content := fmt.Sprintf("Step finished: %s", stepEvent.StepName)
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeThinkingStart:
		thinkingEvent, ok := event.(*events.ThinkingStartEvent)
		if !ok {
			return nil
		}
		content := "Thinking started"
		if thinkingEvent.Title != nil {
			content = fmt.Sprintf("Thinking started: %s", *thinkingEvent.Title)
		}
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeThinkingEnd:
		_, ok := event.(*events.ThinkingEndEvent)
		if !ok {
			return nil
		}
		content := "Thinking ended"
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeThinkingTextMessageStart:
		_, ok := event.(*events.ThinkingTextMessageStartEvent)
		if !ok {
			return nil
		}
		content := "Thinking message started"
		return &Message{
			contents: []string{content},
		}
	case events.EventTypeThinkingTextMessageContent:
		msg, ok := event.(*events.ThinkingTextMessageContentEvent)
		if !ok {
			return nil
		}
		return &Message{
			contents: []string{msg.Delta},
		}

	case events.EventTypeThinkingTextMessageEnd:
		_, ok := event.(*events.ThinkingTextMessageEndEvent)
		if !ok {
			return nil
		}
		content := "Thinking message ended"
		return &Message{
			contents: []string{content},
		}

	case events.EventTypeCustom:
		evt, ok := event.(*events.CustomEvent)
		if !ok {
			return nil
		}
		jsonData, err := json.Marshal(evt.Value)
		if err != nil {
			fmt.Println("Error marshaling JSON:", err)
			return nil
		}
		fmt.Println(evt)
		return &Message{
			contents: []string{string(jsonData)},
		}

	case events.EventTypeRaw:
		rawEvent, ok := event.(*events.RawEvent)
		if !ok {
			return nil
		}
		jsonData, err := json.Marshal(rawEvent.Event)
		if err != nil {
			fmt.Println("Error marshaling raw event:", err)
			return nil
		}
		return &Message{
			contents: []string{string(jsonData)},
		}

	default:
		// For any other event types, return nil
		fmt.Printf("Unhandled event type: %s\n", eventType)
		return nil
	}
}
