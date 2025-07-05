package providers

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

// OpenAIMessage represents a message in OpenAI format
type OpenAIMessage struct {
	Role       string           `json:"role"`
	Content    *string          `json:"content,omitempty"`
	Name       *string          `json:"name,omitempty"`
	ToolCalls  []OpenAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID *string          `json:"tool_call_id,omitempty"`
}

// OpenAIToolCall represents a tool call in OpenAI format
type OpenAIToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"`
	Function OpenAIFunctionCall `json:"function"`
}

// OpenAIFunctionCall represents a function call in OpenAI format
type OpenAIFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// OpenAIConverter converts messages to/from OpenAI format
type OpenAIConverter struct {
	*BaseConverter
	validationOptions ConversionValidationOptions
}

// NewOpenAIConverter creates a new OpenAI converter
func NewOpenAIConverter() *OpenAIConverter {
	return &OpenAIConverter{
		BaseConverter: NewBaseConverter(),
		validationOptions: ConversionValidationOptions{
			AllowStandaloneToolMessages: false,
		},
	}
}

// WithValidationOptions sets validation options for the converter
func (c *OpenAIConverter) WithValidationOptions(opts ConversionValidationOptions) *OpenAIConverter {
	c.validationOptions = opts
	return c
}

// GetProviderName returns the provider name
func (c *OpenAIConverter) GetProviderName() string {
	return "openai"
}

// SupportsStreaming indicates that OpenAI supports streaming
func (c *OpenAIConverter) SupportsStreaming() bool {
	return true
}

// ToProviderFormat converts AG-UI messages to OpenAI format
func (c *OpenAIConverter) ToProviderFormat(msgs messages.MessageList) (interface{}, error) {
	// Validate messages with configured options
	if err := ValidateMessages(msgs, c.validationOptions); err != nil {
		return nil, fmt.Errorf("message validation failed: %w", err)
	}

	// Preprocess messages
	processed := c.PreprocessMessages(msgs)

	// Convert to OpenAI format
	openAIMessages := make([]OpenAIMessage, 0, len(processed))

	for _, msg := range processed {
		openAIMsg, err := c.convertToOpenAI(msg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert message: %w", err)
		}
		openAIMessages = append(openAIMessages, openAIMsg)
	}

	return openAIMessages, nil
}

// convertToOpenAI converts a single message to OpenAI format
func (c *OpenAIConverter) convertToOpenAI(msg messages.Message) (OpenAIMessage, error) {
	openAIMsg := OpenAIMessage{
		Role:    string(msg.GetRole()),
		Content: msg.GetContent(),
		Name:    msg.GetName(),
	}

	// Handle specific message types
	switch m := msg.(type) {
	case *messages.AssistantMessage:
		if len(m.ToolCalls) > 0 {
			openAIMsg.ToolCalls = make([]OpenAIToolCall, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				openAITC := OpenAIToolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: OpenAIFunctionCall{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}
				openAIMsg.ToolCalls = append(openAIMsg.ToolCalls, openAITC)
			}
		}

	case *messages.ToolMessage:
		openAIMsg.Role = "tool"
		openAIMsg.Content = m.GetContent()
		openAIMsg.ToolCallID = &m.ToolCallID

	case *messages.DeveloperMessage:
		// OpenAI doesn't have a developer role, convert to system
		openAIMsg.Role = "system"
		if openAIMsg.Name == nil {
			name := "developer"
			openAIMsg.Name = &name
		}
	}

	return openAIMsg, nil
}

// FromProviderFormat converts OpenAI format to AG-UI messages
func (c *OpenAIConverter) FromProviderFormat(data interface{}) (messages.MessageList, error) {
	// Type assertion
	openAIMessages, ok := data.([]OpenAIMessage)
	if !ok {
		// Try to unmarshal from JSON
		jsonData, jsonOK := data.([]byte)
		if !jsonOK {
			return nil, fmt.Errorf("invalid data format: expected []OpenAIMessage or JSON bytes")
		}

		if err := json.Unmarshal(jsonData, &openAIMessages); err != nil {
			return nil, fmt.Errorf("failed to unmarshal OpenAI messages: %w", err)
		}
	}

	// Convert to AG-UI messages
	agMessages := make(messages.MessageList, 0, len(openAIMessages))

	for _, openAIMsg := range openAIMessages {
		agMsg, err := c.convertFromOpenAI(openAIMsg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert OpenAI message: %w", err)
		}
		agMessages = append(agMessages, agMsg)
	}

	return agMessages, nil
}

// convertFromOpenAI converts a single OpenAI message to AG-UI format
func (c *OpenAIConverter) convertFromOpenAI(openAIMsg OpenAIMessage) (messages.Message, error) {
	switch openAIMsg.Role {
	case "user":
		if openAIMsg.Content == nil {
			return nil, fmt.Errorf("user message missing content")
		}
		msg := messages.NewUserMessage(*openAIMsg.Content)
		msg.Name = openAIMsg.Name
		return msg, nil

	case "assistant":
		var msg *messages.AssistantMessage

		if len(openAIMsg.ToolCalls) > 0 {
			// Convert tool calls
			toolCalls := make([]messages.ToolCall, 0, len(openAIMsg.ToolCalls))
			for _, tc := range openAIMsg.ToolCalls {
				toolCall := messages.ToolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: messages.Function{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}
				toolCalls = append(toolCalls, toolCall)
			}
			msg = messages.NewAssistantMessageWithTools(toolCalls)
			msg.Content = openAIMsg.Content
		} else {
			if openAIMsg.Content == nil {
				return nil, fmt.Errorf("assistant message missing content and tool calls")
			}
			msg = messages.NewAssistantMessage(*openAIMsg.Content)
		}

		msg.Name = openAIMsg.Name
		return msg, nil

	case "system":
		if openAIMsg.Content == nil {
			return nil, fmt.Errorf("system message missing content")
		}

		// Check if this is a converted developer message
		if openAIMsg.Name != nil && *openAIMsg.Name == "developer" {
			msg := messages.NewDeveloperMessage(*openAIMsg.Content)
			msg.Name = openAIMsg.Name
			return msg, nil
		}

		msg := messages.NewSystemMessage(*openAIMsg.Content)
		msg.Name = openAIMsg.Name
		return msg, nil

	case "tool":
		if openAIMsg.Content == nil {
			return nil, fmt.Errorf("tool message missing content")
		}
		if openAIMsg.ToolCallID == nil {
			return nil, fmt.Errorf("tool message missing tool_call_id")
		}
		return messages.NewToolMessage(*openAIMsg.Content, *openAIMsg.ToolCallID), nil

	default:
		return nil, fmt.Errorf("unknown OpenAI message role: %s", openAIMsg.Role)
	}
}

// OpenAIStreamDelta represents a streaming delta update from OpenAI
type OpenAIStreamDelta struct {
	Role      *string               `json:"role,omitempty"`
	Content   *string               `json:"content,omitempty"`
	ToolCalls []OpenAIToolCallDelta `json:"tool_calls,omitempty"`
}

// OpenAIToolCallDelta represents a tool call delta in streaming
type OpenAIToolCallDelta struct {
	Index    int                      `json:"index"`
	ID       *string                  `json:"id,omitempty"`
	Type     *string                  `json:"type,omitempty"`
	Function *OpenAIFunctionCallDelta `json:"function,omitempty"`
}

// OpenAIFunctionCallDelta represents a function call delta in streaming
type OpenAIFunctionCallDelta struct {
	Name      *string `json:"name,omitempty"`
	Arguments *string `json:"arguments,omitempty"`
}

// StreamingState maintains state for streaming message reconstruction
type StreamingState struct {
	CurrentMessage *messages.AssistantMessage
	ToolCalls      map[int]*messages.ToolCall
	ContentBuffer  string
}

// NewStreamingState creates a new streaming state
func NewStreamingState() *StreamingState {
	return &StreamingState{
		ToolCalls: make(map[int]*messages.ToolCall),
	}
}

// ProcessDelta processes a streaming delta and returns the updated message
func (c *OpenAIConverter) ProcessDelta(state *StreamingState, delta OpenAIStreamDelta) (*messages.AssistantMessage, error) {
	// Initialize message if needed
	if state.CurrentMessage == nil {
		state.CurrentMessage = &messages.AssistantMessage{
			BaseMessage: messages.BaseMessage{
				Role: messages.RoleAssistant,
			},
		}
		state.CurrentMessage.BaseMessage.ID = "" // Will be set by ensureID
	}

	// Process content delta
	if delta.Content != nil {
		state.ContentBuffer += *delta.Content
		content := state.ContentBuffer
		state.CurrentMessage.Content = &content
	}

	// Process tool call deltas
	for _, tcDelta := range delta.ToolCalls {
		tc, exists := state.ToolCalls[tcDelta.Index]
		if !exists {
			tc = &messages.ToolCall{}
			state.ToolCalls[tcDelta.Index] = tc
		}

		if tcDelta.ID != nil {
			tc.ID = *tcDelta.ID
		}
		if tcDelta.Type != nil {
			tc.Type = *tcDelta.Type
		}
		if tcDelta.Function != nil {
			if tcDelta.Function.Name != nil {
				tc.Function.Name = *tcDelta.Function.Name
			}
			if tcDelta.Function.Arguments != nil {
				tc.Function.Arguments += *tcDelta.Function.Arguments
			}
		}
	}

	// Update tool calls in message
	state.CurrentMessage.ToolCalls = make([]messages.ToolCall, 0, len(state.ToolCalls))
	for i := 0; i < len(state.ToolCalls); i++ {
		if tc, exists := state.ToolCalls[i]; exists {
			state.CurrentMessage.ToolCalls = append(state.CurrentMessage.ToolCalls, *tc)
		}
	}

	return state.CurrentMessage, nil
}

func init() {
	// Register the OpenAI converter with the default registry
	if err := Register(NewOpenAIConverter()); err != nil {
		panic(fmt.Sprintf("failed to register OpenAI converter: %v", err))
	}
}
