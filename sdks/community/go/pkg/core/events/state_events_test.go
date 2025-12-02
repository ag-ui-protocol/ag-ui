package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMessageMarshalUnmarshal_Text(t *testing.T) {
	msg := Message{
		ID:      "msg-1",
		Role:    "user",
		Content: strPtr("hello"),
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "msg-1", decoded.ID)
	assert.Equal(t, "user", decoded.Role)
	require.NotNil(t, decoded.Content)
	assert.Equal(t, "hello", *decoded.Content)
	assert.Nil(t, decoded.ActivityContent)
	assert.Empty(t, decoded.ActivityType)
}

func TestMessageMarshalUnmarshal_Activity(t *testing.T) {
	msg := Message{
		ID:              "activity-1",
		Role:            RoleActivity,
		ActivityType:    "PLAN",
		ActivityContent: map[string]any{"status": "working"},
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "activity-1", decoded.ID)
	assert.Equal(t, "activity", decoded.Role)
	assert.Equal(t, "PLAN", decoded.ActivityType)
	require.Nil(t, decoded.Content)
	require.NotNil(t, decoded.ActivityContent)
	assert.Equal(t, "working", decoded.ActivityContent["status"])
}

func TestValidateMessage_NonActivityRejectsActivityFields(t *testing.T) {
	msg := Message{
		ID:              "msg-1",
		Role:            "user",
		Content:         strPtr("hello"),
		ActivityType:    "PLAN",
		ActivityContent: map[string]any{"status": "draft"},
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

	msg.ActivityContent = map[string]any{"status": "draft"}
	err = validateMessage(msg)
	assert.NoError(t, err)

	msg = Message{
		ID:              "msg-1",
		Role:            "user",
		Content:         strPtr("hello"),
		ActivityType:    "PLAN",
		ActivityContent: map[string]any{"status": "oops"},
	}
	err = validateMessage(msg)
	assert.Error(t, err)
}

func TestMessageMarshalJSON_IncludesOptionalFields(t *testing.T) {
	name := "bob"
	toolCallID := "tool-123"
	msg := Message{
		ID:      "msg-1",
		Role:    "assistant",
		Content: strPtr("hello"),
		Name:    &name,
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
		ToolCallID: &toolCallID,
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "msg-1", decoded["id"])
	assert.Equal(t, "assistant", decoded["role"])
	assert.Equal(t, "hello", decoded["content"])
	assert.Equal(t, "bob", decoded["name"])
	assert.Equal(t, "tool-123", decoded["toolCallId"])
	toolCalls, ok := decoded["toolCalls"].([]any)
	require.True(t, ok)
	assert.Len(t, toolCalls, 1)
}

func TestMessageMarshalJSON_ActivityPrefersActivityContent(t *testing.T) {
	msg := Message{
		ID:              "activity-1",
		Role:            "activity",
		Content:         strPtr("should-be-ignored"),
		ActivityType:    "PLAN",
		ActivityContent: map[string]any{"status": "draft"},
	}

	data, err := json.Marshal(msg)
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, "activity-1", decoded["id"])
	assert.Equal(t, "activity", decoded["role"])
	assert.Equal(t, "PLAN", decoded["activityType"])
	content, ok := decoded["content"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "draft", content["status"])
}

func TestMessageUnmarshalJSON_InvalidTextContent(t *testing.T) {
	payload := []byte(`{"id":"msg-1","role":"user","content":123}`)
	var msg Message
	err := json.Unmarshal(payload, &msg)
	assert.Error(t, err)
}

func TestMessageUnmarshalJSON_InvalidActivityContent(t *testing.T) {
	payload := []byte(`{"id":"activity-1","role":"activity","activityType":"PLAN","content":"not-an-object"}`)
	var msg Message
	err := json.Unmarshal(payload, &msg)
	assert.Error(t, err)
}

func TestMessageUnmarshalJSON_ResetsActivityFieldsForText(t *testing.T) {
	payload := []byte(`{"id":"msg-1","role":"user","activityType":"PLAN","content":"hello"}`)
	var msg Message
	err := json.Unmarshal(payload, &msg)
	require.NoError(t, err)

	assert.Equal(t, "msg-1", msg.ID)
	assert.Equal(t, "user", msg.Role)
	require.NotNil(t, msg.Content)
	assert.Equal(t, "hello", *msg.Content)
	assert.Empty(t, msg.ActivityType)
	assert.Nil(t, msg.ActivityContent)
}

func TestMessageUnmarshalJSON_TextWithNoContent(t *testing.T) {
	payload := []byte(`{"id":"msg-1","role":"user"}`)
	var msg Message
	err := json.Unmarshal(payload, &msg)
	require.NoError(t, err)

	assert.Equal(t, "msg-1", msg.ID)
	assert.Equal(t, "user", msg.Role)
	assert.Nil(t, msg.Content)
	assert.Nil(t, msg.ActivityContent)
	assert.Empty(t, msg.ActivityType)
}

func TestMessageUnmarshalJSON_ActivityWithNoContent(t *testing.T) {
	payload := []byte(`{"id":"activity-1","role":"activity","activityType":"PLAN"}`)
	var msg Message
	err := json.Unmarshal(payload, &msg)
	require.NoError(t, err)

	assert.Equal(t, "activity-1", msg.ID)
	assert.Equal(t, "activity", msg.Role)
	assert.Equal(t, "PLAN", msg.ActivityType)
	assert.Nil(t, msg.Content)
	assert.Nil(t, msg.ActivityContent)
}
