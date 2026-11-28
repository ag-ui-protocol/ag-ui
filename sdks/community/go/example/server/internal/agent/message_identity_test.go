package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/wireclone"
	"strings"
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

func TestCloneWireMessagesKeepsCallerIdentityAndAssignsMissingIDOnce(t *testing.T) {
	in := []aguitypes.Message{
		{ID: "caller-user", Role: aguitypes.RoleUser, Content: "one"},
		{Role: aguitypes.RoleTool, Content: "result", ToolCallID: "call-1"},
	}
	first := wireclone.Messages(in)
	if first[0].ID != "caller-user" || first[1].ID == "" {
		t.Fatalf("unexpected cloned IDs: %#v", first)
	}
	second := wireclone.Messages(first)
	if second[1].ID != first[1].ID {
		t.Fatalf("assigned ID changed across a later turn: %q -> %q", first[1].ID, second[1].ID)
	}
}

func TestCloneWireMessagesDeepCopiesMultimodalContent(t *testing.T) {
	source := &aguitypes.InputContentSource{Type: "data", Value: "original"}
	metadata := map[string]any{"nested": []any{map[string]any{"value": "original"}}}
	in := []aguitypes.Message{{Role: aguitypes.RoleUser, Content: []aguitypes.InputContent{{Type: "image", Source: source, Metadata: metadata}}}}
	got := wireclone.Messages(in)
	source.Value = "mutated"
	metadata["nested"].([]any)[0].(map[string]any)["value"] = "mutated"
	part := got[0].Content.([]aguitypes.InputContent)[0]
	if part.Source.Value != "original" || part.Metadata.(map[string]any)["nested"].([]any)[0].(map[string]any)["value"] != "original" {
		t.Fatalf("clone aliases multimodal source or metadata: %#v", part)
	}
}

func TestStreamTurnWireIdentityPreservesInterleavedSpansAndToolOwner(t *testing.T) {
	idx := 0
	fm := &fakeModel{chunks: []*schema.Message{
		{Role: schema.Assistant, Content: "first"},
		{Role: schema.Assistant, ReasoningContent: "think"},
		{Role: schema.Assistant, Content: "second"},
		{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{Index: &idx, ID: "call-1", Function: schema.FunctionCall{Name: "calculate", Arguments: `{}`}}}},
	}}
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), "thread", "run", nil)
	turn, err := streamTurn(context.Background(), emit, fm, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Flush()
	if len(turn.WireMessages) != 4 {
		t.Fatalf("wire messages = %#v", turn.WireMessages)
	}
	wantRoles := []aguitypes.Role{aguitypes.RoleAssistant, aguitypes.RoleReasoning, aguitypes.RoleAssistant, aguitypes.RoleAssistant}
	seen := map[string]bool{}
	for i, msg := range turn.WireMessages {
		if msg.Role != wantRoles[i] || msg.ID == "" || seen[msg.ID] {
			t.Fatalf("message %d lost ordered distinct identity: %#v", i, msg)
		}
		seen[msg.ID] = true
	}
	owner := turn.WireMessages[3]
	if owner.ID != turn.ToolOwnerID || len(owner.ToolCalls) != 1 || owner.ToolCalls[0].ID != "call-1" {
		t.Fatalf("tool owner mismatch: %#v", owner)
	}
	if !strings.Contains(buf.String(), `"parentMessageId":"`+owner.ID+`"`) {
		t.Fatalf("TOOL_CALL_START did not reference owner %q:\n%s", owner.ID, buf.String())
	}
}

func TestRunKeepsCallerIDsAcrossTwoToolTurnsAndLaterUserTurn(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call-1", "file_read", `{"path":"missing-one"}`)},
		{toolCallChunk("call-2", "file_read", `{"path":"missing-two"}`)},
		{textChunk("finished")},
	}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "thread", RunID: "run",
		Messages: []aguitypes.Message{
			{ID: "user-original", Role: aguitypes.RoleUser, Content: "start"},
			{ID: "assistant-earlier", Role: aguitypes.RoleAssistant, Content: "ready"},
			{ID: "user-later", Role: aguitypes.RoleUser, Content: "continue"},
		},
	}
	out := runWithModel(t, m, in, runstore.New(), true, 8)
	snapshot := finalSnapshot(t, out)
	byID := map[string]aguitypes.Message{}
	owners, results := map[string]int{}, map[string]int{}
	for _, msg := range snapshot {
		byID[msg.ID] = msg
		for _, call := range msg.ToolCalls {
			owners[call.ID]++
		}
		if msg.Role == aguitypes.RoleTool {
			results[msg.ToolCallID]++
		}
	}
	for _, stableID := range []string{"user-original", "assistant-earlier", "user-later"} {
		if _, ok := byID[stableID]; !ok {
			t.Errorf("snapshot lost caller identity %q: %#v", stableID, snapshot)
		}
	}
	for _, callID := range []string{"call-1", "call-2"} {
		if owners[callID] != 1 || results[callID] != 1 {
			t.Errorf("%s owners=%d results=%d", callID, owners[callID], results[callID])
		}
	}
}

func TestDuplicateToolCallIDAcrossStreamIndexesHasOneProposalOwnerAndResult(t *testing.T) {
	zero, one := 0, 1
	m := &scriptedModel{turns: [][]*schema.Message{{
		{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{Index: &zero, ID: "duplicate", Function: schema.FunctionCall{Name: "file_read", Arguments: `{"path":"first"}`}}}},
		{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{Index: &one, ID: "duplicate", Function: schema.FunctionCall{Name: "file_read", Arguments: `{"path":"second"}`}}}},
	}, {textChunk("finished")}}}
	in := &aguitypes.RunAgentInput{ThreadID: "thread", RunID: "run"}
	out := runWithModel(t, m, in, runstore.New(), true, 4)
	frames := decodeSSEFrames(t, out)
	starts, results := 0, 0
	for _, frame := range frames {
		if frame["type"] == "TOOL_CALL_START" && frame["toolCallId"] == "duplicate" {
			starts++
		}
		if frame["type"] == "TOOL_CALL_RESULT" && frame["toolCallId"] == "duplicate" {
			results++
		}
	}
	snapshot := finalSnapshot(t, out)
	owners, snapshotResults := 0, 0
	for _, msg := range snapshot {
		for _, call := range msg.ToolCalls {
			if call.ID == "duplicate" {
				owners++
			}
		}
		if msg.Role == aguitypes.RoleTool && msg.ToolCallID == "duplicate" {
			snapshotResults++
		}
	}
	if starts != 1 || results != 1 || owners != 1 || snapshotResults != 1 {
		t.Fatalf("duplicate correlation: starts=%d results=%d owners=%d snapshotResults=%d\n%s", starts, results, owners, snapshotResults, out)
	}
}

func TestMalformedToolCallsHaveExactSnapshotRelationships(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		call                  schema.ToolCall
		wantOwner, wantResult int
	}{
		{"missing id", schema.ToolCall{Function: schema.FunctionCall{Name: "file_read", Arguments: `{}`}}, 0, 0},
		{"missing name", schema.ToolCall{ID: "bad", Function: schema.FunctionCall{Arguments: `{}`}}, 1, 1},
		{"invalid json", schema.ToolCall{ID: "bad", Function: schema.FunctionCall{Name: "file_read", Arguments: `{`}}, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &scriptedModel{turns: [][]*schema.Message{{{Role: schema.Assistant, ToolCalls: []schema.ToolCall{tc.call}}}, {textChunk("recovered")}}}
			out := runWithModel(t, m, &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}, runstore.New(), true, 4)
			owners, results := 0, 0
			for _, msg := range finalSnapshot(t, out) {
				if msg.Role == aguitypes.RoleAssistant && msg.Content == nil && len(msg.ToolCalls) == 0 {
					t.Fatalf("empty ghost assistant after invalid call: %#v", msg)
				}
				owners += len(msg.ToolCalls)
				if msg.Role == aguitypes.RoleTool {
					results++
				}
			}
			if owners != tc.wantOwner || results != tc.wantResult {
				t.Fatalf("owners=%d results=%d\n%s", owners, results, out)
			}
		})
	}
}

func TestMixedValidAndMalformedToolTurnOnlyProposesValidCall(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{{Role: schema.Assistant, ToolCalls: []schema.ToolCall{
		{ID: "valid", Function: schema.FunctionCall{Name: "file_read", Arguments: `{"path":"missing"}`}},
		{ID: "malformed", Function: schema.FunctionCall{Name: "file_read", Arguments: `{`}},
	}}}, {textChunk("recovered")}}}
	out := runWithModel(t, m, &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}, runstore.New(), true, 4)
	starts := 0
	for _, frame := range decodeSSEFrames(t, out) {
		if frame["type"] == "TOOL_CALL_START" {
			starts++
		}
	}
	owners, results := map[string]int{}, map[string]int{}
	for _, msg := range finalSnapshot(t, out) {
		for _, call := range msg.ToolCalls {
			owners[call.ID]++
		}
		if msg.Role == aguitypes.RoleTool {
			results[msg.ToolCallID]++
		}
	}
	if starts != 1 || owners["valid"] != 1 || owners["malformed"] != 1 || results["valid"] != 1 || results["malformed"] != 1 {
		t.Fatalf("mixed turn starts=%d owners=%v results=%v\n%s", starts, owners, results, out)
	}
}

func TestInterruptResumePreservesPausedHistoryAndAddsOneResult(t *testing.T) {
	store := runstore.New()
	m := &scriptedModel{turns: [][]*schema.Message{{toolCallChunk("pending", "file_read", `{"path":"missing"}`)}, {textChunk("finished")}}}
	firstInput := &aguitypes.RunAgentInput{ThreadID: "thread", RunID: "run", Messages: []aguitypes.Message{{ID: "caller-user", Role: aguitypes.RoleUser, Content: "read"}}}
	first := finalSnapshot(t, runWithModel(t, m, firstInput, store, false, 4))
	ownerID := ""
	for _, msg := range first {
		for _, call := range msg.ToolCalls {
			if call.ID == "pending" {
				ownerID = msg.ID
			}
		}
	}
	if ownerID == "" {
		t.Fatalf("paused snapshot has no owner: %#v", first)
	}

	resume := &aguitypes.RunAgentInput{ThreadID: "thread", RunID: "run", Resume: []aguitypes.ResumeEntry{{InterruptID: "pending", Status: aguitypes.ResumeStatusResolved, Payload: map[string]any{"approved": true}}}}
	second := finalSnapshot(t, runWithModel(t, m, resume, store, false, 4))
	owners, results := 0, 0
	foundCaller := false
	for _, msg := range second {
		if msg.ID == "caller-user" {
			foundCaller = true
		}
		for _, call := range msg.ToolCalls {
			if call.ID == "pending" {
				owners++
				if msg.ID != ownerID {
					t.Errorf("owner ID changed %q -> %q", ownerID, msg.ID)
				}
			}
		}
		if msg.Role == aguitypes.RoleTool && msg.ToolCallID == "pending" {
			results++
		}
	}
	if !foundCaller || owners != 1 || results != 1 {
		t.Fatalf("resume history caller=%v owners=%d results=%d: %#v", foundCaller, owners, results, second)
	}
}

func decodeSSEFrames(t *testing.T, raw string) []map[string]any {
	t.Helper()
	var frames []map[string]any
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame); err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func finalSnapshot(t *testing.T, raw string) []aguitypes.Message {
	t.Helper()
	frames := decodeSSEFrames(t, raw)
	for i := len(frames) - 1; i >= 0; i-- {
		if frames[i]["type"] == "MESSAGES_SNAPSHOT" {
			encoded, _ := json.Marshal(frames[i]["messages"])
			var messages []aguitypes.Message
			if err := json.Unmarshal(encoded, &messages); err != nil {
				t.Fatal(err)
			}
			return messages
		}
	}
	t.Fatalf("no snapshot in stream: %s", raw)
	return nil
}
