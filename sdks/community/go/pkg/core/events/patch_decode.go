package events

import (
	"encoding/json"
	"fmt"
)

// UnmarshalJSON checks required wire keys without changing programmatic structs.
// Value may explicitly be null; path must be a non-null string (possibly empty).
func (op *JSONPatchOperation) UnmarshalJSON(data []byte) error {
	type wireOperation JSONPatchOperation
	var decoded wireOperation
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields struct {
		Value json.RawMessage `json:"value"`
		Path  *string         `json:"path"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields.Path == nil {
		return fmt.Errorf("path field must be a non-null string")
	}
	if (decoded.Op == "add" || decoded.Op == "replace" || decoded.Op == "test") && fields.Value == nil {
		return fmt.Errorf("value field is required for %s operation", decoded.Op)
	}
	*op = JSONPatchOperation(decoded)
	return nil
}
