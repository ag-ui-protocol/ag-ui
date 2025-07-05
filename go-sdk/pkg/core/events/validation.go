package events

import (
	"context"
	"fmt"
	"strings"
)

// ValidationLevel defines the level of validation to apply
type ValidationLevel int

const (
	// ValidationStrict applies all validation rules strictly
	ValidationStrict ValidationLevel = iota

	// ValidationPermissive applies minimal validation rules
	ValidationPermissive

	// ValidationCustom allows custom validation rules
	ValidationCustom
)

// ValidationConfig contains configuration for event validation
type ValidationConfig struct {
	Level ValidationLevel

	// Custom validation options
	SkipTimestampValidation bool
	SkipSequenceValidation  bool
	SkipFieldValidation     bool
	AllowEmptyIDs           bool
	AllowUnknownEventTypes  bool

	// Custom validators
	CustomValidators []CustomValidator
}

// CustomValidator defines a custom validation function
type CustomValidator func(ctx context.Context, event Event) error

// DefaultValidationConfig returns the default validation configuration
func DefaultValidationConfig() *ValidationConfig {
	return &ValidationConfig{
		Level: ValidationStrict,
	}
}

// PermissiveValidationConfig returns a permissive validation configuration
func PermissiveValidationConfig() *ValidationConfig {
	return &ValidationConfig{
		Level:                   ValidationPermissive,
		SkipTimestampValidation: true,
		AllowEmptyIDs:           true,
		AllowUnknownEventTypes:  false, // Still validate event types for safety
	}
}

// Validator provides configurable event validation
type Validator struct {
	config *ValidationConfig
}

// NewValidator creates a new validator with the given configuration
func NewValidator(config *ValidationConfig) *Validator {
	if config == nil {
		config = DefaultValidationConfig()
	}
	return &Validator{config: config}
}

// ValidateEvent validates a single event according to the configuration
func (v *Validator) ValidateEvent(ctx context.Context, event Event) error {
	if event == nil {
		return fmt.Errorf("event cannot be nil")
	}

	// Apply level-based validation
	switch v.config.Level {
	case ValidationStrict:
		return v.validateStrict(ctx, event)
	case ValidationPermissive:
		return v.validatePermissive(ctx, event)
	case ValidationCustom:
		return v.validateCustom(ctx, event)
	default:
		return v.validateStrict(ctx, event)
	}
}

// ValidateSequence validates a sequence of events according to the configuration
func (v *Validator) ValidateSequence(ctx context.Context, events []Event) error {
	if v.config.SkipSequenceValidation {
		// Just validate individual events
		for i, event := range events {
			if err := v.ValidateEvent(ctx, event); err != nil {
				return fmt.Errorf("event %d validation failed: %w", i, err)
			}
		}
		return nil
	}

	// Use the existing ValidateSequence function for strict validation
	return ValidateSequence(events)
}

// validateStrict applies strict validation rules
func (v *Validator) validateStrict(ctx context.Context, event Event) error {
	// Standard event validation
	if err := event.Validate(); err != nil {
		return err
	}

	// Additional strict validations
	if !v.config.SkipTimestampValidation {
		if event.Timestamp() == nil {
			return fmt.Errorf("timestamp is required in strict mode")
		}
		if *event.Timestamp() <= 0 {
			return fmt.Errorf("timestamp must be positive")
		}
	}

	// Apply custom validators
	for _, validator := range v.config.CustomValidators {
		if err := validator(ctx, event); err != nil {
			return fmt.Errorf("custom validation failed: %w", err)
		}
	}

	return nil
}

// validatePermissive applies permissive validation rules
func (v *Validator) validatePermissive(ctx context.Context, event Event) error {
	// Check basic event structure
	baseEvent := event.GetBaseEvent()
	if baseEvent == nil {
		return fmt.Errorf("base event is required")
	}

	// Skip field validation if configured
	if v.config.SkipFieldValidation {
		return nil
	}

	// Only validate event type if not allowing unknown types
	if !v.config.AllowUnknownEventTypes {
		if baseEvent.EventType == "" {
			return fmt.Errorf("event type is required")
		}
		if !isValidEventType(baseEvent.EventType) {
			return fmt.Errorf("invalid event type: %s", baseEvent.EventType)
		}
	}

	// Apply minimal field validation based on event type
	if err := v.validateMinimalFields(event); err != nil {
		return err
	}

	// Apply custom validators for consistency with strict mode
	for _, validator := range v.config.CustomValidators {
		if err := validator(ctx, event); err != nil {
			return fmt.Errorf("custom validation failed: %w", err)
		}
	}

	return nil
}

// validateCustom applies custom validation rules
func (v *Validator) validateCustom(ctx context.Context, event Event) error {
	// Only apply custom validators
	for _, validator := range v.config.CustomValidators {
		if err := validator(ctx, event); err != nil {
			return fmt.Errorf("custom validation failed: %w", err)
		}
	}
	return nil
}

// validateMinimalFields performs minimal field validation
func (v *Validator) validateMinimalFields(event Event) error {
	// If AllowEmptyIDs is false, we can just use the event's built-in validation
	if !v.config.AllowEmptyIDs {
		return event.Validate()
	}

	// When AllowEmptyIDs is true, we need to do selective validation
	// that skips ID checks but validates other required fields
	switch event.Type() {
	case EventTypeRunStarted, EventTypeRunFinished:
		// These events only validate IDs in their Validate methods,
		// so when AllowEmptyIDs is true, we just validate the base event
		return event.GetBaseEvent().Validate()
		
	case EventTypeRunError:
		if errorEvent, ok := event.(*RunErrorEvent); ok {
			if errorEvent.Message == "" {
				return fmt.Errorf("RunErrorEvent validation failed: message field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeStepStarted:
		if stepEvent, ok := event.(*StepStartedEvent); ok {
			if stepEvent.StepName == "" {
				return fmt.Errorf("StepStartedEvent validation failed: stepName field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeStepFinished:
		if stepEvent, ok := event.(*StepFinishedEvent); ok {
			if stepEvent.StepName == "" {
				return fmt.Errorf("StepFinishedEvent validation failed: stepName field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeTextMessageStart, EventTypeTextMessageEnd:
		// These events only validate IDs in their Validate methods
		return event.GetBaseEvent().Validate()
		
	case EventTypeTextMessageContent:
		if msgEvent, ok := event.(*TextMessageContentEvent); ok {
			if msgEvent.Delta == "" {
				return fmt.Errorf("TextMessageContentEvent validation failed: delta field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeToolCallStart:
		if toolEvent, ok := event.(*ToolCallStartEvent); ok {
			if toolEvent.ToolCallName == "" {
				return fmt.Errorf("ToolCallStartEvent validation failed: toolCallName field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeToolCallArgs:
		if toolEvent, ok := event.(*ToolCallArgsEvent); ok {
			if toolEvent.Delta == "" {
				return fmt.Errorf("ToolCallArgsEvent validation failed: delta field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeToolCallEnd:
		// This event only validates IDs in its Validate method
		return event.GetBaseEvent().Validate()
		
	case EventTypeStateSnapshot:
		if stateEvent, ok := event.(*StateSnapshotEvent); ok {
			if stateEvent.Snapshot == nil {
				return fmt.Errorf("StateSnapshotEvent validation failed: snapshot field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeStateDelta:
		if deltaEvent, ok := event.(*StateDeltaEvent); ok {
			if len(deltaEvent.Delta) == 0 {
				return fmt.Errorf("StateDeltaEvent validation failed: delta field must contain at least one operation")
			}
			// Note: We don't call the full Validate here because it would validate
			// each operation, which is more than minimal validation
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeMessagesSnapshot:
		if msgEvent, ok := event.(*MessagesSnapshotEvent); ok {
			// Only validate non-ID fields for each message
			for i, msg := range msgEvent.Messages {
				if msg.Role == "" {
					return fmt.Errorf("MessagesSnapshotEvent validation failed: message[%d].role field is required", i)
				}
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeRaw:
		if rawEvent, ok := event.(*RawEvent); ok {
			if rawEvent.Event == nil {
				return fmt.Errorf("RawEvent validation failed: event field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	case EventTypeCustom:
		if customEvent, ok := event.(*CustomEvent); ok {
			if customEvent.Name == "" {
				return fmt.Errorf("CustomEvent validation failed: name field is required")
			}
		}
		return event.GetBaseEvent().Validate()
		
	default:
		// For any other event types, just validate the base event
		return event.GetBaseEvent().Validate()
	}
}

// Global validator instance
var globalValidator = NewValidator(DefaultValidationConfig())

// SetGlobalValidator sets the global validator instance
func SetGlobalValidator(validator *Validator) {
	globalValidator = validator
}

// GetGlobalValidator returns the current global validator
func GetGlobalValidator() *Validator {
	return globalValidator
}

// ValidateEventWithContext validates an event using the global validator
func ValidateEventWithContext(ctx context.Context, event Event) error {
	return globalValidator.ValidateEvent(ctx, event)
}

// ValidateSequenceWithContext validates a sequence using the global validator
func ValidateSequenceWithContext(ctx context.Context, events []Event) error {
	return globalValidator.ValidateSequence(ctx, events)
}

// Common custom validators

// NewTimestampValidator creates a validator that checks timestamp ranges
func NewTimestampValidator(minTimestamp, maxTimestamp int64) CustomValidator {
	return func(ctx context.Context, event Event) error {
		timestamp := event.Timestamp()
		if timestamp == nil {
			return fmt.Errorf("timestamp is required")
		}
		if *timestamp < minTimestamp {
			return fmt.Errorf("timestamp %d is before minimum %d", *timestamp, minTimestamp)
		}
		if *timestamp > maxTimestamp {
			return fmt.Errorf("timestamp %d is after maximum %d", *timestamp, maxTimestamp)
		}
		return nil
	}
}

// NewEventTypeValidator creates a validator that restricts allowed event types
func NewEventTypeValidator(allowedTypes ...EventType) CustomValidator {
	allowedMap := make(map[EventType]bool)
	for _, t := range allowedTypes {
		allowedMap[t] = true
	}

	return func(ctx context.Context, event Event) error {
		if !allowedMap[event.Type()] {
			return fmt.Errorf("event type %s is not allowed", event.Type())
		}
		return nil
	}
}

// NewIDFormatValidator creates a validator that checks ID format patterns
func NewIDFormatValidator() CustomValidator {
	return func(ctx context.Context, event Event) error {
		switch event.Type() {
		case EventTypeRunStarted:
			if runEvent, ok := event.(*RunStartedEvent); ok {
				if !isValidIDFormat(runEvent.RunID, "run-") {
					return fmt.Errorf("invalid run ID format: %s", runEvent.RunID)
				}
				if !isValidIDFormat(runEvent.ThreadID, "thread-") {
					return fmt.Errorf("invalid thread ID format: %s", runEvent.ThreadID)
				}
			}
		case EventTypeTextMessageStart:
			if msgEvent, ok := event.(*TextMessageStartEvent); ok {
				if !isValidIDFormat(msgEvent.MessageID, "msg-") {
					return fmt.Errorf("invalid message ID format: %s", msgEvent.MessageID)
				}
			}
		case EventTypeToolCallStart:
			if toolEvent, ok := event.(*ToolCallStartEvent); ok {
				if !isValidIDFormat(toolEvent.ToolCallID, "tool-") {
					return fmt.Errorf("invalid tool call ID format: %s", toolEvent.ToolCallID)
				}
			}
		}
		return nil
	}
}

// isValidIDFormat checks if an ID follows the expected format
func isValidIDFormat(id, expectedPrefix string) bool {
	if id == "" {
		return false
	}
	// Check if the ID starts with the expected prefix
	return strings.HasPrefix(id, expectedPrefix)
}
