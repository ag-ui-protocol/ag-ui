package messages

import "fmt"

// ErrorType represents the type of error
type ErrorType string

const (
	// ErrorTypeValidation indicates a validation error
	ErrorTypeValidation ErrorType = "validation"
	// ErrorTypeConversion indicates a conversion error
	ErrorTypeConversion ErrorType = "conversion"
	// ErrorTypeStreaming indicates a streaming error
	ErrorTypeStreaming ErrorType = "streaming"
	// ErrorTypeNotFound indicates a resource not found error
	ErrorTypeNotFound ErrorType = "not_found"
	// ErrorTypeInvalidInput indicates invalid input error
	ErrorTypeInvalidInput ErrorType = "invalid_input"
)

// MessageError is the base error type for message-related errors
type MessageError struct {
	Type    ErrorType
	Message string
	Field   string
	Value   interface{}
	Cause   error
}

// Error implements the error interface
func (e MessageError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s error in field '%s': %s", e.Type, e.Field, e.Message)
	}
	return fmt.Sprintf("%s error: %s", e.Type, e.Message)
}

// Unwrap returns the underlying error
func (e MessageError) Unwrap() error {
	return e.Cause
}

// ValidationError represents validation failures
type ValidationError struct {
	MessageError
	Violations []ValidationViolation
}

// ValidationViolation represents a single validation violation
type ValidationViolation struct {
	Field   string
	Message string
	Value   interface{}
}

// NewValidationError creates a new validation error
func NewValidationError(message string, violations ...ValidationViolation) *ValidationError {
	return &ValidationError{
		MessageError: MessageError{
			Type:    ErrorTypeValidation,
			Message: message,
		},
		Violations: violations,
	}
}

// Error implements the error interface with detailed violations
func (e ValidationError) Error() string {
	if len(e.Violations) == 0 {
		return e.MessageError.Error()
	}
	
	msg := fmt.Sprintf("%s error: %s", e.Type, e.Message)
	for _, v := range e.Violations {
		msg += fmt.Sprintf("\n  - %s: %s", v.Field, v.Message)
	}
	return msg
}

// ConversionError represents conversion failures between message formats
type ConversionError struct {
	MessageError
	FromFormat string
	ToFormat   string
	MessageType string
}

// NewConversionError creates a new conversion error
func NewConversionError(from, to string, messageType string, message string) *ConversionError {
	return &ConversionError{
		MessageError: MessageError{
			Type:    ErrorTypeConversion,
			Message: message,
		},
		FromFormat:  from,
		ToFormat:    to,
		MessageType: messageType,
	}
}

// Error implements the error interface
func (e ConversionError) Error() string {
	return fmt.Sprintf("conversion error from %s to %s for %s: %s", 
		e.FromFormat, e.ToFormat, e.MessageType, e.Message)
}

// StreamingError represents errors during streaming operations
type StreamingError struct {
	MessageError
	EventType string
	EventIndex int
}

// NewStreamingError creates a new streaming error
func NewStreamingError(eventType string, eventIndex int, message string) *StreamingError {
	return &StreamingError{
		MessageError: MessageError{
			Type:    ErrorTypeStreaming,
			Message: message,
		},
		EventType:  eventType,
		EventIndex: eventIndex,
	}
}

// Error implements the error interface
func (e StreamingError) Error() string {
	return fmt.Sprintf("streaming error for event %s at index %d: %s", 
		e.EventType, e.EventIndex, e.Message)
}

// NotFoundError represents errors when a resource is not found
type NotFoundError struct {
	MessageError
	ResourceType string
	ResourceID   string
}

// NewNotFoundError creates a new not found error
func NewNotFoundError(resourceType, resourceID string) *NotFoundError {
	return &NotFoundError{
		MessageError: MessageError{
			Type:    ErrorTypeNotFound,
			Message: fmt.Sprintf("%s with ID '%s' not found", resourceType, resourceID),
		},
		ResourceType: resourceType,
		ResourceID:   resourceID,
	}
}

// InvalidInputError represents errors for invalid input
type InvalidInputError struct {
	MessageError
	Input interface{}
}

// NewInvalidInputError creates a new invalid input error
func NewInvalidInputError(field string, value interface{}, message string) *InvalidInputError {
	return &InvalidInputError{
		MessageError: MessageError{
			Type:    ErrorTypeInvalidInput,
			Message: message,
			Field:   field,
			Value:   value,
		},
		Input: value,
	}
}

// Helper functions for common error scenarios

// ErrEmptyMessageList returns an error for empty message lists
func ErrEmptyMessageList() error {
	return NewValidationError("message list is empty")
}

// ErrInvalidMessageType returns an error for invalid message types
func ErrInvalidMessageType(msgType interface{}) error {
	return NewConversionError("", "", fmt.Sprintf("%T", msgType), 
		"unsupported message type")
}

// ErrInvalidRole returns an error for invalid message roles
func ErrInvalidRole(role MessageRole) error {
	return NewInvalidInputError("role", role, 
		fmt.Sprintf("invalid message role: %s", role))
}

// ErrContentTooLong returns an error when content exceeds maximum length
func ErrContentTooLong(length, maxLength int) error {
	return NewValidationError(
		fmt.Sprintf("content length %d exceeds maximum %d", length, maxLength),
		ValidationViolation{
			Field:   "content",
			Message: "content too long",
			Value:   length,
		},
	)
}

// ErrMissingToolCallReference returns an error for missing tool call references
func ErrMissingToolCallReference(toolCallID string, messageIndex int) error {
	return NewValidationError(
		fmt.Sprintf("tool message at index %d references unknown tool call", messageIndex),
		ValidationViolation{
			Field:   "toolCallId",
			Message: "references unknown tool call",
			Value:   toolCallID,
		},
	)
}

// IsValidationError checks if an error is a validation error
func IsValidationError(err error) bool {
	_, ok := err.(*ValidationError)
	return ok
}

// IsConversionError checks if an error is a conversion error
func IsConversionError(err error) bool {
	_, ok := err.(*ConversionError)
	return ok
}

// IsStreamingError checks if an error is a streaming error
func IsStreamingError(err error) bool {
	_, ok := err.(*StreamingError)
	return ok
}

// IsNotFoundError checks if an error is a not found error
func IsNotFoundError(err error) bool {
	_, ok := err.(*NotFoundError)
	return ok
}