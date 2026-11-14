package events

import (
	"fmt"
	"testing"
)

// TestDecodersCoverEveryValidEventType guards against the two decoders in this
// package drifting from validEventTypes. TOOL_CALL_CHUNK and the THINKING_*
// events were rejected by EventFromJSON as "unknown event type", and
// DecodeEvent handed back TOOL_CALL_CHUNK and SUBAGENT_* as a *RawEvent, so a
// consumer switching on the concrete type never saw them.
func TestDecodersCoverEveryValidEventType(t *testing.T) {
	decoder := NewEventDecoder(nil)
	for eventType := range validEventTypes {
		data := []byte(fmt.Sprintf(`{"type":%q}`, eventType))

		event, err := EventFromJSON(data)
		if err != nil {
			t.Errorf("EventFromJSON(%s) failed: %v", eventType, err)
		} else if event.Type() != eventType {
			t.Errorf("EventFromJSON(%s).Type() = %s", eventType, event.Type())
		}

		decoded, err := decoder.DecodeEvent(string(eventType), data)
		if err != nil {
			t.Errorf("DecodeEvent(%s) failed: %v", eventType, err)
			continue
		}
		if _, raw := decoded.(*RawEvent); raw && eventType != EventTypeRaw {
			t.Errorf("DecodeEvent(%s) fell back to *RawEvent instead of its own type", eventType)
		}
	}
}
