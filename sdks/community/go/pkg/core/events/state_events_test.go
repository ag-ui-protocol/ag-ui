package events

import (
	"encoding/json"
	"testing"

	coretypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMessageMarshalUnmarshal_Text(t *testing.T) {
	msg := Message{
		ID:      "msg-1",
		Role:    "user",
		Content: "hello",
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "msg-1", decoded.ID)
	assert.Equal(t, "user", string(decoded.Role))
	content, ok := decoded.ContentString()
	require.True(t, ok)
	assert.Equal(t, "hello", content)
	assert.Empty(t, decoded.ActivityType)
}

func TestMessageMarshalUnmarshal_Activity(t *testing.T) {
	msg := Message{
		ID:           "activity-1",
		Role:         RoleActivity,
		ActivityType: "PLAN",
		Content:      map[string]any{"status": "working"},
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "activity-1", decoded.ID)
	assert.Equal(t, "activity", string(decoded.Role))
	assert.Equal(t, "PLAN", decoded.ActivityType)
	_, ok := decoded.ContentString()
	assert.False(t, ok)

	content, ok := decoded.ContentActivity()
	require.True(t, ok)
	assert.Equal(t, "working", content["status"])
}

func TestMessageMarshalUnmarshal_Reasoning(t *testing.T) {
	msg := Message{
		ID:             "reasoning-1",
		Role:           coretypes.RoleReasoning,
		Content:        "summary",
		EncryptedValue: "enc-reasoning-1",
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "reasoning-1", decoded.ID)
	assert.Equal(t, coretypes.RoleReasoning, decoded.Role)
	assert.Equal(t, "enc-reasoning-1", decoded.EncryptedValue)
	content, ok := decoded.ContentString()
	require.True(t, ok)
	assert.Equal(t, "summary", content)
}

func TestValidateMessage_NonActivityRejectsActivityFields(t *testing.T) {
	msg := Message{
		ID:           "msg-1",
		Role:         "user",
		Content:      "hello",
		ActivityType: "PLAN",
	}

	err := validateMessage(msg)
	assert.Error(t, err)
}

func TestValidateMessage_ActivityRequiresFields(t *testing.T) {
	msg := Message{
		ID:   "activity-1",
		Role: RoleActivity,
	}

	err := validateMessage(msg)
	assert.Error(t, err)

	msg.ActivityType = "PLAN"
	err = validateMessage(msg)
	assert.Error(t, err)

	msg.Content = map[string]any{"status": "draft"}
	err = validateMessage(msg)
	assert.NoError(t, err)

	msg.Content = "not-an-object"
	err = validateMessage(msg)
	assert.Error(t, err)
}

func TestValidateMessage_UserAllowsTextOrMultimodal(t *testing.T) {
	msg := Message{
		ID:      "msg-1",
		Role:    "user",
		Content: "hello",
	}

	assert.NoError(t, validateMessage(msg))

	msg.Content = []coretypes.InputContent{
		{Type: coretypes.InputContentTypeText, Text: "hi"},
		{Type: coretypes.InputContentTypeBinary, MimeType: "image/png", URL: "https://example.com/test.png"},
	}
	assert.NoError(t, validateMessage(msg))

	msg.Content = map[string]any{"unexpected": true}
	assert.Error(t, validateMessage(msg))
}

func TestValidateMessage_AssistantContentMustBeStringWhenPresent(t *testing.T) {
	msg := Message{
		ID:      "msg-1",
		Role:    "assistant",
		Content: map[string]any{"unexpected": true},
	}
	assert.Error(t, validateMessage(msg))

	msg.Content = "ok"
	assert.NoError(t, validateMessage(msg))
}

func TestValidateMessage_ReasoningRequiresStringContent(t *testing.T) {
	msg := Message{
		ID:      "reasoning-1",
		Role:    coretypes.RoleReasoning,
		Content: "summary",
	}

	assert.NoError(t, validateMessage(msg))

	msg.Content = map[string]any{"unexpected": true}
	assert.Error(t, validateMessage(msg))
}

func TestValidateMessage_ToolRequiresToolCallIDAndStringContent(t *testing.T) {
	msg := Message{
		ID:      "msg-1",
		Role:    "tool",
		Content: "ok",
	}
	assert.Error(t, validateMessage(msg))

	msg.ToolCallID = "tool-1"
	assert.NoError(t, validateMessage(msg))

	msg.Content = map[string]any{"unexpected": true}
	assert.Error(t, validateMessage(msg))
}

func TestMessageMarshalJSON_IncludesOptionalFields_Assistant(t *testing.T) {
	msg := Message{
		ID:               "msg-1",
		Role:             "assistant",
		Content:          "hello",
		Name:             "bob",
		EncryptedContent: "enc-content-msg-1",
		ToolCalls: []ToolCall{
			{
				ID:   "tool-1",
				Type: "function",
				Function: Function{
					Name:      "f",
					Arguments: "{}",
				},
			},
		},
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "msg-1", decoded["id"])
	assert.Equal(t, "assistant", decoded["role"])
	assert.Equal(t, "hello", decoded["content"])
	assert.Equal(t, "bob", decoded["name"])
	assert.Equal(t, "enc-content-msg-1", decoded["encryptedContent"])
	toolCalls, ok := decoded["toolCalls"].([]any)
	require.True(t, ok)
	assert.Len(t, toolCalls, 1)
}

func TestMessageMarshalJSON_IncludesOptionalFields_Tool(t *testing.T) {
	msg := Message{
		ID:         "msg-1",
		Role:       "tool",
		Content:    "ok",
		ToolCallID: "tool-123",
		Error:      "boom",
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "msg-1", decoded["id"])
	assert.Equal(t, "tool", decoded["role"])
	assert.Equal(t, "ok", decoded["content"])
	assert.Equal(t, "tool-123", decoded["toolCallId"])
	assert.Equal(t, "boom", decoded["error"])
}
