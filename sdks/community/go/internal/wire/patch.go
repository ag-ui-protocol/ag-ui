package wire

import (
	"encoding/json"
	"fmt"
)

type patchOperationFields struct {
	Op    string          `json:"op"`
	Path  *string         `json:"path"`
	Value json.RawMessage `json:"value"`
}

// RequirePatchFields checks wire presence without interpreting any patch value.
func RequirePatchFields(data []byte, field string) error {
	var fields struct {
		Delta json.RawMessage `json:"delta"`
		Patch json.RawMessage `json:"patch"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	payload := fields.Delta
	if field == "patch" {
		payload = fields.Patch
	}
	if len(payload) == 0 {
		return nil
	}
	var operations []patchOperationFields
	if err := json.Unmarshal(payload, &operations); err != nil {
		return err
	}
	for i, op := range operations {
		if op.Path == nil {
			return fmt.Errorf("%s[%d]: path field must be a non-null string", field, i)
		}
		if (op.Op == "add" || op.Op == "replace" || op.Op == "test") && op.Value == nil {
			return fmt.Errorf("%s[%d]: value field is required for %s operation", field, i, op.Op)
		}
	}
	return nil
}
