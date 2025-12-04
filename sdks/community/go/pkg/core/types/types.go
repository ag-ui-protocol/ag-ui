package types

// Context represents additional context provided to the agent
type Context struct {
	Description string `json:"description"`
	Value       string `json:"value"`
}

// Tool represents a tool available to the agent
type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"` // JSON Schema for the tool parameters
}

// RunAgentInput represents the input payload for running an agent
type RunAgentInput struct {
	ThreadId       string    `json:"threadId"`
	RunId          string    `json:"runId"`
	State          any       `json:"state,omitempty"`
	Messages       []Message `json:"messages"`
	Tools          []Tool    `json:"tools,omitempty"`
	Context        []Context `json:"context,omitempty"`
	ForwardedProps any       `json:"forwardedProps,omitempty"`
}

// Message represents a message in the conversation
type Message struct {
	ID         string     `json:"id"`
	Role       string     `json:"role"`
	Content    *string    `json:"content,omitempty"`
	Name       *string    `json:"name,omitempty"`
	ToolCalls  []ToolCall `json:"toolCalls,omitempty"`
	ToolCallID *string    `json:"toolCallId,omitempty"`
}

// ToolCall represents a tool call within a message
type ToolCall struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Function Function `json:"function"`
}

// Function represents a function call
type Function struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
