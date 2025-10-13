package events

import (
	"encoding/json"
	"testing"

	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEventDecoder(t *testing.T) {
	t.Run("NewEventDecoder", func(t *testing.T) {
		// With nil logger
		decoder := NewEventDecoder(nil)
		assert.NotNil(t, decoder)
		assert.NotNil(t, decoder.logger)

		// With custom logger
		customLogger := logrus.New()
		decoder = NewEventDecoder(customLogger)
		assert.NotNil(t, decoder)
		assert.Equal(t, customLogger, decoder.logger)
	})

	t.Run("DecodeEvent_RunStarted", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"threadId": "thread-123", "runId": "run-456"}`)

		event, err := decoder.DecodeEvent("RUN_STARTED", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		runEvent, ok := event.(*RunStartedEvent)
		require.True(t, ok)
		assert.Equal(t, "thread-123", runEvent.ThreadIDValue)
		assert.Equal(t, "run-456", runEvent.RunIDValue)
	})

	t.Run("DecodeEvent_RunFinished", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"threadId": "thread-123", "runId": "run-456", "result": "success"}`)

		event, err := decoder.DecodeEvent("RUN_FINISHED", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		runEvent, ok := event.(*RunFinishedEvent)
		require.True(t, ok)
		assert.Equal(t, "thread-123", runEvent.ThreadIDValue)
		assert.Equal(t, "run-456", runEvent.RunIDValue)
	})

	t.Run("DecodeEvent_RunError", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"message": "Error occurred", "code": "ERROR_CODE", "runId": "run-456"}`)

		event, err := decoder.DecodeEvent("RUN_ERROR", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		runError, ok := event.(*RunErrorEvent)
		require.True(t, ok)
		assert.Equal(t, "Error occurred", runError.Message)
		assert.Equal(t, "ERROR_CODE", *runError.Code)
		assert.Equal(t, "run-456", runError.RunIDValue)
	})

	t.Run("DecodeEvent_TextMessageStart", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"messageId": "msg-123", "role": "user"}`)

		event, err := decoder.DecodeEvent("TEXT_MESSAGE_START", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		msgEvent, ok := event.(*TextMessageStartEvent)
		require.True(t, ok)
		assert.Equal(t, "msg-123", msgEvent.MessageID)
		assert.Equal(t, "user", *msgEvent.Role)
	})

	t.Run("DecodeEvent_TextMessageContent", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"messageId": "msg-123", "delta": "Hello World"}`)

		event, err := decoder.DecodeEvent("TEXT_MESSAGE_CONTENT", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		msgEvent, ok := event.(*TextMessageContentEvent)
		require.True(t, ok)
		assert.Equal(t, "msg-123", msgEvent.MessageID)
		assert.Equal(t, "Hello World", msgEvent.Delta)
	})

	t.Run("DecodeEvent_TextMessageEnd", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"messageId": "msg-123"}`)

		event, err := decoder.DecodeEvent("TEXT_MESSAGE_END", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		msgEvent, ok := event.(*TextMessageEndEvent)
		require.True(t, ok)
		assert.Equal(t, "msg-123", msgEvent.MessageID)
	})

	t.Run("DecodeEvent_ToolCallStart", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"toolCallId": "tool-123", "toolCallName": "get_weather", "parentMessageId": "msg-456"}`)

		event, err := decoder.DecodeEvent("TOOL_CALL_START", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		toolEvent, ok := event.(*ToolCallStartEvent)
		require.True(t, ok)
		assert.Equal(t, "tool-123", toolEvent.ToolCallID)
		assert.Equal(t, "get_weather", toolEvent.ToolCallName)
		assert.Equal(t, "msg-456", *toolEvent.ParentMessageID)
	})

	t.Run("DecodeEvent_ToolCallArgs", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"toolCallId": "tool-123", "delta": "{\"location\": \"SF\"}"}`)

		event, err := decoder.DecodeEvent("TOOL_CALL_ARGS", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		toolEvent, ok := event.(*ToolCallArgsEvent)
		require.True(t, ok)
		assert.Equal(t, "tool-123", toolEvent.ToolCallID)
		assert.Equal(t, `{"location": "SF"}`, toolEvent.Delta)
	})

	t.Run("DecodeEvent_ToolCallEnd", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"toolCallId": "tool-123"}`)

		event, err := decoder.DecodeEvent("TOOL_CALL_END", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		toolEvent, ok := event.(*ToolCallEndEvent)
		require.True(t, ok)
		assert.Equal(t, "tool-123", toolEvent.ToolCallID)
	})

	t.Run("DecodeEvent_ToolCallResult", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"messageId": "msg-123", "toolCallId": "tool-123", "content": "Sunny, 72°F", "role": "tool"}`)

		event, err := decoder.DecodeEvent("TOOL_CALL_RESULT", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		resultEvent, ok := event.(*ToolCallResultEvent)
		require.True(t, ok)
		assert.Equal(t, "msg-123", resultEvent.MessageID)
		assert.Equal(t, "tool-123", resultEvent.ToolCallID)
		assert.Equal(t, "Sunny, 72°F", resultEvent.Content)
	})

	t.Run("DecodeEvent_StateSnapshot", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"snapshot": {"counter": 42, "status": "active"}}`)

		event, err := decoder.DecodeEvent("STATE_SNAPSHOT", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		stateEvent, ok := event.(*StateSnapshotEvent)
		require.True(t, ok)
		assert.NotNil(t, stateEvent.Snapshot)
	})

	t.Run("DecodeEvent_StateDelta", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"delta": [{"op": "add", "path": "/counter", "value": 42}]}`)

		event, err := decoder.DecodeEvent("STATE_DELTA", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		deltaEvent, ok := event.(*StateDeltaEvent)
		require.True(t, ok)
		assert.Len(t, deltaEvent.Delta, 1)
		assert.Equal(t, "add", deltaEvent.Delta[0].Op)
	})

	t.Run("DecodeEvent_MessagesSnapshot", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"messages": [{"id": "msg-1", "role": "user", "content": "Hello"}]}`)

		event, err := decoder.DecodeEvent("MESSAGES_SNAPSHOT", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		msgEvent, ok := event.(*MessagesSnapshotEvent)
		require.True(t, ok)
		assert.Len(t, msgEvent.Messages, 1)
		assert.Equal(t, "msg-1", msgEvent.Messages[0].ID)
	})

	t.Run("DecodeEvent_StepStarted", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"stepName": "step-1"}`)

		event, err := decoder.DecodeEvent("STEP_STARTED", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		stepEvent, ok := event.(*StepStartedEvent)
		require.True(t, ok)
		assert.Equal(t, "step-1", stepEvent.StepName)
	})

	t.Run("DecodeEvent_StepFinished", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"stepName": "step-1"}`)

		event, err := decoder.DecodeEvent("STEP_FINISHED", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		stepEvent, ok := event.(*StepFinishedEvent)
		require.True(t, ok)
		assert.Equal(t, "step-1", stepEvent.StepName)
	})

	t.Run("DecodeEvent_ThinkingEvents", func(t *testing.T) {
		decoder := NewEventDecoder(nil)

		// ThinkingStart
		data := []byte(`{"title": "Processing"}`)
		event, err := decoder.DecodeEvent("THINKING_START", data)
		require.NoError(t, err)
		thinkStart, ok := event.(*ThinkingStartEvent)
		require.True(t, ok)
		assert.Equal(t, "Processing", *thinkStart.Title)

		// ThinkingEnd
		data = []byte(`{}`)
		event, err = decoder.DecodeEvent("THINKING_END", data)
		require.NoError(t, err)
		_, ok = event.(*ThinkingEndEvent)
		require.True(t, ok)

		// ThinkingTextMessageStart
		event, err = decoder.DecodeEvent("THINKING_TEXT_MESSAGE_START", data)
		require.NoError(t, err)
		_, ok = event.(*ThinkingTextMessageStartEvent)
		require.True(t, ok)

		// ThinkingTextMessageContent
		data = []byte(`{"delta": "Thinking..."}`)
		event, err = decoder.DecodeEvent("THINKING_TEXT_MESSAGE_CONTENT", data)
		require.NoError(t, err)
		thinkContent, ok := event.(*ThinkingTextMessageContentEvent)
		require.True(t, ok)
		assert.Equal(t, "Thinking...", thinkContent.Delta)

		// ThinkingTextMessageEnd
		data = []byte(`{}`)
		event, err = decoder.DecodeEvent("THINKING_TEXT_MESSAGE_END", data)
		require.NoError(t, err)
		_, ok = event.(*ThinkingTextMessageEndEvent)
		require.True(t, ok)
	})

	t.Run("DecodeEvent_CustomEvent", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"name": "custom-event", "value": {"key": "value"}}`)

		event, err := decoder.DecodeEvent("CUSTOM", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		customEvent, ok := event.(*CustomEvent)
		require.True(t, ok)
		assert.Equal(t, "custom-event", customEvent.Name)
	})

	t.Run("DecodeEvent_RawEvent", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"event": {"custom": "data"}, "source": "external"}`)

		event, err := decoder.DecodeEvent("RAW", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		rawEvent, ok := event.(*RawEvent)
		require.True(t, ok)
		assert.Equal(t, "external", *rawEvent.Source)
	})

	t.Run("DecodeEvent_UnknownEventType", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"some": "data"}`)

		event, err := decoder.DecodeEvent("UNKNOWN_EVENT", data)
		assert.Error(t, err)
		assert.Nil(t, event)
		assert.Contains(t, err.Error(), "unknown event type")
	})

	t.Run("DecodeEvent_InvalidJSON", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{invalid json}`)

		event, err := decoder.DecodeEvent("RUN_STARTED", data)
		assert.Error(t, err)
		assert.Nil(t, event)
	})

	t.Run("DecodeEvent_UnknownButValidEventType", func(t *testing.T) {
		decoder := NewEventDecoder(nil)
		data := []byte(`{"some": "data"}`)

		// This should fall through to the default case and return a RawEvent
		event, err := decoder.DecodeEvent("TEXT_MESSAGE_CHUNK", data)
		require.NoError(t, err)
		require.NotNil(t, event)

		rawEvent, ok := event.(*RawEvent)
		require.True(t, ok)
		assert.Equal(t, EventType("TEXT_MESSAGE_CHUNK"), rawEvent.EventType)
		assert.Equal(t, "TEXT_MESSAGE_CHUNK", *rawEvent.Source)
		assert.Equal(t, json.RawMessage(data), rawEvent.Event)
	})
}