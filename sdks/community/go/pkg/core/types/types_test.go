package types

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRunAgentInputUnmarshalCamelCase verifies decoding a camelCase RunAgentInput payload.
func TestRunAgentInputUnmarshalCamelCase(t *testing.T) {
	payload := []byte(`{
		"threadId": "thread-1",
		"runId": "run-1",
		"parentRunId": "run-0",
		"state": {"mode": "test"},
		"messages": [
			{"id": "msg-1", "role": "user", "content": "hello"},
			{
				"id": "msg-2",
				"role": "assistant",
				"content": "hi",
				"toolCalls": [
					{
						"id": "tc-1",
						"type": "function",
						"function": {"name": "tool", "arguments": "{}"}
					}
				]
			}
		],
		"tools": [{"name": "tool", "description": "desc", "parameters": {"type": "object"}}],
		"context": [{"description": "ctx", "value": "val"}],
		"forwardedProps": {"traceId": "abc"}
	}`)

	var input RunAgentInput
	err := json.Unmarshal(payload, &input)
	require.NoError(t, err)

	assert.Equal(t, "thread-1", input.ThreadID)
	assert.Equal(t, "run-1", input.RunID)
	require.NotNil(t, input.ParentRunID)
	assert.Equal(t, "run-0", *input.ParentRunID)

	require.Len(t, input.Messages, 2)
	assert.Equal(t, RoleUser, input.Messages[0].Role)
	assert.Equal(t, "msg-2", input.Messages[1].ID)
	require.Len(t, input.Messages[1].ToolCalls, 1)
	assert.Equal(t, "tool", input.Messages[1].ToolCalls[0].Function.Name)

	require.Len(t, input.Tools, 1)
	assert.Equal(t, "tool", input.Tools[0].Name)

	require.Len(t, input.Context, 1)
	assert.Equal(t, "ctx", input.Context[0].Description)

	forwarded, ok := input.ForwardedProps.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "abc", forwarded["traceId"])
}

// TestRunAgentInputUnmarshalSnakeCase verifies decoding a snake_case RunAgentInput payload.
func TestRunAgentInputUnmarshalSnakeCase(t *testing.T) {
	payload := []byte(`{
		"thread_id": "thread-2",
		"run_id": "run-2",
		"parent_run_id": "run-1",
		"state": {"mode": "snake"},
		"messages": [
			{
				"id": "msg-1",
				"role": "tool",
				"content": "ok",
				"tool_call_id": "tool-1",
				"error": "failed",
				"tool_calls": [
					{
						"id": "tc-2",
						"type": "function",
						"function": {"name": "tool", "arguments": "{\"x\":1}"}
					}
				]
			},
			{
				"id": "msg-2",
				"role": "activity",
				"activity_type": "progress",
				"content": {"step": 1}
			}
		],
		"tools": [],
		"context": [],
		"forwarded_props": {"trace_id": "xyz"}
	}`)

	var input RunAgentInput
	err := json.Unmarshal(payload, &input)
	require.NoError(t, err)

	assert.Equal(t, "thread-2", input.ThreadID)
	assert.Equal(t, "run-2", input.RunID)
	require.NotNil(t, input.ParentRunID)
	assert.Equal(t, "run-1", *input.ParentRunID)

	require.Len(t, input.Messages, 2)
	assert.Equal(t, RoleTool, input.Messages[0].Role)
	assert.Equal(t, "tool-1", input.Messages[0].ToolCallID)
	assert.Equal(t, "failed", input.Messages[0].Error)
	require.Len(t, input.Messages[0].ToolCalls, 1)
	assert.Equal(t, "tc-2", input.Messages[0].ToolCalls[0].ID)

	require.IsType(t, "", input.Messages[0].Content)
	assert.Equal(t, "ok", input.Messages[0].Content.(string))

	assert.Equal(t, RoleActivity, input.Messages[1].Role)
	assert.Equal(t, "progress", input.Messages[1].ActivityType)
	require.IsType(t, map[string]any{}, input.Messages[1].Content)
	contentMap := input.Messages[1].Content.(map[string]any)
	assert.Equal(t, float64(1), contentMap["step"])

	forwarded, ok := input.ForwardedProps.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "xyz", forwarded["trace_id"])
}

// TestInputContentUnmarshalSnakeCase verifies decoding snake_case fields in InputContent.
func TestInputContentUnmarshalSnakeCase(t *testing.T) {
	payload := []byte(`{
		"type": "binary",
		"mime_type": "image/png",
		"url": "https://example.com/test.png",
		"filename": "test.png"
	}`)

	var content InputContent
	err := json.Unmarshal(payload, &content)
	require.NoError(t, err)

	assert.Equal(t, InputContentTypeBinary, content.Type)
	assert.Equal(t, "image/png", content.MimeType)
	assert.Equal(t, "https://example.com/test.png", content.URL)
	assert.Equal(t, "test.png", content.Filename)
}

// TestInputContentUnmarshalBinaryRequiresSource verifies binary InputContent requires at least one source field.
func TestInputContentUnmarshalBinaryRequiresSource(t *testing.T) {
	payload := []byte(`{
		"type": "binary",
		"mimeType": "image/png"
	}`)

	var content InputContent
	err := json.Unmarshal(payload, &content)
	assert.Error(t, err)
}

// TestInputContentUnmarshalBinaryRequiresMimeType verifies binary InputContent requires a mimeType field.
func TestInputContentUnmarshalBinaryRequiresMimeType(t *testing.T) {
	payload := []byte(`{
		"type": "binary",
		"url": "https://example.com/test.png"
	}`)

	var content InputContent
	err := json.Unmarshal(payload, &content)
	assert.Error(t, err)
}

// TestMessageContentString verifies ContentString extracts text content.
func TestMessageContentString(t *testing.T) {
	msg := Message{Role: RoleAssistant, Content: "hello"}
	text, ok := msg.ContentString()
	assert.True(t, ok)
	assert.Equal(t, "hello", text)

	msg = Message{Role: RoleAssistant, Content: []any{}}
	_, ok = msg.ContentString()
	assert.False(t, ok)

	msg = Message{Role: RoleActivity, Content: "hello"}
	_, ok = msg.ContentString()
	assert.False(t, ok)
}

// TestMessageContentInputContents verifies ContentInputContents extracts multimodal input parts.
func TestMessageContentInputContents(t *testing.T) {
	payload := []byte(`{
		"id": "msg-1",
		"role": "user",
		"content": [
			{"type": "text", "text": "hi"},
			{"type": "binary", "mime_type": "image/png", "url": "https://example.com/test.png"}
		]
	}`)

	var msg Message
	err := json.Unmarshal(payload, &msg)
	require.NoError(t, err)

	parts, ok := msg.ContentInputContents()
	require.True(t, ok)
	require.Len(t, parts, 2)
	assert.Equal(t, InputContentTypeText, parts[0].Type)
	assert.Equal(t, "hi", parts[0].Text)
	assert.Equal(t, InputContentTypeBinary, parts[1].Type)
	assert.Equal(t, "image/png", parts[1].MimeType)
	assert.Equal(t, "https://example.com/test.png", parts[1].URL)

	msg = Message{Role: RoleUser, Content: "plain"}
	_, ok = msg.ContentInputContents()
	assert.False(t, ok)

	msg = Message{
		Role: RoleUser,
		Content: []InputContent{
			{Type: InputContentTypeBinary, MimeType: "image/png"},
		},
	}
	_, ok = msg.ContentInputContents()
	assert.False(t, ok)

	msg = Message{
		Role: RoleUser,
		Content: []InputContent{
			{Type: InputContentTypeBinary, URL: "https://example.com/test.png"},
		},
	}
	_, ok = msg.ContentInputContents()
	assert.False(t, ok)

	msg = Message{
		Role: RoleUser,
		Content: []InputContent{
			{Type: InputContentTypeBinary, MimeType: "image/png", URL: "https://example.com/test.png"},
		},
	}
	parts, ok = msg.ContentInputContents()
	require.True(t, ok)
	require.Len(t, parts, 1)
	assert.Equal(t, "https://example.com/test.png", parts[0].URL)
}

// TestMessageContentActivity verifies ContentActivity extracts structured activity content.
func TestMessageContentActivity(t *testing.T) {
	payload := []byte(`{
		"id": "msg-1",
		"role": "activity",
		"activityType": "progress",
		"content": {"step": 1}
	}`)

	var msg Message
	err := json.Unmarshal(payload, &msg)
	require.NoError(t, err)

	content, ok := msg.ContentActivity()
	require.True(t, ok)
	assert.Equal(t, float64(1), content["step"])

	msg = Message{Role: RoleActivity, Content: "plain"}
	_, ok = msg.ContentActivity()
	assert.False(t, ok)

	msg = Message{Role: RoleUser, Content: map[string]any{"step": 1}}
	_, ok = msg.ContentActivity()
	assert.False(t, ok)
}
