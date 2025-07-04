package messages

// MessageCore defines the core properties every message must have
type MessageCore interface {
	GetID() string
	GetRole() MessageRole
}

// ContentProvider defines messages that have content
type ContentProvider interface {
	GetContent() *string
}

// MetadataProvider defines messages that have metadata
type MetadataProvider interface {
	GetMetadata() *MessageMetadata
}

// NamedMessage defines messages that can have a name
type NamedMessage interface {
	GetName() *string
}

// ValidatableMessage defines messages that can be validated
type ValidatableMessage interface {
	Validate() error
}

// SerializableMessage defines messages that can be serialized
type SerializableMessage interface {
	ToJSON() ([]byte, error)
}

// ToolCallProvider defines messages that can have tool calls
type ToolCallProvider interface {
	GetToolCalls() []ToolCall
}

// ToolResponseProvider defines messages that are responses to tool calls
type ToolResponseProvider interface {
	GetToolCallID() string
}

// Note: The main Message interface is defined in types.go for backward compatibility
// These interfaces provide more granular contracts for specific use cases

// UserMessageInterface defines the specific interface for user messages
type UserMessageInterface interface {
	MessageCore
	ContentProvider
	MetadataProvider
	NamedMessage
	ValidatableMessage
	SerializableMessage
}

// AssistantMessageInterface defines the specific interface for assistant messages
type AssistantMessageInterface interface {
	MessageCore
	ContentProvider
	MetadataProvider
	NamedMessage
	ValidatableMessage
	SerializableMessage
	ToolCallProvider
}

// SystemMessageInterface defines the specific interface for system messages
type SystemMessageInterface interface {
	MessageCore
	ContentProvider
	MetadataProvider
	NamedMessage
	ValidatableMessage
	SerializableMessage
}

// ToolMessageInterface defines the specific interface for tool messages
type ToolMessageInterface interface {
	MessageCore
	ContentProvider
	MetadataProvider
	ValidatableMessage
	SerializableMessage
	ToolResponseProvider
}

// DeveloperMessageInterface defines the specific interface for developer messages
type DeveloperMessageInterface interface {
	MessageCore
	ContentProvider
	MetadataProvider
	NamedMessage
	ValidatableMessage
	SerializableMessage
}

// MessageVisitor defines the visitor pattern for type-safe message processing
type MessageVisitor interface {
	VisitUser(*UserMessage) error
	VisitAssistant(*AssistantMessage) error
	VisitSystem(*SystemMessage) error
	VisitTool(*ToolMessage) error
	VisitDeveloper(*DeveloperMessage) error
}

// Visitable defines messages that can accept visitors
type Visitable interface {
	Accept(MessageVisitor) error
}

// Helper functions to check message capabilities

// HasContent checks if a message has content
func HasContent(msg MessageCore) bool {
	cp, ok := msg.(ContentProvider)
	return ok && cp.GetContent() != nil
}

// HasName checks if a message has a name
func HasName(msg MessageCore) bool {
	nm, ok := msg.(NamedMessage)
	return ok && nm.GetName() != nil
}

// HasToolCalls checks if a message has tool calls
func HasToolCalls(msg MessageCore) bool {
	tcp, ok := msg.(ToolCallProvider)
	return ok && len(tcp.GetToolCalls()) > 0
}

// IsToolResponse checks if a message is a tool response
func IsToolResponse(msg MessageCore) bool {
	_, ok := msg.(ToolResponseProvider)
	return ok
}

// CanValidate checks if a message can be validated
func CanValidate(msg MessageCore) bool {
	_, ok := msg.(ValidatableMessage)
	return ok
}

// CanSerialize checks if a message can be serialized
func CanSerialize(msg MessageCore) bool {
	_, ok := msg.(SerializableMessage)
	return ok
}