package events

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestEmptyDeltasAreValid guards the spec rule that TEXT_MESSAGE_CONTENT,
// TOOL_CALL_ARGS and REASONING_MESSAGE_CONTENT may carry an empty delta.
// Providers emit empty deltas as keep-alives and while a tool call is being
// decided; Validate rejecting them made EventEncoder.EncodeEvent fail and
// ended runs that were working correctly.
func TestEmptyDeltasAreValid(t *testing.T) {
	for _, payload := range []string{
		`{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":""}`,
		`{"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":""}`,
		`{"type":"REASONING_MESSAGE_CONTENT","messageId":"n1","delta":""}`,
	} {
		event, err := EventFromJSON([]byte(payload))
		require.NoError(t, err, payload)
		assert.NoError(t, event.Validate(), payload)

		// The empty delta must survive re-encoding rather than being dropped.
		data, err := event.ToJSON()
		require.NoError(t, err, payload)
		assert.Contains(t, string(data), `"delta":""`, payload)
	}
}
