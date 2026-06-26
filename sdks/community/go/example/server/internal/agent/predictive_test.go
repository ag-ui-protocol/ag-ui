package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/schema"
	jsonpatch "github.com/evanphx/json-patch"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

func runPredictive(t *testing.T, cm *scriptedModel, in *aguitypes.RunAgentInput) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	deps := &Deps{
		Model: cm, BaseModel: cm, Tools: tools,
		Store: runstore.New(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MaxIterations: 8,
	}
	PredictiveState{Deps: deps}.Run(context.Background(), emit, in, in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

func TestPredictiveState_PredictThenCommit(t *testing.T) {
	// The steps generation streams over several text chunks.
	m := &scriptedModel{turns: [][]*schema.Message{{
		textChunk("Boil the pasta.\n"),
		textChunk("Mince the garlic.\n"),
		textChunk("Combine and serve."),
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Rewrite the steps."}},
		State:    seededRecipeState(),
	}
	out := runPredictive(t, m, in)

	// Predictive deltas under /_predictive (multiple, as the draft grows).
	if c := strings.Count(out, `"path":"/_predictive"`); c < 2 {
		t.Errorf("expected multiple predictive /_predictive deltas, got %d:\n%s", c, out)
	}
	// A committed delta on the real path, and the draft cleared.
	if !strings.Contains(out, `"path":"/recipe/steps"`) {
		t.Errorf("expected a committed /recipe/steps delta:\n%s", out)
	}
	if !strings.Contains(out, `"op":"remove","path":"/_predictive"`) {
		t.Errorf("expected the predictive draft to be cleared:\n%s", out)
	}
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) || strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("expected a clean finish:\n%s", out)
	}
}

// TestPredictiveState_DropPredictionsInvariant proves that a client which ignores
// every /_predictive delta still reaches the correct committed state: applying only
// the committed (non-/_predictive) deltas to the initial snapshot yields the final
// steps.
func TestPredictiveState_DropPredictionsInvariant(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{
		textChunk("Boil the pasta.\n"),
		textChunk("Mince the garlic.\n"),
		textChunk("Combine and serve."),
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Rewrite the steps."}},
		State:    seededRecipeState(),
	}
	out := runPredictive(t, m, in)

	snapshot := firstSnapshot(t, out)
	committed := committedDeltas(t, out) // excludes everything under /_predictive

	doc, _ := json.Marshal(snapshot)
	for _, ops := range committed {
		patchJSON, _ := json.Marshal(ops)
		patch, err := jsonpatch.DecodePatch(patchJSON)
		if err != nil {
			t.Fatalf("decode committed patch: %v", err)
		}
		doc, err = patch.Apply(doc)
		if err != nil {
			t.Fatalf("apply committed patch %s: %v", patchJSON, err)
		}
	}
	var final map[string]any
	if err := json.Unmarshal(doc, &final); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	recipe := final["recipe"].(map[string]any)
	steps, _ := recipe["steps"].([]any)
	if len(steps) != 3 || steps[0] != "Boil the pasta." || steps[2] != "Combine and serve." {
		t.Errorf("dropping predictions must still yield the committed steps; got %#v", recipe["steps"])
	}
	// And no leftover /_predictive in the committed-only view.
	if _, leftover := final["_predictive"]; leftover {
		t.Errorf("committed-only state must not contain /_predictive: %#v", final)
	}
}

// --- SSE parsing helpers (parse the data: lines into events) ---

func sseData(t *testing.T, out string) []map[string]any {
	t.Helper()
	var evs []map[string]any
	for _, line := range strings.Split(out, "\n") {
		rest, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var ev map[string]any
		if json.Unmarshal([]byte(rest), &ev) == nil {
			evs = append(evs, ev)
		}
	}
	return evs
}

func firstSnapshot(t *testing.T, out string) map[string]any {
	t.Helper()
	for _, ev := range sseData(t, out) {
		if ev["type"] == "STATE_SNAPSHOT" {
			return ev["snapshot"].(map[string]any)
		}
	}
	t.Fatal("no STATE_SNAPSHOT found")
	return nil
}

// committedDeltas returns the JSON-patch op lists of every STATE_DELTA whose ops
// do NOT touch the /_predictive namespace (i.e. the committed deltas only).
func committedDeltas(t *testing.T, out string) [][]events.JSONPatchOperation {
	t.Helper()
	var committed [][]events.JSONPatchOperation
	for _, ev := range sseData(t, out) {
		if ev["type"] != "STATE_DELTA" {
			continue
		}
		raw, _ := json.Marshal(ev["delta"])
		var ops []events.JSONPatchOperation
		if json.Unmarshal(raw, &ops) != nil {
			continue
		}
		predictive := false
		for _, op := range ops {
			if strings.HasPrefix(op.Path, predictiveDraftPath) {
				predictive = true
				break
			}
		}
		if !predictive {
			committed = append(committed, ops)
		}
	}
	return committed
}
