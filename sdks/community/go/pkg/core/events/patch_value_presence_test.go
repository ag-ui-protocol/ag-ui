package events

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPatchValueWirePresence(t *testing.T) {
	for _, container := range []struct {
		name   string
		prefix string
	}{
		{"state", `{"type":"STATE_DELTA","delta":`},
		{"activity", `{"type":"ACTIVITY_DELTA","messageId":"m","activityType":"a","patch":`},
	} {
		for _, op := range []string{"add", "replace", "test"} {
			for _, value := range []struct {
				name  string
				field string
				valid bool
			}{
				{"missing", "", false},
				{"null", `,"value":null`, true},
				{"object", `,"value":{}`, true},
			} {
				t.Run(container.name+"/"+op+"/"+value.name, func(t *testing.T) {
					operation := fmt.Sprintf(`{"op":%q,"path":"/x"%s}`, op, value.field)
					event, err := EventFromJSON([]byte(container.prefix + "[" + operation + "]}"))
					if err == nil {
						err = event.Validate()
					}
					if !value.valid {
						require.Error(t, err)
						return
					}
					require.NoError(t, err)
					encoded, err := event.ToJSON()
					require.NoError(t, err)
					require.Contains(t, string(encoded), value.field[1:])
				})
			}
		}
	}
}

func TestConstructedNullPatchValuesRemainValid(t *testing.T) {
	for _, op := range []string{"add", "replace", "test"} {
		patch := []JSONPatchOperation{{Op: op, Path: "/x", Value: nil}}
		for _, event := range []Event{
			NewStateDeltaEvent(patch),
			NewActivityDeltaEvent("m", "a", patch),
		} {
			require.NoError(t, event.Validate())
			encoded, err := event.ToJSON()
			require.NoError(t, err)
			require.Contains(t, string(encoded), `"value":null`)
		}
	}
}

func TestPatchValuePresenceResetsWhenDecodingAgain(t *testing.T) {
	var operation JSONPatchOperation
	require.NoError(t, json.Unmarshal([]byte(`{"op":"add","path":"/x","value":null}`), &operation))
	require.NoError(t, validateJSONPatchOperation(operation))
	require.Error(t, json.Unmarshal([]byte(`{"op":"add","path":"/x"}`), &operation))
}
