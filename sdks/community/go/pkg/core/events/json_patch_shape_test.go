package events

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSpecValidPatchesPassValidation guards two RFC 6902 shapes the spec lists
// as valid that Validate used to reject: an empty patch (a no-op) and an
// operation whose path is "", the RFC 6901 pointer to the whole document.
func TestSpecValidPatchesPassValidation(t *testing.T) {
	for _, payload := range []string{
		`{"type":"STATE_DELTA","delta":[]}`,
		`{"type":"STATE_DELTA","delta":[{"op":"replace","path":"","value":{}}]}`,
		`{"type":"ACTIVITY_DELTA","messageId":"a1","activityType":"search","patch":[]}`,
		`{"type":"ACTIVITY_DELTA","messageId":"a1","activityType":"search","patch":[{"op":"replace","path":"","value":{"q":1}}]}`,
	} {
		event, err := EventFromJSON([]byte(payload))
		require.NoError(t, err, payload)
		assert.NoError(t, event.Validate(), payload)
	}
}

// TestMissingPatchStillRejected keeps the required delta/patch key required:
// a nil slice would be written as null, which is not a JSON Patch.
func TestMissingPatchStillRejected(t *testing.T) {
	for _, payload := range []string{
		`{"type":"STATE_DELTA"}`,
		`{"type":"ACTIVITY_DELTA","messageId":"a1","activityType":"search"}`,
	} {
		event, err := EventFromJSON([]byte(payload))
		require.NoError(t, err, payload)
		assert.Error(t, event.Validate(), payload)
	}
}
