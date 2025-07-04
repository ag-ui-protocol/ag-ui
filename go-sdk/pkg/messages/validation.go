package messages

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ValidationOptions configures message validation behavior
type ValidationOptions struct {
	MaxContentLength   int
	MaxNameLength      int
	MaxToolCalls       int
	MaxArgumentsLength int
	AllowEmptyContent  bool
	StrictRoleCheck    bool
	SanitizeContent    bool
}

// DefaultValidationOptions returns default validation options
func DefaultValidationOptions() ValidationOptions {
	return ValidationOptions{
		MaxContentLength:   1000000, // 1MB
		MaxNameLength:      256,
		MaxToolCalls:       100,
		MaxArgumentsLength: 100000, // 100KB
		AllowEmptyContent:  false,
		StrictRoleCheck:    true,
		SanitizeContent:    true,
	}
}

// Validator validates messages according to configured rules
type Validator struct {
	options ValidationOptions

	// Patterns for content sanitization
	scriptPattern *regexp.Regexp
	htmlPattern   *regexp.Regexp
}

// NewValidator creates a new message validator
func NewValidator(options ...ValidationOptions) *Validator {
	opts := DefaultValidationOptions()
	if len(options) > 0 {
		opts = options[0]
	}

	return &Validator{
		options:       opts,
		scriptPattern: regexp.MustCompile(`(?i)<script[^>]*>.*?</script>`),
		htmlPattern:   regexp.MustCompile(`<[^>]+>`),
	}
}

// ValidateMessage validates a single message
func (v *Validator) ValidateMessage(msg Message) error {
	if msg == nil {
		return fmt.Errorf("message is nil")
	}

	// First, call the message's own validation
	if err := msg.Validate(); err != nil {
		return err
	}

	// Additional validation based on options
	// Validate role
	if v.options.StrictRoleCheck {
		if err := msg.GetRole().Validate(); err != nil {
			return fmt.Errorf("invalid role: %w", err)
		}
	}

	// Validate ID
	if msg.GetID() == "" {
		return fmt.Errorf("message ID is required")
	}

	// Validate content
	if content := msg.GetContent(); content != nil {
		if err := v.validateContent(*content); err != nil {
			return err
		}
	} else if !v.options.AllowEmptyContent {
		// Check if message type requires content
		switch m := msg.(type) {
		case *AssistantMessage:
			// Assistant messages can have only tool calls
			if len(m.ToolCalls) == 0 {
				return NewValidationError("assistant message must have content or tool calls",
					ValidationViolation{
						Field:   "content",
						Message: "content or tool calls required",
						Value:   nil,
					})
			}
		case *UserMessage, *SystemMessage, *DeveloperMessage:
			return NewValidationError(fmt.Sprintf("%s message requires content", msg.GetRole()),
				ValidationViolation{
					Field:   "content", 
					Message: "content required",
					Value:   nil,
				})
		case *ToolMessage:
			// Tool messages always require content
			return NewValidationError("tool message requires content",
				ValidationViolation{
					Field:   "content",
					Message: "content required", 
					Value:   nil,
				})
		}
	}

	// Validate name
	if name := msg.GetName(); name != nil {
		if err := v.validateName(*name); err != nil {
			return fmt.Errorf("name validation failed: %w", err)
		}
	}

	// Validate specific message types
	switch m := msg.(type) {
	case *AssistantMessage:
		if err := v.validateAssistantMessage(m); err != nil {
			return err
		}
	case *ToolMessage:
		if err := v.validateToolMessage(m); err != nil {
			return err
		}
	}

	return nil
}

// validateContent validates message content
func (v *Validator) validateContent(content string) error {
	// Check length
	if len(content) > v.options.MaxContentLength {
		return ErrContentTooLong(len(content), v.options.MaxContentLength)
	}

	// Check for valid UTF-8
	if !utf8.ValidString(content) {
		return NewValidationError("content contains invalid UTF-8",
			ValidationViolation{
				Field:   "content",
				Message: "invalid UTF-8 encoding",
				Value:   nil,
			})
	}

	// Check for control characters (except newlines and tabs)
	for _, r := range content {
		if r < 32 && r != '\n' && r != '\t' && r != '\r' {
			return NewValidationError(fmt.Sprintf("content contains invalid control character: %d", r),
				ValidationViolation{
					Field:   "content",
					Message: "invalid control character",
					Value:   r,
				})
		}
	}

	return nil
}

// validateName validates message name
func (v *Validator) validateName(name string) error {
	if len(name) == 0 {
		return fmt.Errorf("name cannot be empty")
	}

	if len(name) > v.options.MaxNameLength {
		return fmt.Errorf("name exceeds maximum length of %d characters", v.options.MaxNameLength)
	}

	// Name should contain only alphanumeric characters, underscores, and hyphens
	for _, r := range name {
		if !isValidNameChar(r) {
			return fmt.Errorf("name contains invalid character: %c", r)
		}
	}

	return nil
}

// isValidNameChar checks if a character is valid for names
func isValidNameChar(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '_' || r == '-' || r == '.'
}

// validateAssistantMessage validates assistant-specific fields
func (v *Validator) validateAssistantMessage(msg *AssistantMessage) error {
	// Validate tool calls
	if len(msg.ToolCalls) > v.options.MaxToolCalls {
		return fmt.Errorf("number of tool calls (%d) exceeds maximum of %d",
			len(msg.ToolCalls), v.options.MaxToolCalls)
	}

	// Validate each tool call
	for i, tc := range msg.ToolCalls {
		if err := v.validateToolCall(tc); err != nil {
			return fmt.Errorf("invalid tool call at index %d: %w", i, err)
		}
	}

	return nil
}

// validateToolCall validates a tool call
func (v *Validator) validateToolCall(tc ToolCall) error {
	if tc.ID == "" {
		return fmt.Errorf("tool call ID is required")
	}

	if tc.Type != "function" {
		return fmt.Errorf("tool call type must be 'function', got '%s'", tc.Type)
	}

	if tc.Function.Name == "" {
		return fmt.Errorf("function name is required")
	}

	// Validate function name
	if err := v.validateName(tc.Function.Name); err != nil {
		return fmt.Errorf("invalid function name: %w", err)
	}

	// Validate arguments length
	if len(tc.Function.Arguments) > v.options.MaxArgumentsLength {
		return fmt.Errorf("function arguments exceed maximum length of %d", v.options.MaxArgumentsLength)
	}

	// Validate arguments as JSON
	if tc.Function.Arguments != "" {
		var args interface{}
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return fmt.Errorf("function arguments must be valid JSON: %w", err)
		}
	}

	return nil
}

// validateToolMessage validates tool message specific fields
func (v *Validator) validateToolMessage(msg *ToolMessage) error {
	if msg.ToolCallID == "" {
		return fmt.Errorf("tool call ID is required")
	}

	// Validate content is not empty
	if msg.Content == "" {
		return fmt.Errorf("tool message content cannot be empty")
	}

	return v.validateContent(msg.Content)
}

// ValidateMessageList validates a list of messages
func (v *Validator) ValidateMessageList(messages MessageList) error {
	if len(messages) == 0 {
		return nil
	}

	// Track tool call IDs to ensure they're referenced properly
	toolCallIDs := make(map[string]bool)

	for i, msg := range messages {
		// Validate individual message
		if err := v.ValidateMessage(msg); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}

		// Track tool calls from assistant messages
		if assistantMsg, ok := msg.(*AssistantMessage); ok {
			for _, tc := range assistantMsg.ToolCalls {
				toolCallIDs[tc.ID] = true
			}
		}

		// Validate tool messages reference valid tool calls
		if toolMsg, ok := msg.(*ToolMessage); ok {
			if !toolCallIDs[toolMsg.ToolCallID] {
				return fmt.Errorf("tool message at index %d references unknown tool call ID: %s",
					i, toolMsg.ToolCallID)
			}
		}
	}

	return nil
}

// Sanitizer sanitizes message content
type Sanitizer struct {
	options       SanitizationOptions
	scriptPattern *regexp.Regexp
	htmlPattern   *regexp.Regexp
}

// SanitizationOptions configures content sanitization
type SanitizationOptions struct {
	RemoveHTML             bool
	RemoveScripts          bool
	TrimWhitespace         bool
	NormalizeNewlines      bool
	MaxConsecutiveNewlines int
}

// DefaultSanitizationOptions returns default sanitization options
func DefaultSanitizationOptions() SanitizationOptions {
	return SanitizationOptions{
		RemoveHTML:             true,
		RemoveScripts:          true,
		TrimWhitespace:         true,
		NormalizeNewlines:      true,
		MaxConsecutiveNewlines: 3,
	}
}

// NewSanitizer creates a new content sanitizer
func NewSanitizer(options ...SanitizationOptions) *Sanitizer {
	opts := DefaultSanitizationOptions()
	if len(options) > 0 {
		opts = options[0]
	}

	s := &Sanitizer{
		options: opts,
	}

	// Pre-compile regex patterns if needed
	if opts.RemoveScripts {
		s.scriptPattern = regexp.MustCompile(`(?i)<script[^>]*>.*?</script>`)
	}
	if opts.RemoveHTML {
		s.htmlPattern = regexp.MustCompile(`<[^>]+>`)
	}

	return s
}

// SanitizeMessage sanitizes a message in place
func (s *Sanitizer) SanitizeMessage(msg Message) error {
	// Sanitize content if present
	if content := msg.GetContent(); content != nil {
		sanitized := s.SanitizeContent(*content)

		// Update the message content based on type
		switch m := msg.(type) {
		case *UserMessage:
			m.Content = &sanitized
		case *AssistantMessage:
			m.Content = &sanitized
		case *SystemMessage:
			m.Content = &sanitized
		case *DeveloperMessage:
			m.Content = &sanitized
		case *ToolMessage:
			m.Content = sanitized
		}
	}

	// Sanitize tool calls for assistant messages
	if assistantMsg, ok := msg.(*AssistantMessage); ok {
		for range assistantMsg.ToolCalls {
			// Function names don't need sanitization, but arguments might
			// However, arguments should remain as valid JSON, so we skip sanitization
		}
	}

	return nil
}

// SanitizeContent sanitizes text content
func (s *Sanitizer) SanitizeContent(content string) string {
	result := content

	// Remove scripts
	if s.options.RemoveScripts && s.scriptPattern != nil {
		result = s.scriptPattern.ReplaceAllString(result, "")
	}

	// Remove HTML tags
	if s.options.RemoveHTML && s.htmlPattern != nil {
		result = s.htmlPattern.ReplaceAllString(result, "")
	}

	// Normalize newlines
	if s.options.NormalizeNewlines {
		// Replace various newline formats with \n
		result = strings.ReplaceAll(result, "\r\n", "\n")
		result = strings.ReplaceAll(result, "\r", "\n")

		// Limit consecutive newlines
		if s.options.MaxConsecutiveNewlines > 0 {
			pattern := strings.Repeat("\n", s.options.MaxConsecutiveNewlines+1)
			replacement := strings.Repeat("\n", s.options.MaxConsecutiveNewlines)

			for strings.Contains(result, pattern) {
				result = strings.ReplaceAll(result, pattern, replacement)
			}
		}
	}

	// Trim whitespace
	if s.options.TrimWhitespace {
		result = strings.TrimSpace(result)
	}

	return result
}

// SanitizeMessageList sanitizes a list of messages
func (s *Sanitizer) SanitizeMessageList(messages MessageList) error {
	for i, msg := range messages {
		if err := s.SanitizeMessage(msg); err != nil {
			return fmt.Errorf("failed to sanitize message at index %d: %w", i, err)
		}
	}
	return nil
}

// ValidateAndSanitize combines validation and sanitization
func ValidateAndSanitize(msg Message, validationOpts ValidationOptions, sanitizationOpts SanitizationOptions) error {
	// First sanitize
	sanitizer := NewSanitizer(sanitizationOpts)
	if err := sanitizer.SanitizeMessage(msg); err != nil {
		return fmt.Errorf("sanitization failed: %w", err)
	}

	// Then validate
	validator := NewValidator(validationOpts)
	if err := validator.ValidateMessage(msg); err != nil {
		return fmt.Errorf("validation failed: %w", err)
	}

	return nil
}

// ValidateConversationFlow validates the logical flow of a conversation
func ValidateConversationFlow(messages MessageList) error {
	if len(messages) == 0 {
		return nil
	}

	// Check for logical flow patterns
	for i := 0; i < len(messages)-1; i++ {
		current := messages[i]
		next := messages[i+1]

		// Tool messages should follow assistant messages with tool calls
		if next.GetRole() == RoleTool {
			if current.GetRole() != RoleAssistant {
				return fmt.Errorf("tool message at index %d must follow an assistant message", i+1)
			}

			// Verify the assistant message has tool calls
			assistantMsg, ok := current.(*AssistantMessage)
			if !ok || len(assistantMsg.ToolCalls) == 0 {
				return fmt.Errorf("tool message at index %d follows assistant message without tool calls", i+1)
			}
		}
	}

	return nil
}
