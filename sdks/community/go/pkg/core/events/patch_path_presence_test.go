package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPatchPathWirePresence(t *testing.T) {
	for _, container := range []struct {
		name   string
		prefix string
	}{
		{"state", `{"type":"STATE_DELTA","delta":`},
		{"activity", `{"type":"ACTIVITY_DELTA","messageId":"m","activityType":"a","patch":`},
	} {
		for _, path := range []struct {
			name  string
			field string
			valid bool
		}{
			{"missing", "", false},
			{"null", `,"path":null`, false},
			{"number", `,"path":42`, false},
			{"empty", `,"path":""`, true},
			{"member", `,"path":"/x"`, true},
		} {
			t.Run(container.name+"/"+path.name, func(t *testing.T) {
				operation := `{"op":"replace","value":{}` + path.field + `}`
				event, err := EventFromJSON([]byte(container.prefix + "[" + operation + "]}"))
				if err == nil {
					err = event.Validate()
				}
				if !path.valid {
					require.Error(t, err)
					return
				}
				require.NoError(t, err)
				encoded, err := event.ToJSON()
				require.NoError(t, err)
				require.Contains(t, string(encoded), path.field[1:])
			})
		}
	}
}

func TestConstructedRootPatchPathsRemainValid(t *testing.T) {
	patch := []JSONPatchOperation{{Op: "replace", Path: "", Value: map[string]any{}}}
	for _, event := range []Event{
		NewStateDeltaEvent(patch),
		NewActivityDeltaEvent("m", "a", patch),
	} {
		require.NoError(t, event.Validate())
		encoded, err := event.ToJSON()
		require.NoError(t, err)
		decoded, err := EventFromJSON(encoded)
		require.NoError(t, err)
		require.NoError(t, decoded.Validate())
	}
}

func TestPatchPathPresenceResetsWhenDecodingAgain(t *testing.T) {
	var operation JSONPatchOperation
	require.NoError(t, json.Unmarshal([]byte(`{"op":"replace","path":"","value":{}}`), &operation))
	require.NoError(t, validateJSONPatchOperation(operation))
	require.Error(t, json.Unmarshal([]byte(`{"op":"replace","value":{}}`), &operation))
}

func TestPatchValueWirePresence(t *testing.T) {
	for _, container := range []struct {
		name   string
		prefix string
	}{
		{"state", `{"type":"STATE_DELTA","delta":`},
		{"activity", `{"type":"ACTIVITY_DELTA","messageId":"m","activityType":"a","patch":`},
	} {
		for _, op := range []string{"add", "replace", "test"} {
			t.Run(container.name+"/"+op, func(t *testing.T) {
				operation := `[{"op":"` + op + `","path":""`
				_, err := EventFromJSON([]byte(container.prefix + operation + `}]}`))
				require.Error(t, err)
				require.Contains(t, err.Error(), "value field is required")
				event, err := EventFromJSON([]byte(container.prefix + operation + `,"value":null}]}`))
				require.NoError(t, err)
				require.NoError(t, event.Validate())
				encoded, err := event.ToJSON()
				require.NoError(t, err)
				require.Contains(t, string(encoded), `"value":null`)
			})
		}
	}
}
