// Package types provides Go types for AG-UI protocol payloads.
package types

import (
	"encoding/json"
	"fmt"
)

// Role represents the possible message roles.
type Role string

const (
	// RoleDeveloper is the developer role.
	RoleDeveloper Role = "developer"
	// RoleSystem is the system role.
	RoleSystem Role = "system"
	// RoleAssistant is the assistant role.
	RoleAssistant Role = "assistant"
	// RoleUser is the user role.
	RoleUser Role = "user"
	// RoleTool is the tool role.
	RoleTool Role = "tool"
	// RoleActivity is the activity role.
	RoleActivity Role = "activity"
	// RoleReasoning is the reasoning role.
	RoleReasoning Role = "reasoning"
)

// FunctionCall represents a function call name and arguments.
type FunctionCall struct {
	// Name is the function name.
	Name string `json:"name"`
	// Arguments is a JSON-encoded string of function arguments.
	Arguments string `json:"arguments"`
}

// ToolCallTypeFunction is the tool call type for function calls.
const ToolCallTypeFunction = "function"

// ToolCall represents a tool call within a message.
type ToolCall struct {
	// ID is the tool call identifier.
	ID string `json:"id"`
	// Type is the tool call type.
	Type string `json:"type"`
	// Function is the function call payload.
	Function FunctionCall `json:"function"`
}

const (
	// InputContentTypeText is the input content type for text fragments.
	InputContentTypeText = "text"
	// InputContentTypeBinary is the input content type for binary fragments.
	InputContentTypeBinary = "binary"
)

// InputContent represents a multimodal content fragment in a user message.
type InputContent struct {
	// Type is the discriminator for the content fragment.
	Type string `json:"type"`
	// Text is the text content for text fragments.
	Text string `json:"text,omitempty"`
	// MimeType is the MIME type for binary fragments.
	MimeType string `json:"mimeType,omitempty"`
	// ID is an optional binary payload identifier.
	ID string `json:"id,omitempty"`
	// URL is an optional binary payload URL.
	URL string `json:"url,omitempty"`
	// Data is an optional base64-encoded binary payload.
	Data string `json:"data,omitempty"`
	// Filename is an optional binary payload filename.
	Filename string `json:"filename,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler and supports snake_case compatibility.
func (c *InputContent) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	if err := unmarshalField(raw, &c.Type, "type"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.Text, "text"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.MimeType, "mimeType", "mime_type"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.ID, "id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.URL, "url"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.Data, "data"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &c.Filename, "filename"); err != nil {
		return err
	}

	if c.Type == InputContentTypeBinary {
		if err := validateBinaryInputContent(*c); err != nil {
			return err
		}
	}

	return nil
}

// Message represents an AG-UI message.
type Message struct {
	// ID is the message identifier.
	ID string `json:"id"`
	// Role is the message role discriminator.
	Role Role `json:"role"`
	// Content is the message content (string, []InputContent, or structured object depending on role).
	Content any `json:"content,omitempty"`
	// Name is an optional sender name.
	Name string `json:"name,omitempty"`
	// EncryptedContent is an optional encrypted content blob for state continuity.
	EncryptedContent string `json:"encryptedContent,omitempty"`
	// EncryptedValue is an optional encrypted reasoning blob for state continuity.
	EncryptedValue string `json:"encryptedValue,omitempty"`
	// ToolCalls is an optional list of tool calls associated with an assistant message.
	ToolCalls []ToolCall `json:"toolCalls,omitempty"`
	// ToolCallID is an optional tool call identifier associated with a tool message.
	ToolCallID string `json:"toolCallId,omitempty"`
	// Error is an optional error message for tool messages.
	Error string `json:"error,omitempty"`
	// ActivityType is an optional activity discriminator for activity messages.
	ActivityType string `json:"activityType,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler and supports snake_case compatibility.
func (m *Message) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	if err := unmarshalField(raw, &m.ID, "id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.Role, "role"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.Content, "content"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.Name, "name"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.EncryptedContent, "encryptedContent", "encrypted_content"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.EncryptedValue, "encryptedValue", "encrypted_value"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.ToolCalls, "toolCalls", "tool_calls"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.ToolCallID, "toolCallId", "tool_call_id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.Error, "error"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &m.ActivityType, "activityType", "activity_type"); err != nil {
		return err
	}

	return nil
}

// Context represents additional context for the agent.
type Context struct {
	// Description describes the context entry.
	Description string `json:"description"`
	// Value contains the context value.
	Value string `json:"value"`
}

// Tool represents a tool definition available to the agent.
type Tool struct {
	// Name is the tool name.
	Name string `json:"name"`
	// Description describes what the tool does.
	Description string `json:"description"`
	// Parameters contains the JSON Schema for the tool parameters.
	Parameters any `json:"parameters"`
}

// RunAgentInput represents the input payload for running an agent.
type RunAgentInput struct {
	// ThreadID is the conversation thread identifier.
	ThreadID string `json:"threadId"`
	// RunID is the run identifier.
	RunID string `json:"runId"`
	// ParentRunID is an optional identifier of the run that spawned this run.
	ParentRunID *string `json:"parentRunId,omitempty"`
	// State is the arbitrary state payload.
	State any `json:"state"`
	// Messages is the message history for the run.
	Messages []Message `json:"messages"`
	// Tools is the list of tools available to the agent.
	Tools []Tool `json:"tools"`
	// Context is the list of context entries for the agent.
	Context []Context `json:"context"`
	// ForwardedProps is an arbitrary bag of additional properties forwarded to the agent.
	ForwardedProps any `json:"forwardedProps"`
}

// UnmarshalJSON implements json.Unmarshaler and supports snake_case compatibility.
func (r *RunAgentInput) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	if err := unmarshalField(raw, &r.ThreadID, "threadId", "thread_id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.RunID, "runId", "run_id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.ParentRunID, "parentRunId", "parent_run_id"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.State, "state"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.Messages, "messages"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.Tools, "tools"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.Context, "context"); err != nil {
		return err
	}
	if err := unmarshalField(raw, &r.ForwardedProps, "forwardedProps", "forwarded_props"); err != nil {
		return err
	}

	return nil
}

// unmarshalField unmarshals the first matching key into dest.
func unmarshalField[T any](raw map[string]json.RawMessage, dest *T, keys ...string) error {
	value, ok := findRawField(raw, keys...)
	if !ok {
		return nil
	}
	return json.Unmarshal(value, dest)
}

// findRawField finds the first matching raw field by key.
func findRawField(raw map[string]json.RawMessage, keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			return value, true
		}
	}
	return nil, false
}

// validateBinaryInputContent validates required fields for a binary fragment.
func validateBinaryInputContent(content InputContent) error {
	if content.MimeType == "" {
		return fmt.Errorf("BinaryInputContent requires mimeType to be provided.")
	}
	if content.ID == "" && content.URL == "" && content.Data == "" {
		return fmt.Errorf("BinaryInputContent requires at least one of id, url, or data.")
	}
	return nil
}
