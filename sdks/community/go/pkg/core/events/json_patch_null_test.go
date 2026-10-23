package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestJSONPatchNullValueSurvivesEncoding guards RFC 6902 add/replace/test with
// a null value. omitempty used to drop "value" entirely, turning a legitimate
// "set this key to null" into a malformed operation, and Validate rejected a
// nil Value, so the patch could be neither produced nor accepted.
func TestJSONPatchNullValueSurvivesEncoding(t *testing.T) {
	payload := `{"type":"STATE_DELTA","delta":[{"op":"add","path":"/cleared","value":null},{"op":"replace","path":"/a","value":null},{"op":"test","path":"/b","value":null}]}`

	event, err := EventFromJSON([]byte(payload))
	require.NoError(t, err)
	assert.NoError(t, event.Validate())

	data, err := event.ToJSON()
	require.NoError(t, err)
	var decoded struct {
		Delta []map[string]any `json:"delta"`
	}
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.Len(t, decoded.Delta, 3)
	for _, op := range decoded.Delta {
		value, present := op["value"]
		assert.True(t, present, "value dropped from %v in %s", op["op"], data)
		assert.Nil(t, value)
	}
}

// TestJSONPatchValueOmittedWhereNotDefined keeps remove/move/copy free of a
// value key, which RFC 6902 does not define for them.
func TestJSONPatchValueOmittedWhereNotDefined(t *testing.T) {
	data, err := json.Marshal([]JSONPatchOperation{
		{Op: "remove", Path: "/a"},
		{Op: "move", Path: "/b", From: "/a"},
		{Op: "copy", Path: "/c", From: "/b"},
		{Op: "add", Path: "/d", Value: 1},
	})
	require.NoError(t, err)
	assert.JSONEq(t, `[{"op":"remove","path":"/a"},{"op":"move","path":"/b","from":"/a"},{"op":"copy","path":"/c","from":"/b"},{"op":"add","path":"/d","value":1}]`, string(data))
}
