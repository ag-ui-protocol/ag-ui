package wireclone

import (
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

func TestMessagesPreservesTypedContentAndOwnsNestedValues(t *testing.T) {
	source := &aguitypes.InputContentSource{Type: "data", Value: "original"}
	metadata := map[string]any{"items": []any{map[string]any{"value": "original"}}}
	in := []aguitypes.Message{{Role: aguitypes.RoleUser, Content: []aguitypes.InputContent{{Type: aguitypes.InputContentTypeImage, Source: source, Metadata: metadata}}}}
	got := Messages(in)
	if got[0].ID == "" {
		t.Fatal("missing ID was not assigned")
	}
	parts, ok := got[0].Content.([]aguitypes.InputContent)
	if !ok {
		t.Fatalf("typed content changed to %T", got[0].Content)
	}
	source.Value = "mutated"
	metadata["items"].([]any)[0].(map[string]any)["value"] = "mutated"
	if parts[0].Source.Value != "original" || parts[0].Metadata.(map[string]any)["items"].([]any)[0].(map[string]any)["value"] != "original" {
		t.Fatalf("clone aliases nested values: %#v", parts[0])
	}
}
