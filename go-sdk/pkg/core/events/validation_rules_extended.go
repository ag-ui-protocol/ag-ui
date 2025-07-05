package events

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// IDConsistencyRule validates ID consistency across event triplets
type IDConsistencyRule struct {
	*BaseValidationRule
}

func NewIDConsistencyRule() *IDConsistencyRule {
	return &IDConsistencyRule{
		BaseValidationRule: NewBaseValidationRule(
			"ID_CONSISTENCY",
			"Validates ID consistency across start/args/end event triplets",
			ValidationSeverityError,
		),
	}
}

func (r *IDConsistencyRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// This rule requires access to the full event sequence for proper validation
	// It's mainly used during sequence validation rather than individual event validation
	
	return result
}

// IDFormatRule validates ID format patterns
type IDFormatRule struct {
	*BaseValidationRule
	runIDPattern     *regexp.Regexp
	threadIDPattern  *regexp.Regexp
	messageIDPattern *regexp.Regexp
	toolCallIDPattern *regexp.Regexp
}

func NewIDFormatRule() *IDFormatRule {
	return &IDFormatRule{
		BaseValidationRule: NewBaseValidationRule(
			"ID_FORMAT",
			"Validates ID format patterns for consistency",
			ValidationSeverityWarning,
		),
		runIDPattern:     regexp.MustCompile(`^[a-zA-Z0-9_-]+$`),
		threadIDPattern:  regexp.MustCompile(`^[a-zA-Z0-9_-]+$`),
		messageIDPattern: regexp.MustCompile(`^[a-zA-Z0-9_-]+$`),
		toolCallIDPattern: regexp.MustCompile(`^[a-zA-Z0-9_-]+$`),
	}
}

func (r *IDFormatRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeRunStarted:
		if runEvent, ok := event.(*RunStartedEvent); ok {
			if !r.runIDPattern.MatchString(runEvent.RunID) {
				result.AddWarning(r.CreateError(event, 
					fmt.Sprintf("Run ID '%s' does not match recommended format", runEvent.RunID),
					map[string]interface{}{"run_id": runEvent.RunID},
					[]string{"Use alphanumeric characters, hyphens, and underscores only"}))
			}
			if !r.threadIDPattern.MatchString(runEvent.ThreadID) {
				result.AddWarning(r.CreateError(event, 
					fmt.Sprintf("Thread ID '%s' does not match recommended format", runEvent.ThreadID),
					map[string]interface{}{"thread_id": runEvent.ThreadID},
					[]string{"Use alphanumeric characters, hyphens, and underscores only"}))
			}
		}
		
	case EventTypeTextMessageStart:
		if msgEvent, ok := event.(*TextMessageStartEvent); ok {
			if !r.messageIDPattern.MatchString(msgEvent.MessageID) {
				result.AddWarning(r.CreateError(event, 
					fmt.Sprintf("Message ID '%s' does not match recommended format", msgEvent.MessageID),
					map[string]interface{}{"message_id": msgEvent.MessageID},
					[]string{"Use alphanumeric characters, hyphens, and underscores only"}))
			}
		}
		
	case EventTypeToolCallStart:
		if toolEvent, ok := event.(*ToolCallStartEvent); ok {
			if !r.toolCallIDPattern.MatchString(toolEvent.ToolCallID) {
				result.AddWarning(r.CreateError(event, 
					fmt.Sprintf("Tool call ID '%s' does not match recommended format", toolEvent.ToolCallID),
					map[string]interface{}{"tool_call_id": toolEvent.ToolCallID},
					[]string{"Use alphanumeric characters, hyphens, and underscores only"}))
			}
		}
	}
	
	return result
}

// IDUniquenessRule validates ID uniqueness within scope
type IDUniquenessRule struct {
	*BaseValidationRule
}

func NewIDUniquenessRule() *IDUniquenessRule {
	return &IDUniquenessRule{
		BaseValidationRule: NewBaseValidationRule(
			"ID_UNIQUENESS",
			"Validates ID uniqueness within appropriate scope",
			ValidationSeverityError,
		),
	}
}

func (r *IDUniquenessRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Check for duplicate IDs within the same scope
	switch event.Type() {
	case EventTypeRunStarted:
		if runEvent, ok := event.(*RunStartedEvent); ok {
			// Check if run ID is already used
			if _, exists := context.State.ActiveRuns[runEvent.RunID]; exists {
				result.AddError(r.CreateError(event, 
					fmt.Sprintf("Run ID '%s' is already in use", runEvent.RunID),
					map[string]interface{}{"run_id": runEvent.RunID},
					[]string{"Use a unique run ID"}))
			}
		}
		
	case EventTypeTextMessageStart:
		if msgEvent, ok := event.(*TextMessageStartEvent); ok {
			// Check if message ID is already used
			if _, exists := context.State.ActiveMessages[msgEvent.MessageID]; exists {
				result.AddError(r.CreateError(event, 
					fmt.Sprintf("Message ID '%s' is already in use", msgEvent.MessageID),
					map[string]interface{}{"message_id": msgEvent.MessageID},
					[]string{"Use a unique message ID"}))
			}
		}
		
	case EventTypeToolCallStart:
		if toolEvent, ok := event.(*ToolCallStartEvent); ok {
			// Check if tool call ID is already used
			if _, exists := context.State.ActiveTools[toolEvent.ToolCallID]; exists {
				result.AddError(r.CreateError(event, 
					fmt.Sprintf("Tool call ID '%s' is already in use", toolEvent.ToolCallID),
					map[string]interface{}{"tool_call_id": toolEvent.ToolCallID},
					[]string{"Use a unique tool call ID"}))
			}
		}
	}
	
	return result
}

// StateValidationRule validates state-related events
type StateValidationRule struct {
	*BaseValidationRule
}

func NewStateValidationRule() *StateValidationRule {
	return &StateValidationRule{
		BaseValidationRule: NewBaseValidationRule(
			"STATE_VALIDATION",
			"Validates state snapshot and delta events",
			ValidationSeverityError,
		),
	}
}

func (r *StateValidationRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeStateSnapshot:
		r.validateStateSnapshot(event, context, result)
	case EventTypeStateDelta:
		r.validateStateDelta(event, context, result)
	case EventTypeMessagesSnapshot:
		r.validateMessagesSnapshot(event, context, result)
	}
	
	return result
}

func (r *StateValidationRule) validateStateSnapshot(event Event, context *ValidationContext, result *ValidationResult) {
	stateEvent, ok := event.(*StateSnapshotEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid state snapshot event type", nil, nil))
		return
	}
	
	// Validate that snapshot is not nil
	if stateEvent.Snapshot == nil {
		result.AddError(r.CreateError(event, "State snapshot cannot be nil", nil, 
			[]string{"Provide a valid state snapshot"}))
		return
	}
	
	// Validate that snapshot is valid JSON
	if _, err := json.Marshal(stateEvent.Snapshot); err != nil {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("State snapshot is not valid JSON: %v", err),
			map[string]interface{}{"error": err.Error()},
			[]string{"Ensure the state snapshot is valid JSON"}))
	}
}

func (r *StateValidationRule) validateStateDelta(event Event, context *ValidationContext, result *ValidationResult) {
	deltaEvent, ok := event.(*StateDeltaEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid state delta event type", nil, nil))
		return
	}
	
	// Validate that delta operations exist
	if len(deltaEvent.Delta) == 0 {
		result.AddError(r.CreateError(event, "State delta must contain at least one operation", nil, 
			[]string{"Provide at least one JSON Patch operation"}))
		return
	}
	
	// Validate each operation
	for i, op := range deltaEvent.Delta {
		if op.Op == "" {
			result.AddError(r.CreateError(event, 
				fmt.Sprintf("Delta operation %d is missing 'op' field", i),
				map[string]interface{}{"operation_index": i},
				[]string{"Provide a valid JSON Patch operation type (add, remove, replace, move, copy, test)"}))
		}
		
		if op.Path == "" {
			result.AddError(r.CreateError(event, 
				fmt.Sprintf("Delta operation %d is missing 'path' field", i),
				map[string]interface{}{"operation_index": i},
				[]string{"Provide a valid JSON Patch path"}))
		}
		
		// Validate path format
		if !strings.HasPrefix(op.Path, "/") {
			result.AddError(r.CreateError(event, 
				fmt.Sprintf("Delta operation %d path must start with '/'", i),
				map[string]interface{}{"operation_index": i, "path": op.Path},
				[]string{"JSON Patch paths must start with '/"}))
		}
	}
}

func (r *StateValidationRule) validateMessagesSnapshot(event Event, context *ValidationContext, result *ValidationResult) {
	msgEvent, ok := event.(*MessagesSnapshotEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid messages snapshot event type", nil, nil))
		return
	}
	
	// Validate message structure
	for i, msg := range msgEvent.Messages {
		if msg.Role == "" {
			result.AddError(r.CreateError(event, 
				fmt.Sprintf("Message %d is missing role field", i),
				map[string]interface{}{"message_index": i},
				[]string{"Provide a valid role for the message"}))
		}
		
		// Validate role values
		validRoles := []string{"user", "assistant", "system", "tool", "developer"}
		roleValid := false
		for _, validRole := range validRoles {
			if msg.Role == validRole {
				roleValid = true
				break
			}
		}
		
		if !roleValid {
			result.AddWarning(r.CreateError(event, 
				fmt.Sprintf("Message %d has non-standard role '%s'", i, msg.Role),
				map[string]interface{}{"message_index": i, "role": msg.Role},
				[]string{"Use standard roles: user, assistant, system, tool, developer"}))
		}
		
		// Validate tool calls in assistant messages
		if msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			for j, toolCall := range msg.ToolCalls {
				if toolCall.ID == "" {
					result.AddError(r.CreateError(event, 
						fmt.Sprintf("Tool call %d in message %d is missing ID", j, i),
						map[string]interface{}{"message_index": i, "tool_call_index": j},
						[]string{"Provide a valid ID for the tool call"}))
				}
				
				if toolCall.Type == "" {
					result.AddError(r.CreateError(event, 
						fmt.Sprintf("Tool call %d in message %d is missing type", j, i),
						map[string]interface{}{"message_index": i, "tool_call_index": j},
						[]string{"Provide a valid type for the tool call"}))
				}
				
				if toolCall.Function.Name == "" {
					result.AddError(r.CreateError(event, 
						fmt.Sprintf("Tool call %d in message %d is missing function name", j, i),
						map[string]interface{}{"message_index": i, "tool_call_index": j},
						[]string{"Provide a valid function name for the tool call"}))
				}
			}
		}
	}
}

// StateConsistencyRule validates state consistency
type StateConsistencyRule struct {
	*BaseValidationRule
}

func NewStateConsistencyRule() *StateConsistencyRule {
	return &StateConsistencyRule{
		BaseValidationRule: NewBaseValidationRule(
			"STATE_CONSISTENCY",
			"Validates state consistency across events",
			ValidationSeverityWarning,
		),
	}
}

func (r *StateConsistencyRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// This rule would typically perform more complex consistency checks
	// For now, we'll add basic validations
	
	return result
}

// ContentValidationRule validates content requirements
type ContentValidationRule struct {
	*BaseValidationRule
}

func NewContentValidationRule() *ContentValidationRule {
	return &ContentValidationRule{
		BaseValidationRule: NewBaseValidationRule(
			"CONTENT_VALIDATION",
			"Validates content requirements and safety",
			ValidationSeverityWarning,
		),
	}
}

func (r *ContentValidationRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Check for potentially unsafe content patterns
	switch event.Type() {
	case EventTypeTextMessageContent:
		if msgEvent, ok := event.(*TextMessageContentEvent); ok {
			r.validateTextContent(msgEvent.Delta, event, result)
		}
		
	case EventTypeToolCallArgs:
		if toolEvent, ok := event.(*ToolCallArgsEvent); ok {
			r.validateTextContent(toolEvent.Delta, event, result)
		}
		
	case EventTypeRaw:
		if rawEvent, ok := event.(*RawEvent); ok {
			// Validate raw event structure
			if rawEvent.Event == nil {
				result.AddError(r.CreateError(event, "Raw event data cannot be nil", nil, 
					[]string{"Provide valid raw event data"}))
			}
		}
	}
	
	return result
}

func (r *ContentValidationRule) validateTextContent(content string, event Event, result *ValidationResult) {
	// Check for null bytes
	if strings.Contains(content, "\x00") {
		result.AddWarning(r.CreateError(event, 
			"Content contains null bytes",
			map[string]interface{}{"content_length": len(content)},
			[]string{"Remove null bytes from content"}))
	}
	
	// Check for extremely long single lines
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if len(line) > 1000 {
			result.AddWarning(r.CreateError(event, 
				fmt.Sprintf("Line %d is extremely long (%d characters)", i+1, len(line)),
				map[string]interface{}{"line_number": i + 1, "line_length": len(line)},
				[]string{"Consider breaking long lines for better readability"}))
		}
	}
	
	// Check for potential security issues
	if strings.Contains(strings.ToLower(content), "javascript:") {
		result.AddWarning(r.CreateError(event, 
			"Content contains potential JavaScript URI",
			nil,
			[]string{"Be cautious with JavaScript URIs in content"}))
	}
}

// TimestampValidationRule validates timestamp requirements
type TimestampValidationRule struct {
	*BaseValidationRule
}

func NewTimestampValidationRule() *TimestampValidationRule {
	return &TimestampValidationRule{
		BaseValidationRule: NewBaseValidationRule(
			"TIMESTAMP_VALIDATION",
			"Validates timestamp requirements and consistency",
			ValidationSeverityWarning,
		),
	}
}

func (r *TimestampValidationRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	timestamp := event.Timestamp()
	if timestamp == nil {
		result.AddWarning(r.CreateError(event, "Event is missing timestamp", nil, 
			[]string{"Provide a timestamp for the event"}))
		return result
	}
	
	// Check if timestamp is reasonable
	now := time.Now().UnixMilli()
	eventTime := *timestamp
	
	// Check for events in the future
	if eventTime > now+5000 { // Allow 5 seconds tolerance
		result.AddWarning(r.CreateError(event, 
			"Event timestamp is in the future",
			map[string]interface{}{"event_time": eventTime, "current_time": now},
			[]string{"Ensure event timestamps are not in the future"}))
	}
	
	// Check for very old events
	if eventTime < now-86400000 { // 24 hours ago
		result.AddWarning(r.CreateError(event, 
			"Event timestamp is very old (more than 24 hours)",
			map[string]interface{}{"event_time": eventTime, "current_time": now},
			[]string{"Ensure event timestamps are reasonably recent"}))
	}
	
	// Check timestamp ordering within sequence
	if context.State.LastEventTime.UnixMilli() > eventTime {
		result.AddWarning(r.CreateError(event, 
			"Event timestamp is earlier than previous event",
			map[string]interface{}{
				"event_time": eventTime, 
				"previous_time": context.State.LastEventTime.UnixMilli(),
			},
			[]string{"Ensure events are in chronological order"}))
	}
	
	return result
}

// CustomEventRule validates custom and raw events
type CustomEventRule struct {
	*BaseValidationRule
}

func NewCustomEventRule() *CustomEventRule {
	return &CustomEventRule{
		BaseValidationRule: NewBaseValidationRule(
			"CUSTOM_EVENT",
			"Validates custom and raw events",
			ValidationSeverityWarning,
		),
	}
}

func (r *CustomEventRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeCustom:
		if customEvent, ok := event.(*CustomEvent); ok {
			// Validate custom event structure
			if customEvent.Name == "" {
				result.AddError(r.CreateError(event, "Custom event name is required", nil, 
					[]string{"Provide a name for the custom event"}))
			}
			
			// Check for reserved names
			reservedNames := []string{"system", "internal", "reserved", "ag-ui"}
			for _, reserved := range reservedNames {
				if strings.ToLower(customEvent.Name) == reserved {
					result.AddWarning(r.CreateError(event, 
						fmt.Sprintf("Custom event name '%s' is reserved", customEvent.Name),
						map[string]interface{}{"name": customEvent.Name},
						[]string{"Use a different name for the custom event"}))
				}
			}
			
			// Validate custom event value
			if customEvent.Value != nil {
				if _, err := json.Marshal(customEvent.Value); err != nil {
					result.AddError(r.CreateError(event, 
						fmt.Sprintf("Custom event value is not valid JSON: %v", err),
						map[string]interface{}{"error": err.Error()},
						[]string{"Ensure the custom event value is valid JSON"}))
				}
			}
		}
		
	case EventTypeRaw:
		if rawEvent, ok := event.(*RawEvent); ok {
			// Validate raw event structure
			if rawEvent.Event == nil {
				result.AddError(r.CreateError(event, "Raw event data cannot be nil", nil, 
					[]string{"Provide valid raw event data"}))
			}
		}
	}
	
	return result
}