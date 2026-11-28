package agent

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/schema"
)

// A provider cannot rename an indexed call after its first chunk. Eino rejects
// the merged turn; Run must not re-propose or execute that malformed call.
func TestRunRejectsMidIndexToolRenameWithoutDuplicateProposal(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		name := "post-turn"
		if streaming {
			name = "streaming"
		}
		t.Run(name, func(t *testing.T) {
			index := 0
			m := &scriptedModel{turns: [][]*schema.Message{{
				{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{Index: &index, ID: "call-1", Function: schema.FunctionCall{Name: "original", Arguments: "{"}}}},
				{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{Index: &index, Function: schema.FunctionCall{Name: "renamed", Arguments: "}"}}}},
			}}}
			var buf bytes.Buffer
			w := bufio.NewWriter(&buf)
			emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), "thread", "run", nil)
			// Nil Tools is intentional: malformed calls must never reach execution.
			deps := &Deps{Model: m, AutoApprove: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			Run(context.Background(), emit, &aguitypes.RunAgentInput{}, deps, RunConfig{StreamToolCalls: streaming}, "thread", "run")
			_ = w.Flush()
			counts := map[string]int{}
			frames := decodeSSEFrames(t, buf.String())
			for _, frame := range frames {
				kind := frame["type"].(string)
				counts[kind]++
				if kind == "TOOL_CALL_START" && (frame["toolCallId"] != "call-1" || frame["toolCallName"] != "original") {
					t.Fatalf("unexpected proposal: %#v", frame)
				}
			}
			wantCalls := 0
			if streaming {
				wantCalls = 1
			}
			if counts["TOOL_CALL_START"] != wantCalls || counts["TOOL_CALL_END"] != wantCalls || counts["RUN_ERROR"] != 1 || counts["RUN_FINISHED"] != 0 || counts["TOOL_CALL_RESULT"] != 0 || counts["MESSAGES_SNAPSHOT"] != 0 {
				t.Fatalf("unexpected event counts: %v\n%s", counts, buf.String())
			}
			if frames[len(frames)-1]["type"] != "RUN_ERROR" {
				t.Fatalf("error was not terminal: %s", buf.String())
			}
		})
	}
}
