package json

import (
	"context"
	stdjson "encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
)

// TestJSONDecoderDecodesEveryProtocolEventType guards against createEvent
// falling behind the event package: every type the SDK defines must decode to
// its own struct, not fail as "unknown event type". The table is checked against
// the event registry so adding a modeled event also requires a decoder test.
func TestJSONDecoderDecodesEveryProtocolEventType(t *testing.T) {
	cases := []struct {
		payload string
		want    events.Event
	}{
		{`{"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}`, &events.TextMessageStartEvent{}},
		{`{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hello"}`, &events.TextMessageContentEvent{}},
		{`{"type":"TEXT_MESSAGE_END","messageId":"m1"}`, &events.TextMessageEndEvent{}},
		{`{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1"}`, &events.TextMessageChunkEvent{}},
		{`{"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"search"}`, &events.ToolCallStartEvent{}},
		{`{"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"{\"q\":"}`, &events.ToolCallArgsEvent{}},
		{`{"type":"TOOL_CALL_END","toolCallId":"c1"}`, &events.ToolCallEndEvent{}},
		{`{"type":"STATE_SNAPSHOT","snapshot":{"step":1}}`, &events.StateSnapshotEvent{}},
		{`{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/step","value":2}]}`, &events.StateDeltaEvent{}},
		{`{"type":"MESSAGES_SNAPSHOT","messages":[]}`, &events.MessagesSnapshotEvent{}},
		{`{"type":"RAW","event":{"kind":"provider.chunk"}}`, &events.RawEvent{}},
		{`{"type":"CUSTOM","name":"app.progress","value":0.5}`, &events.CustomEvent{}},
		{`{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}`, &events.RunStartedEvent{}},
		{`{"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}`, &events.RunFinishedEvent{}},
		{`{"type":"RUN_ERROR","message":"upstream refused the request"}`, &events.RunErrorEvent{}},
		{`{"type":"STEP_STARTED","stepName":"plan"}`, &events.StepStartedEvent{}},
		{`{"type":"STEP_FINISHED","stepName":"plan"}`, &events.StepFinishedEvent{}},
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

	// The registry is intentionally private. Read its declaration instead of
	// adding a public API solely for this test or maintaining a second count.
	registry := registeredEventTypes(t)
	seen := make(map[string]bool)
	decoder := NewJSONDecoder(nil)
	for _, tc := range cases {
		var header struct {
			Type string `json:"type"`
		}
		if err := stdjson.Unmarshal([]byte(tc.payload), &header); err != nil {
			t.Fatal(err)
		}
		if seen[header.Type] {
			t.Errorf("duplicate test case for %s", header.Type)
		}
		seen[header.Type] = true
		if !registry[header.Type] {
			t.Errorf("unregistered test case %s", header.Type)
		}
		event, err := decoder.Decode(context.Background(), []byte(tc.payload))
		if err != nil {
			t.Errorf("Decode(%s) failed: %v", tc.payload, err)
			continue
		}
		if reflect.TypeOf(event) != reflect.TypeOf(tc.want) {
			t.Errorf("Decode(%s) = %T, want %T", tc.payload, event, tc.want)
		}
	}
	for eventType := range registry {
		if !seen[eventType] {
			t.Errorf("registered event %s has no decoder test", eventType)
		}
	}
}

// registeredEventTypes reads the actual registry, including future entries.
func registeredEventTypes(t *testing.T) map[string]bool {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "../../core/events/events.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	constants := make(map[string]string)
	ast.Inspect(file, func(node ast.Node) bool {
		spec, ok := node.(*ast.ValueSpec)
		if !ok || len(spec.Names) != 1 || len(spec.Values) != 1 {
			return true
		}
		if literal, ok := spec.Values[0].(*ast.BasicLit); ok && literal.Kind == token.STRING {
			value, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			constants[spec.Names[0].Name] = value
		}
		return true
	})
	registry := make(map[string]bool)
	ast.Inspect(file, func(node ast.Node) bool {
		spec, ok := node.(*ast.ValueSpec)
		if !ok || len(spec.Names) != 1 || spec.Names[0].Name != "validEventTypes" {
			return true
		}
		literal, ok := spec.Values[0].(*ast.CompositeLit)
		if !ok {
			t.Fatal("event registry is not a map literal")
		}
		for _, entry := range literal.Elts {
			pair, ok := entry.(*ast.KeyValueExpr)
			if !ok {
				t.Fatal("unexpected registry entry")
			}
			key, ok := pair.Key.(*ast.Ident)
			if !ok || constants[key.Name] == "" {
				t.Fatal("unrecognized registry key")
			}
			registry[constants[key.Name]] = true
		}
		return false
	})
	if len(registry) == 0 {
		t.Fatal("event registry was not found")
	}
	return registry
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
	if result.MessageID != "m1" || result.ToolCallID != "c1" || result.Content != "42" ||
		result.Role == nil || *result.Role != "tool" {
		t.Errorf("decoded %+v, want messageId m1, toolCallId c1, content 42, and role tool", result)
	}
}

func TestJSONDecoderRejectsMalformedPayloads(t *testing.T) {
	cases := map[string]string{
		"empty": "", "truncated": `{"type":"TOOL_CALL_RESULT"`,
		"missing type": `{"messageId":"m1"}`, "unknown type": `{"type":"FUTURE_EVENT"}`,
		"wrong field type": `{"type":"TOOL_CALL_RESULT","messageId":42,"toolCallId":"c1","content":"42"}`,
		"invalid event":    `{"type":"TOOL_CALL_RESULT","messageId":"m1","content":"42"}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			event, err := NewJSONDecoder(nil).Decode(context.Background(), []byte(payload))
			if err == nil || event != nil {
				t.Fatalf("Decode(%s) = %v, %v; want nil event and error", payload, event, err)
			}
		})
	}
}

func TestJSONDecoderUnknownFieldOptions(t *testing.T) {
	payload := []byte(`{"type":"TOOL_CALL_RESULT","messageId":"m1","toolCallId":"c1","content":"42","extra":true}`)
	for _, tc := range []struct {
		name                            string
		strict, allowUnknown, wantError bool
	}{
		{"strict", true, false, true},
		{"strict allows unknown", true, true, false},
		{"non-strict", false, false, false},
		{"non-strict allows unknown", false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			decoder := NewJSONDecoder(&encoding.DecodingOptions{Strict: tc.strict, AllowUnknownFields: tc.allowUnknown, ValidateEvents: true})
			event, err := decoder.Decode(context.Background(), payload)
			if tc.wantError {
				if err == nil || event != nil || !strings.Contains(err.Error(), "unknown field") {
					t.Fatalf("got %v, %v; want unknown-field error", event, err)
				}
			} else if err != nil || event == nil {
				t.Fatalf("got %v, %v; want decoded event", event, err)
			}
		})
	}
}

func TestJSONDecoderRejectsInvalidBatch(t *testing.T) {
	for _, payload := range []string{
		`[{"type":"TOOL_CALL_RESULT","messageId":"m1","toolCallId":"c1","content":"42"},{"type":"FUTURE_EVENT"}]`,
		`[{"type":"THINKING_START"},{"type":"TOOL_CALL_RESULT","messageId":"m1","content":"42"}]`,
	} {
		decoded, err := NewJSONDecoder(nil).DecodeMultiple(context.Background(), []byte(payload))
		if err == nil || decoded != nil || !strings.Contains(err.Error(), "index 1") {
			t.Fatalf("got %v, %v; want no partial results and error at index 1", decoded, err)
		}
	}
}
