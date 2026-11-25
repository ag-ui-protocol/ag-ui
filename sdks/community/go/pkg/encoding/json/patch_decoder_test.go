package json

import (
	"context"
	stdjson "encoding/json"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
	"github.com/stretchr/testify/require"
)

func TestStrictStateDeltaChecksOperationFields(t *testing.T) {
	const withExtra = `{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/id","value":null,"extra":true}]}`
	strict := NewJSONDecoder(nil)
	permissive := NewJSONDecoder(&encoding.DecodingOptions{
		Strict: true, AllowUnknownFields: true, ValidateEvents: true,
	})
	_, err := strict.Decode(context.Background(), []byte(withExtra))
	require.Error(t, err)
	require.Contains(t, err.Error(), "unknown field")
	_, err = permissive.Decode(context.Background(), []byte(withExtra))
	require.NoError(t, err)
	for _, decoder := range []*JSONDecoder{strict, permissive} {
		_, err := decoder.Decode(context.Background(), []byte(
			`{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/id"}]}`,
		))
		require.Error(t, err)
		require.Contains(t, err.Error(), "value field is required")
	}
}

func TestPatchOperationKeepsOuterUseNumber(t *testing.T) {
	const token = "9007199254740993"
	for _, value := range []string{token, `{"id":` + token + `}`} {
		decoder := stdjson.NewDecoder(strings.NewReader(`{"op":"replace","path":"/id","value":` + value + `}`))
		decoder.UseNumber()
		var operation events.JSONPatchOperation
		require.NoError(t, decoder.Decode(&operation))
		if value == token {
			require.Equal(t, stdjson.Number(token), operation.Value)
		} else {
			require.Equal(t, stdjson.Number(token), operation.Value.(map[string]any)["id"])
		}
		encoded, err := stdjson.Marshal(operation)
		require.NoError(t, err)
		require.Contains(t, string(encoded), `"value":`+value)
	}
}
