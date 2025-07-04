package providers

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

// streamingStatePool provides a pool of reusable streaming states
var streamingStatePool = sync.Pool{
	New: func() interface{} {
		return NewAnthropicStreamingState()
	},
}

// GetStreamingState retrieves a streaming state from the pool
func GetStreamingState() *AnthropicStreamingState {
	return streamingStatePool.Get().(*AnthropicStreamingState)
}

// PutStreamingState returns a streaming state to the pool after cleanup
func PutStreamingState(state *AnthropicStreamingState) {
	state.Reset()
	streamingStatePool.Put(state)
}

// AnthropicMessage represents a message in Anthropic format
type AnthropicMessage struct {
	Role    string                `json:"role"`
	Content []AnthropicContent    `json:"content"`
}

// AnthropicContent represents content in Anthropic format
type AnthropicContent struct {
	Type     string                 `json:"type"`
	Text     *string                `json:"text,omitempty"`
	ID       *string                `json:"id,omitempty"`
	Name     *string                `json:"name,omitempty"`
	Input    map[string]interface{} `json:"input,omitempty"`
	ToolUseID *string               `json:"tool_use_id,omitempty"`
	Content  *string                `json:"content,omitempty"`
}

// AnthropicSystemPrompt represents the system prompt in Anthropic format
type AnthropicSystemPrompt struct {
	System string `json:"system"`
}

// AnthropicRequest represents a complete request to Anthropic
type AnthropicRequest struct {
	System   string             `json:"system,omitempty"`
	Messages []AnthropicMessage `json:"messages"`
}

// AnthropicConverter converts messages to/from Anthropic format
type AnthropicConverter struct {
	*BaseConverter
	validationOptions ConversionValidationOptions
}

// NewAnthropicConverter creates a new Anthropic converter
func NewAnthropicConverter() *AnthropicConverter {
	return &AnthropicConverter{
		BaseConverter: NewBaseConverter(),
		validationOptions: ConversionValidationOptions{
			AllowStandaloneToolMessages: false,
		},
	}
}

// WithValidationOptions sets validation options for the converter
func (c *AnthropicConverter) WithValidationOptions(opts ConversionValidationOptions) *AnthropicConverter {
	c.validationOptions = opts
	return c
}

// GetProviderName returns the provider name
func (c *AnthropicConverter) GetProviderName() string {
	return "anthropic"
}

// SupportsStreaming indicates that Anthropic supports streaming
func (c *AnthropicConverter) SupportsStreaming() bool {
	return true
}

// ToProviderFormat converts AG-UI messages to Anthropic format
func (c *AnthropicConverter) ToProviderFormat(msgs messages.MessageList) (interface{}, error) {
	// Validate messages with configured options
	if err := ValidateMessages(msgs, c.validationOptions); err != nil {
		return nil, fmt.Errorf("message validation failed: %w", err)
	}
	
	// Preprocess messages
	processed := c.PreprocessMessages(msgs)
	
	// Separate system messages from conversation messages
	var systemPrompt string
	var conversationMessages messages.MessageList
	
	for _, msg := range processed {
		if msg.GetRole() == messages.RoleSystem {
			// Anthropic uses a single system prompt, so concatenate system messages
			if systemPrompt != "" {
				systemPrompt += "\n\n"
			}
			if content := msg.GetContent(); content != nil {
				systemPrompt += *content
			}
		} else {
			conversationMessages = append(conversationMessages, msg)
		}
	}
	
	// Convert conversation messages to Anthropic format
	anthropicMessages := make([]AnthropicMessage, 0, len(conversationMessages))
	
	for _, msg := range conversationMessages {
		anthropicMsg, err := c.convertToAnthropic(msg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert message: %w", err)
		}
		anthropicMessages = append(anthropicMessages, anthropicMsg)
	}
	
	// Create the request structure
	request := AnthropicRequest{
		System:   systemPrompt,
		Messages: anthropicMessages,
	}
	
	return request, nil
}

// convertToAnthropic converts a single message to Anthropic format
func (c *AnthropicConverter) convertToAnthropic(msg messages.Message) (AnthropicMessage, error) {
	anthropicMsg := AnthropicMessage{
		Role:    c.mapRole(msg.GetRole()),
		Content: []AnthropicContent{},
	}
	
	// Handle specific message types
	switch m := msg.(type) {
	case *messages.UserMessage:
		if content := m.GetContent(); content != nil {
			anthropicMsg.Content = append(anthropicMsg.Content, AnthropicContent{
				Type: "text",
				Text: content,
			})
		}
		
	case *messages.AssistantMessage:
		// Add text content if present
		if content := m.GetContent(); content != nil {
			anthropicMsg.Content = append(anthropicMsg.Content, AnthropicContent{
				Type: "text",
				Text: content,
			})
		}
		
		// Add tool uses if present
		for _, tc := range m.ToolCalls {
			// Parse arguments as JSON
			var input map[string]interface{}
			if err := json.Unmarshal([]byte(tc.Function.Arguments), &input); err != nil {
				// If parsing fails, use raw string
				input = map[string]interface{}{
					"arguments": tc.Function.Arguments,
				}
			}
			
			anthropicMsg.Content = append(anthropicMsg.Content, AnthropicContent{
				Type:  "tool_use",
				ID:    &tc.ID,
				Name:  &tc.Function.Name,
				Input: input,
			})
		}
		
	case *messages.ToolMessage:
		// Anthropic uses "user" role for tool results
		anthropicMsg.Role = "user"
		anthropicMsg.Content = append(anthropicMsg.Content, AnthropicContent{
			Type:      "tool_result",
			ToolUseID: &m.ToolCallID,
			Content:   &m.Content,
		})
		
	case *messages.DeveloperMessage:
		// Convert developer messages to assistant messages with a prefix
		anthropicMsg.Role = "assistant"
		content := m.GetContent()
		if content == nil {
			return AnthropicMessage{}, messages.NewInvalidInputError("content", nil, 
				"developer message content cannot be nil")
		}
		devContent := "[Developer Message] " + *content
		anthropicMsg.Content = append(anthropicMsg.Content, AnthropicContent{
			Type: "text",
			Text: &devContent,
		})
		
	default:
		return AnthropicMessage{}, messages.NewConversionError("AG-UI", "Anthropic", 
			fmt.Sprintf("%T", msg), "unsupported message type")
	}
	
	return anthropicMsg, nil
}

// mapRole maps AG-UI roles to Anthropic roles
func (c *AnthropicConverter) mapRole(role messages.MessageRole) string {
	switch role {
	case messages.RoleUser:
		return "user"
	case messages.RoleAssistant:
		return "assistant"
	case messages.RoleTool:
		return "user" // Anthropic uses "user" role for tool results
	case messages.RoleDeveloper:
		return "assistant" // Map to assistant with special handling
	default:
		return string(role)
	}
}

// FromProviderFormat converts Anthropic format to AG-UI messages
func (c *AnthropicConverter) FromProviderFormat(data interface{}) (messages.MessageList, error) {
	// Type assertion for different possible formats
	var anthropicRequest AnthropicRequest
	
	switch v := data.(type) {
	case AnthropicRequest:
		anthropicRequest = v
	case []AnthropicMessage:
		anthropicRequest.Messages = v
	case []byte:
		if err := json.Unmarshal(v, &anthropicRequest); err != nil {
			// Try unmarshaling as just messages array
			var messages []AnthropicMessage
			if err2 := json.Unmarshal(v, &messages); err2 != nil {
				return nil, fmt.Errorf("failed to unmarshal Anthropic data: %w", err)
			}
			anthropicRequest.Messages = messages
		}
	default:
		return nil, fmt.Errorf("invalid data format: expected AnthropicRequest, []AnthropicMessage, or JSON bytes")
	}
	
	// Convert to AG-UI messages
	agMessages := make(messages.MessageList, 0)
	
	// Add system message if present
	if anthropicRequest.System != "" {
		agMessages = append(agMessages, messages.NewSystemMessage(anthropicRequest.System))
	}
	
	// Convert conversation messages
	for _, anthropicMsg := range anthropicRequest.Messages {
		convertedMsgs, err := c.convertFromAnthropic(anthropicMsg)
		if err != nil {
			return nil, fmt.Errorf("failed to convert Anthropic message: %w", err)
		}
		agMessages = append(agMessages, convertedMsgs...)
	}
	
	return agMessages, nil
}

// convertFromAnthropic converts a single Anthropic message to AG-UI format
func (c *AnthropicConverter) convertFromAnthropic(anthropicMsg AnthropicMessage) (messages.MessageList, error) {
	result := make(messages.MessageList, 0)
	
	switch anthropicMsg.Role {
	case "user":
		// Check if this is a tool result or regular user message
		for _, content := range anthropicMsg.Content {
			switch content.Type {
			case "text":
				if content.Text != nil {
					msg := messages.NewUserMessage(*content.Text)
					result = append(result, msg)
				}
				
			case "tool_result":
				if content.ToolUseID != nil && content.Content != nil {
					msg := messages.NewToolMessage(*content.Content, *content.ToolUseID)
					result = append(result, msg)
				}
			}
		}
		
	case "assistant":
		var builder strings.Builder
		var toolCalls []messages.ToolCall
		isDeveloperMessage := false
		
		for _, content := range anthropicMsg.Content {
			switch content.Type {
			case "text":
				if content.Text != nil {
					// Check for developer message prefix
					if len(*content.Text) >= 20 && (*content.Text)[:20] == "[Developer Message] " {
						// This is a converted developer message
						devContent := (*content.Text)[20:]
						msg := messages.NewDeveloperMessage(devContent)
						result = append(result, msg)
						isDeveloperMessage = true
						// Skip adding to builder since this is a developer message
						continue
					}
					
					if builder.Len() > 0 {
						builder.WriteString("\n")
					}
					builder.WriteString(*content.Text)
				}
				
			case "tool_use":
				if content.ID != nil && content.Name != nil {
					// Convert input back to JSON string
					args, err := json.Marshal(content.Input)
					if err != nil {
						return nil, fmt.Errorf("failed to marshal tool input: %w", err)
					}
					
					toolCall := messages.ToolCall{
						ID:   *content.ID,
						Type: "function",
						Function: messages.Function{
							Name:      *content.Name,
							Arguments: string(args),
						},
					}
					toolCalls = append(toolCalls, toolCall)
				}
			}
		}
		
		// Create assistant message only if not a developer message
		if !isDeveloperMessage {
			textContent := builder.String()
			if len(toolCalls) > 0 {
				msg := messages.NewAssistantMessageWithTools(toolCalls)
				if textContent != "" {
					msg.Content = &textContent
				}
				result = append(result, msg)
			} else if textContent != "" {
				msg := messages.NewAssistantMessage(textContent)
				result = append(result, msg)
			}
		}
		
	default:
		return nil, fmt.Errorf("unknown Anthropic message role: %s", anthropicMsg.Role)
	}
	
	return result, nil
}

// AnthropicStreamEvent represents a streaming event from Anthropic
type AnthropicStreamEvent struct {
	Type  string          `json:"type"`
	Index *int            `json:"index,omitempty"`
	Delta *AnthropicDelta `json:"delta,omitempty"`
}

// AnthropicDelta represents a delta update in streaming
type AnthropicDelta struct {
	Type      *string                `json:"type,omitempty"`
	Text      *string                `json:"text,omitempty"`
	ToolUseID *string                `json:"id,omitempty"`
	Name      *string                `json:"name,omitempty"`
	Input     *string                `json:"input,omitempty"`
}

// AnthropicStreamingState maintains state for streaming message reconstruction
type AnthropicStreamingState struct {
	CurrentMessage *messages.AssistantMessage
	ContentBuffer  string
	ToolCalls      map[int]*messages.ToolCall
	ToolInputs     map[int]string
}

// NewAnthropicStreamingState creates a new Anthropic streaming state
func NewAnthropicStreamingState() *AnthropicStreamingState {
	return &AnthropicStreamingState{
		ToolCalls:  make(map[int]*messages.ToolCall),
		ToolInputs: make(map[int]string),
	}
}

// Reset clears the streaming state for reuse
func (s *AnthropicStreamingState) Reset() {
	s.CurrentMessage = nil
	s.ContentBuffer = ""
	// Clear maps and recreate to release memory
	s.ToolCalls = make(map[int]*messages.ToolCall)
	s.ToolInputs = make(map[int]string)
}

// Cleanup releases resources held by the streaming state
func (s *AnthropicStreamingState) Cleanup() {
	s.Reset()
}

// Size returns the current size of the streaming state (number of tool calls + inputs)
func (s *AnthropicStreamingState) Size() int {
	return len(s.ToolCalls) + len(s.ToolInputs)
}

// ProcessStreamEvent processes an Anthropic streaming event
func (c *AnthropicConverter) ProcessStreamEvent(state *AnthropicStreamingState, event AnthropicStreamEvent) (*messages.AssistantMessage, error) {
	// Initialize message if needed
	if state.CurrentMessage == nil {
		state.CurrentMessage = &messages.AssistantMessage{
			BaseMessage: messages.BaseMessage{
				Role: messages.RoleAssistant,
			},
		}
	}
	
	switch event.Type {
	case "content_block_delta":
		if event.Delta != nil && event.Index != nil {
			if event.Delta.Type != nil && *event.Delta.Type == "text" && event.Delta.Text != nil {
				state.ContentBuffer += *event.Delta.Text
				content := state.ContentBuffer
				state.CurrentMessage.Content = &content
			} else if event.Delta.Type != nil && *event.Delta.Type == "tool_use" {
				tc, exists := state.ToolCalls[*event.Index]
				if !exists {
					tc = &messages.ToolCall{
						Type: "function",
					}
					state.ToolCalls[*event.Index] = tc
					state.ToolInputs[*event.Index] = ""
				}
				
				if event.Delta.ToolUseID != nil {
					tc.ID = *event.Delta.ToolUseID
				}
				if event.Delta.Name != nil {
					tc.Function.Name = *event.Delta.Name
				}
				if event.Delta.Input != nil {
					state.ToolInputs[*event.Index] += *event.Delta.Input
					tc.Function.Arguments = state.ToolInputs[*event.Index]
				}
			}
		}
		
	case "content_block_stop":
		// Finalize any pending tool calls
		state.CurrentMessage.ToolCalls = make([]messages.ToolCall, 0, len(state.ToolCalls))
		for _, tc := range state.ToolCalls {
			state.CurrentMessage.ToolCalls = append(state.CurrentMessage.ToolCalls, *tc)
		}
	}
	
	return state.CurrentMessage, nil
}

func init() {
	// Register the Anthropic converter with the default registry
	if err := Register(NewAnthropicConverter()); err != nil {
		panic(fmt.Sprintf("failed to register Anthropic converter: %v", err))
	}
}