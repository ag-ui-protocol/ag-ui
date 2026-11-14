package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCustomEventAlwaysWritesValue guards CUSTOM's required value key. With
// omitempty a CustomEvent built without WithValue, or with a nil value, was
// written with no value at all, which the TypeScript client's schema
// (value !== undefined) rejects, failing the run.
func TestCustomEventAlwaysWritesValue(t *testing.T) {
	for _, event := range []*CustomEvent{
		NewCustomEvent("app.ping"),
		NewCustomEvent("app.thing", WithValue(nil)),
	} {
		data, err := event.ToJSON()
		require.NoError(t, err)
		var decoded map[string]any
		require.NoError(t, json.Unmarshal(data, &decoded))
		value, present := decoded["value"]
		assert.True(t, present, "value key missing from %s", data)
		assert.Nil(t, value)
	}

	// A non-nil value is written as before.
	data, err := NewCustomEvent("app.count", WithValue(3)).ToJSON()
	require.NoError(t, err)
	assert.Contains(t, string(data), `"value":3`)
}
