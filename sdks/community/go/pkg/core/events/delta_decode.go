package events

import (
	"encoding/json"
	"fmt"
)

// decodeContentDelta keeps required wire presence separate from a Go string's
// zero value. Explicit empty strings and constructor-created events remain valid.
func decodeContentDelta(data []byte, target any) error {
	var fields struct {
		Delta *string `json:"delta"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields.Delta == nil {
		return fmt.Errorf("delta field must be a non-null string")
	}
	return json.Unmarshal(data, target)
}

// UnmarshalJSON requires an explicitly present, non-null delta string.
func (e *TextMessageContentEvent) UnmarshalJSON(data []byte) error {
	type wireEvent TextMessageContentEvent
	return decodeContentDelta(data, (*wireEvent)(e))
}

// UnmarshalJSON requires an explicitly present, non-null delta string.
func (e *ToolCallArgsEvent) UnmarshalJSON(data []byte) error {
	type wireEvent ToolCallArgsEvent
	return decodeContentDelta(data, (*wireEvent)(e))
}

// UnmarshalJSON requires an explicitly present, non-null delta string.
func (e *ReasoningMessageContentEvent) UnmarshalJSON(data []byte) error {
	type wireEvent ReasoningMessageContentEvent
	return decodeContentDelta(data, (*wireEvent)(e))
}
