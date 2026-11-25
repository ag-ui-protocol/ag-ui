package json

import (
	"context"
	stdjson "encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding"
	"github.com/stretchr/testify/require"
)

func TestContentDeltaStrictFields(t *testing.T) {
	for _, fixture := range []struct {
		eventType string
		id        string
	}{
		{"TEXT_MESSAGE_CONTENT", "messageId"},
		{"TOOL_CALL_ARGS", "toolCallId"},
	} {
		t.Run(fixture.eventType, func(t *testing.T) {
			strict := NewJSONDecoder(nil)
			permissive := NewJSONDecoder(&encoding.DecodingOptions{
				Strict: true, AllowUnknownFields: true, ValidateEvents: true,
			})
			data := []byte(fmt.Sprintf(`{"type":%q,%q:"id","delta":"","extra":true}`, fixture.eventType, fixture.id))
			_, err := strict.Decode(context.Background(), data)
			require.Error(t, err)
			require.Contains(t, err.Error(), "unknown field")
			_, err = permissive.Decode(context.Background(), data)
			require.NoError(t, err)
			for _, field := range []string{"", `,"delta":null`, `,"delta":42`, `,"Delta":""`} {
				malformed := []byte(fmt.Sprintf(`{"type":%q,%q:"id"%s}`, fixture.eventType, fixture.id, field))
				_, err := strict.Decode(context.Background(), malformed)
				require.Error(t, err)
				_, err = permissive.Decode(context.Background(), malformed)
				require.Error(t, err)
			}
		})
	}
}

func TestContentDeltaKeepsOuterUseNumber(t *testing.T) {
	decoder := stdjson.NewDecoder(strings.NewReader(
		`{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"","rawEvent":{"id":9007199254740993}}`,
	))
	decoder.UseNumber()
	var event events.TextMessageContentEvent
	require.NoError(t, decoder.Decode(&event))
	require.IsType(t, stdjson.Number(""), event.RawEvent.(map[string]any)["id"])
	require.Equal(t, stdjson.Number("9007199254740993"), event.RawEvent.(map[string]any)["id"])
}
