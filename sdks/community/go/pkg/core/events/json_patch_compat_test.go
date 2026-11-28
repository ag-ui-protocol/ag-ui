package events_test

import (
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/stretchr/testify/require"
)

func TestJSONPatchPositionalLiteralCompatibility(t *testing.T) {
	// Keep the exported struct's original four-field layout available to users.
	operation := events.JSONPatchOperation{"replace", "/x", map[string]any{}, ""}
	require.NoError(t, events.NewStateDeltaEvent([]events.JSONPatchOperation{operation}).Validate())
	require.NoError(t, events.NewActivityDeltaEvent("m", "a", []events.JSONPatchOperation{operation}).Validate())
}
