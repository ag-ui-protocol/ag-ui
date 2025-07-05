package messages

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// MessageRole represents the role of a message sender
type MessageRole string

const (
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleSystem    MessageRole = "system"
	RoleTool      MessageRole = "tool"
	RoleDeveloper MessageRole = "developer"
)

// ValidateRole validates that a role is one of the allowed values
func (r MessageRole) Validate() error {
	switch r {
	case RoleUser, RoleAssistant, RoleSystem, RoleTool, RoleDeveloper:
		return nil
	default:
		return fmt.Errorf("invalid role: %s", r)
	}
}

// MessageContent represents the content of a message, supporting various types
type MessageContent struct {
	Type string          `json:"type"`
	Text string          `json:"text,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// NewTextContent creates a new text content
func NewTextContent(text string) *MessageContent {
	return &MessageContent{
		Type: "text",
		Text: text,
	}
}

// NewDataContent creates a new data content (for rich media, structured data, etc.)
func NewDataContent(contentType string, data interface{}) (*MessageContent, error) {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal data content: %w", err)
	}
	return &MessageContent{
		Type: contentType,
		Data: dataBytes,
	}, nil
}

// MessageMetadata contains metadata about a message
type MessageMetadata struct {
	Timestamp    time.Time              `json:"timestamp"`
	Provider     string                 `json:"provider,omitempty"`
	Model        string                 `json:"model,omitempty"`
	UserID       string                 `json:"userId,omitempty"`
	SessionID    string                 `json:"sessionId,omitempty"`
	CustomFields map[string]interface{} `json:"customFields,omitempty"`
}

// ToolCall represents a tool/function call within a message
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

// Message is the interface that all message types must implement
type Message interface {
	GetID() string
	GetRole() MessageRole
	GetContent() *string
	GetName() *string
	GetMetadata() *MessageMetadata
	Validate() error
	ToJSON() ([]byte, error)
}

// BaseMessage contains common fields for all message types
type BaseMessage struct {
	ID       string           `json:"id"`
	Role     MessageRole      `json:"role"`
	Content  *string          `json:"content,omitempty"`
	Name     *string          `json:"name,omitempty"`
	Metadata *MessageMetadata `json:"metadata,omitempty"`
}

// GetID returns the message ID
func (m *BaseMessage) GetID() string {
	return m.ID
}

// GetRole returns the message role
func (m *BaseMessage) GetRole() MessageRole {
	return m.Role
}

// GetContent returns the message content
func (m *BaseMessage) GetContent() *string {
	return m.Content
}

// GetName returns the message name
func (m *BaseMessage) GetName() *string {
	return m.Name
}

// GetMetadata returns the message metadata
func (m *BaseMessage) GetMetadata() *MessageMetadata {
	return m.Metadata
}

// ToJSON serializes the message to JSON
func (m *BaseMessage) ToJSON() ([]byte, error) {
	return json.Marshal(m)
}

// ensureID ensures the message has an ID, generating one if needed
func (m *BaseMessage) ensureID() {
	if m.ID == "" {
		m.ID = uuid.New().String()
	}
}

// ensureMetadata ensures the message has metadata with timestamp
func (m *BaseMessage) ensureMetadata() {
	if m.Metadata == nil {
		m.Metadata = &MessageMetadata{}
	}
	if m.Metadata.Timestamp.IsZero() {
		m.Metadata.Timestamp = time.Now()
	}
}

// UserMessage represents a message from a user
type UserMessage struct {
	BaseMessage
}

// NewUserMessage creates a new user message
func NewUserMessage(content string) *UserMessage {
	msg := &UserMessage{
		BaseMessage: BaseMessage{
			Role:    RoleUser,
			Content: &content,
		},
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// Accept implements the Visitable interface
func (m *UserMessage) Accept(v MessageVisitor) error {
	return v.VisitUser(m)
}

// Validate validates the user message
func (m *UserMessage) Validate() error {
	if err := m.Role.Validate(); err != nil {
		return err
	}
	if m.Content == nil || *m.Content == "" {
		return NewValidationError("user message content is required",
			ValidationViolation{
				Field:   "content",
				Message: "content is required",
				Value:   nil,
			})
	}
	return nil
}

// AssistantMessage represents a message from an AI assistant
type AssistantMessage struct {
	BaseMessage
	ToolCalls []ToolCall `json:"toolCalls,omitempty"`
}

// NewAssistantMessage creates a new assistant message
func NewAssistantMessage(content string) *AssistantMessage {
	msg := &AssistantMessage{
		BaseMessage: BaseMessage{
			Role:    RoleAssistant,
			Content: &content,
		},
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// NewAssistantMessageWithTools creates a new assistant message with tool calls
func NewAssistantMessageWithTools(toolCalls []ToolCall) *AssistantMessage {
	msg := &AssistantMessage{
		BaseMessage: BaseMessage{
			Role: RoleAssistant,
		},
		ToolCalls: toolCalls,
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// Accept implements the Visitable interface
func (m *AssistantMessage) Accept(v MessageVisitor) error {
	return v.VisitAssistant(m)
}

// Validate validates the assistant message
func (m *AssistantMessage) Validate() error {
	if err := m.Role.Validate(); err != nil {
		return err
	}
	// Content is optional for assistant messages (can have only tool calls)
	if m.Content == nil && len(m.ToolCalls) == 0 {
		return fmt.Errorf("assistant message must have either content or tool calls")
	}
	// Validate tool calls if present
	for i, tc := range m.ToolCalls {
		if tc.ID == "" {
			return fmt.Errorf("tool call at index %d missing ID", i)
		}
		if tc.Type != "function" {
			return fmt.Errorf("tool call at index %d has invalid type: %s", i, tc.Type)
		}
		if tc.Function.Name == "" {
			return fmt.Errorf("tool call at index %d missing function name", i)
		}
	}
	return nil
}

// ToJSON serializes the assistant message to JSON
func (m *AssistantMessage) ToJSON() ([]byte, error) {
	return json.Marshal(m)
}

// SystemMessage represents a system-level message
type SystemMessage struct {
	BaseMessage
}

// NewSystemMessage creates a new system message
func NewSystemMessage(content string) *SystemMessage {
	msg := &SystemMessage{
		BaseMessage: BaseMessage{
			Role:    RoleSystem,
			Content: &content,
		},
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// Accept implements the Visitable interface
func (m *SystemMessage) Accept(v MessageVisitor) error {
	return v.VisitSystem(m)
}

// Validate validates the system message
func (m *SystemMessage) Validate() error {
	if err := m.Role.Validate(); err != nil {
		return err
	}
	if m.Content == nil || *m.Content == "" {
		return fmt.Errorf("system message content is required")
	}
	return nil
}

// ToolMessage represents a tool execution result
type ToolMessage struct {
	BaseMessage
	ToolCallID string `json:"toolCallId"`
}

// NewToolMessage creates a new tool message
func NewToolMessage(content string, toolCallID string) *ToolMessage {
	msg := &ToolMessage{
		BaseMessage: BaseMessage{
			Role:    RoleTool,
			Content: &content,
		},
		ToolCallID: toolCallID,
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// Accept implements the Visitable interface
func (m *ToolMessage) Accept(v MessageVisitor) error {
	return v.VisitTool(m)
}

// Validate validates the tool message
func (m *ToolMessage) Validate() error {
	if err := m.Role.Validate(); err != nil {
		return err
	}
	if m.Content == nil || *m.Content == "" {
		return fmt.Errorf("tool message content is required")
	}
	if m.ToolCallID == "" {
		return fmt.Errorf("tool message toolCallId is required")
	}
	return nil
}

// DeveloperMessage represents a developer/debug message
type DeveloperMessage struct {
	BaseMessage
}

// NewDeveloperMessage creates a new developer message
func NewDeveloperMessage(content string) *DeveloperMessage {
	msg := &DeveloperMessage{
		BaseMessage: BaseMessage{
			Role:    RoleDeveloper,
			Content: &content,
		},
	}
	msg.ensureID()
	msg.ensureMetadata()
	return msg
}

// Accept implements the Visitable interface
func (m *DeveloperMessage) Accept(v MessageVisitor) error {
	return v.VisitDeveloper(m)
}

// Validate validates the developer message
func (m *DeveloperMessage) Validate() error {
	if err := m.Role.Validate(); err != nil {
		return err
	}
	if m.Content == nil || *m.Content == "" {
		return fmt.Errorf("developer message content is required")
	}
	return nil
}

// MessageList represents a collection of messages
type MessageList []Message

// Validate validates all messages in the list
func (ml MessageList) Validate() error {
	for i, msg := range ml {
		if err := msg.Validate(); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}
	}
	return nil
}

// ToJSON serializes the message list to JSON
func (ml MessageList) ToJSON() ([]byte, error) {
	// Marshal the entire MessageList in one operation
	// The json package will call MarshalJSON on each message automatically
	return json.Marshal(ml)
}

// ConversationOptions represents options for creating a conversation
type ConversationOptions struct {
	MaxMessages            int
	MaxTokens              int
	PreserveSystemMessages bool
}

// Conversation represents a conversation thread
type Conversation struct {
	ID       string
	Messages MessageList
	Options  ConversationOptions
}

// NewConversation creates a new conversation
func NewConversation(options ...ConversationOptions) *Conversation {
	opts := ConversationOptions{
		MaxMessages:            1000,
		PreserveSystemMessages: true,
	}
	if len(options) > 0 {
		opts = options[0]
	}

	return &Conversation{
		ID:       uuid.New().String(),
		Messages: make(MessageList, 0),
		Options:  opts,
	}
}

// AddMessage adds a message to the conversation
func (c *Conversation) AddMessage(msg Message) error {
	if err := msg.Validate(); err != nil {
		return fmt.Errorf("invalid message: %w", err)
	}

	c.Messages = append(c.Messages, msg)

	// Apply message limits if needed
	if c.Options.MaxMessages > 0 && len(c.Messages) > c.Options.MaxMessages {
		c.pruneMessages()
	}

	return nil
}

// pruneMessages removes old messages while preserving system messages if configured
func (c *Conversation) pruneMessages() {
	if !c.Options.PreserveSystemMessages {
		// Simple case: just keep the last N messages
		startIdx := len(c.Messages) - c.Options.MaxMessages
		c.Messages = c.Messages[startIdx:]
		return
	}

	// Complex case: preserve system messages
	var systemMessages []Message
	var otherMessages []Message

	for _, msg := range c.Messages {
		if msg.GetRole() == RoleSystem {
			systemMessages = append(systemMessages, msg)
		} else {
			otherMessages = append(otherMessages, msg)
		}
	}

	// Calculate how many non-system messages we can keep
	nonSystemSlots := c.Options.MaxMessages - len(systemMessages)
	if nonSystemSlots < 0 {
		nonSystemSlots = 0
	}

	// Keep the most recent non-system messages
	if len(otherMessages) > nonSystemSlots {
		startIdx := len(otherMessages) - nonSystemSlots
		otherMessages = otherMessages[startIdx:]
	}

	// Rebuild the message list
	c.Messages = make(MessageList, 0, len(systemMessages)+len(otherMessages))
	c.Messages = append(c.Messages, systemMessages...)
	c.Messages = append(c.Messages, otherMessages...)
}

// GetMessagesByRole returns all messages with the specified role
func (c *Conversation) GetMessagesByRole(role MessageRole) MessageList {
	var filtered MessageList
	for _, msg := range c.Messages {
		if msg.GetRole() == role {
			filtered = append(filtered, msg)
		}
	}
	return filtered
}

// GetLastMessage returns the last message in the conversation
func (c *Conversation) GetLastMessage() Message {
	if len(c.Messages) == 0 {
		return nil
	}
	return c.Messages[len(c.Messages)-1]
}

// GetLastUserMessage returns the last user message in the conversation
func (c *Conversation) GetLastUserMessage() Message {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if c.Messages[i].GetRole() == RoleUser {
			return c.Messages[i]
		}
	}
	return nil
}

// GetLastAssistantMessage returns the last assistant message in the conversation
func (c *Conversation) GetLastAssistantMessage() Message {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if c.Messages[i].GetRole() == RoleAssistant {
			return c.Messages[i]
		}
	}
	return nil
}
