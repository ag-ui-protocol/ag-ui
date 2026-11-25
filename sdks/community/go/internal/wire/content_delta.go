package wire

import (
	"encoding/json"
	"fmt"
)

// RequireContentDelta checks the wire key without replacing the caller's decoder.
func RequireContentDelta(data []byte) error {
	var fields struct {
		Delta *string `json:"delta"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields.Delta == nil {
		return fmt.Errorf("delta field must be a non-null string")
	}
	return nil
}
