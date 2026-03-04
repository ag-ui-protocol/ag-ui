package types

import "encoding/json"

// ContentString returns the content as a string when the underlying value is string-like.
func (m Message) ContentString() (string, bool) {
	if m.Role == RoleActivity {
		return "", false
	}

	switch value := m.Content.(type) {
	case nil:
		return "", false
	case string:
		return value, true
	case *string:
		if value == nil {
			return "", false
		}
		return *value, true
	case []byte:
		return string(value), true
	case json.RawMessage:
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return "", false
		}
		return text, true
	default:
		return "", false
	}
}

// ContentInputContents returns the content as []InputContent for user messages when the underlying value is a multimodal array.
func (m Message) ContentInputContents() ([]InputContent, bool) {
	if m.Role != RoleUser {
		return nil, false
	}

	switch value := m.Content.(type) {
	case nil:
		return nil, false
	case []InputContent:
		if !inputContentsHaveBinaryPayload(value) {
			return nil, false
		}
		return value, true
	case []any:
		return decodeInputContents(value)
	default:
		return nil, false
	}
}

// ContentActivity returns the content as map[string]any for activity messages when the underlying value is an object.
func (m Message) ContentActivity() (map[string]any, bool) {
	if m.Role != RoleActivity {
		return nil, false
	}

	switch value := m.Content.(type) {
	case nil:
		return nil, false
	case map[string]any:
		return value, true
	case json.RawMessage:
		var obj map[string]any
		if err := json.Unmarshal(value, &obj); err != nil {
			return nil, false
		}
		return obj, true
	default:
		return nil, false
	}
}

// decodeInputContents converts a JSON-decoded array into []InputContent.
func decodeInputContents(value []any) ([]InputContent, bool) {
	if value == nil {
		return nil, false
	}

	data, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}

	var parts []InputContent
	if err := json.Unmarshal(data, &parts); err != nil {
		return nil, false
	}
	return parts, true
}

// inputContentsHaveBinaryPayload reports whether every binary fragment satisfies required constraints.
func inputContentsHaveBinaryPayload(parts []InputContent) bool {
	for _, part := range parts {
		if part.Type == InputContentTypeBinary {
			if err := validateBinaryInputContent(part); err != nil {
				return false
			}
		}
	}
	return true
}
