package json

import (
	"context"
	"reflect"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// TestJSONDecoderDecodesEveryProtocolEventType guards against createEvent
// falling behind the event package: every type the SDK defines must decode to
// its own struct, not fail as "unknown event type". TOOL_CALL_RESULT, the
// activity, reasoning and subagent events were all rejected by this decoder
// while EventFromJSON accepted them.
func TestJSONDecoderDecodesEveryProtocolEventType(t *testing.T) {
	cases := []struct {
		payload string
		want    events.Event
	}{
		{`{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","delta":"{}"}`, &events.ToolCallChunkEvent{}},
		{`{"type":"TOOL_CALL_RESULT","messageId":"m2","toolCallId":"c1","content":"3 results"}`, &events.ToolCallResultEvent{}},
		{`{"type":"ACTIVITY_SNAPSHOT","messageId":"a1","activityType":"search","content":{"query":"q"}}`, &events.ActivitySnapshotEvent{}},
		{`{"type":"ACTIVITY_DELTA","messageId":"a1","activityType":"search","patch":[{"op":"add","path":"/hits","value":3}]}`, &events.ActivityDeltaEvent{}},
		{`{"type":"THINKING_START"}`, &events.ThinkingStartEvent{}},
		{`{"type":"THINKING_END"}`, &events.ThinkingEndEvent{}},
		{`{"type":"THINKING_TEXT_MESSAGE_START"}`, &events.ThinkingTextMessageStartEvent{}},
		{`{"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"hm"}`, &events.ThinkingTextMessageContentEvent{}},
		{`{"type":"THINKING_TEXT_MESSAGE_END"}`, &events.ThinkingTextMessageEndEvent{}},
		{`{"type":"REASONING_START","messageId":"n1"}`, &events.ReasoningStartEvent{}},
		{`{"type":"REASONING_MESSAGE_START","messageId":"n1","role":"reasoning"}`, &events.ReasoningMessageStartEvent{}},
		{`{"type":"REASONING_MESSAGE_CONTENT","messageId":"n1","delta":"weighing"}`, &events.ReasoningMessageContentEvent{}},
		{`{"type":"REASONING_MESSAGE_END","messageId":"n1"}`, &events.ReasoningMessageEndEvent{}},
		{`{"type":"REASONING_MESSAGE_CHUNK","messageId":"n1","delta":"x"}`, &events.ReasoningMessageChunkEvent{}},
		{`{"type":"REASONING_END","messageId":"n1"}`, &events.ReasoningEndEvent{}},
		{`{"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"n1","encryptedValue":"b64"}`, &events.ReasoningEncryptedValueEvent{}},
		{`{"type":"SUBAGENT_STARTED","subagentRunId":"s1","name":"researcher"}`, &events.SubagentStartedEvent{}},
		{`{"type":"SUBAGENT_FINISHED","subagentRunId":"s1"}`, &events.SubagentFinishedEvent{}},
		{`{"type":"SUBAGENT_ERROR","subagentRunId":"s1","message":"tool unavailable"}`, &events.SubagentErrorEvent{}},
	}

	decoder := NewJSONDecoder(nil)
	for _, tc := range cases {
		event, err := decoder.Decode(context.Background(), []byte(tc.payload))
		if err != nil {
			t.Errorf("Decode(%s) failed: %v", tc.payload, err)
			continue
		}
		if reflect.TypeOf(event) != reflect.TypeOf(tc.want) {
			t.Errorf("Decode(%s) = %T, want %T", tc.payload, event, tc.want)
		}
	}
}

// TestJSONCodecRoundTripsToolCallResult pins the user-visible symptom: a
// TOOL_CALL_RESULT the codec encodes itself could not be decoded by it.
func TestJSONCodecRoundTripsToolCallResult(t *testing.T) {
	codec := NewCodec()
	data, err := codec.Encode(context.Background(), events.NewToolCallResultEvent("m1", "c1", "42"))
	if err != nil {
		t.Fatalf("Encode failed: %v", err)
	}
	decoded, err := codec.Decode(context.Background(), data)
	if err != nil {
		t.Fatalf("Decode(%s) failed: %v", data, err)
	}
	result, ok := decoded.(*events.ToolCallResultEvent)
	if !ok {
		t.Fatalf("Decode returned %T, want *events.ToolCallResultEvent", decoded)
	}
	if result.ToolCallID != "c1" || result.Content != "42" {
		t.Errorf("decoded %+v, want toolCallId c1 and content 42", result)
	}
}
