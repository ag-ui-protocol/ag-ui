package events

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestContentDeltaWirePresence(t *testing.T) {
	for _, event := range []struct {
		name string
		id   string
	}{
		{"TEXT_MESSAGE_CONTENT", "messageId"},
		{"TOOL_CALL_ARGS", "toolCallId"},
		{"REASONING_MESSAGE_CONTENT", "messageId"},
	} {
		for _, delta := range []struct {
			name  string
			field string
			valid bool
		}{
			{"missing", "", false},
			{"null", `,"delta":null`, false},
			{"number", `,"delta":42`, false},
			{"empty", `,"delta":""`, true},
			{"content", `,"delta":"hello"`, true},
		} {
			t.Run(event.name+"/"+delta.name, func(t *testing.T) {
				payload := []byte(fmt.Sprintf(`{"type":%q,%q:"id"%s}`, event.name, event.id, delta.field))
				decoded, err := EventFromJSON(payload)
				if err == nil {
					err = decoded.Validate()
				}
				if !delta.valid {
					require.Error(t, err)
					return
				}
				require.NoError(t, err)
				encoded, err := decoded.ToJSON()
				require.NoError(t, err)
				require.Contains(t, string(encoded), delta.field[1:])
			})
		}
	}
}

func TestConstructedEmptyContentDeltasRemainValid(t *testing.T) {
	for _, event := range []Event{
		NewTextMessageContentEvent("m", ""),
		NewToolCallArgsEvent("c", ""),
		NewReasoningMessageContentEvent("r", ""),
	} {
		require.NoError(t, event.Validate())
		encoded, err := event.ToJSON()
		require.NoError(t, err)
		decoded, err := EventFromJSON(encoded)
		require.NoError(t, err)
		require.NoError(t, decoded.Validate())
	}
}
