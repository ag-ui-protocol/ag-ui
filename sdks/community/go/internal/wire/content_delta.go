package wire

import (
	"encoding/json"
	"fmt"
)

// RequireContentDelta checks the wire key without replacing the caller's decoder.
func RequireContentDelta(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	raw, present := fields["delta"]
	if !present {
		return fmt.Errorf("delta field must be a non-null string")
	}
	var delta *string
	if err := json.Unmarshal(raw, &delta); err != nil {
		return err
	}
	if delta == nil {
		return fmt.Errorf("delta field must be a non-null string")
	}
	return nil
}
