package genkit

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/firebase/genkit/go/ai"
)

type ChatStatus int

const (
	Initial ChatStatus = iota
	ChatStarted
	ToolStarted
)

type StreamingFuncType func(ctx context.Context, chunk *ai.ModelResponseChunk) error

func StreamingFunc(threadID string, runID string, eventsCh chan<- events.Event) StreamingFuncType {
	status := Initial
	var currMessageId *string
	var role string
	return func(ctx context.Context, chunk *ai.ModelResponseChunk) error {
		newId := uuid.New().String()
		if currMessageId == nil {
			currMessageId = &newId
		}
		if len(chunk.Content) > 1 {
			return fmt.Errorf("chunk contains more than one chunk")
		}
		content := chunk.Content[0]
		if content == nil {
			return fmt.Errorf("chunk contains no content")
		}
		currText := chunk.Text()
		role = string(chunk.Role)

		if content.ToolRequest != nil {
			if status == ChatStarted {
				eventsCh <- events.NewTextMessageEndEvent(*currMessageId)
			}
			currMessageId = &newId
			status = ToolStarted
			eventsCh <- events.NewToolCallStartEvent(*currMessageId, content.ToolRequest.Name, events.WithParentMessageID(threadID))
			jsonString, err := json.Marshal(content.ToolRequest.Input)
			if err != nil {
				return err
			}
			eventsCh <- events.NewToolCallArgsEvent(*currMessageId, string(jsonString))
			return nil
		}

		if content.ToolResponse != nil {
			if status == ChatStarted {
				eventsCh <- events.NewTextMessageEndEvent(*currMessageId)
			}
			toolName := content.ToolResponse.Name
			bytes, err := json.Marshal(content.ToolResponse.Output)
			if err != nil {
				return err
			}
			eventsCh <- events.NewToolCallResultEvent(*currMessageId, toolName, string(bytes))
			return nil
		}

		if status == ToolStarted && content.ToolRequest == nil && content.ToolResponse == nil {
			status = Initial
		}

		switch status {
		case Initial:
			eventsCh <- events.NewTextMessageStartEvent(*currMessageId)
			status = ChatStarted
			eventsCh <- events.NewTextMessageChunkEvent(currMessageId, &role, &currText)
		case ChatStarted:
			eventsCh <- events.NewTextMessageChunkEvent(currMessageId, &role, &currText)
		}
		return nil
	}
}
