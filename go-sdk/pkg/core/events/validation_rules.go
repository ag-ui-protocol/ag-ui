package events

import (
	"fmt"
	"strings"
	"time"
)

// AddDefaultRules adds all default validation rules to the validator
func (v *EventValidator) AddDefaultRules() {
	// Core Protocol Rules
	v.AddRule(NewRunLifecycleRule())
	v.AddRule(NewEventOrderingRule())
	v.AddRule(NewEventSequenceRule())
	
	// Message Validation Rules
	v.AddRule(NewMessageLifecycleRule())
	v.AddRule(NewMessageContentRule())
	v.AddRule(NewMessageNestingRule())
	
	// Tool Call Validation Rules
	v.AddRule(NewToolCallLifecycleRule())
	v.AddRule(NewToolCallContentRule())
	v.AddRule(NewToolCallNestingRule())
	
	// ID Consistency Rules
	v.AddRule(NewIDConsistencyRule())
	v.AddRule(NewIDFormatRule())
	v.AddRule(NewIDUniquenessRule())
	
	// State Management Rules
	v.AddRule(NewStateValidationRule())
	v.AddRule(NewStateConsistencyRule())
	
	// Content Validation Rules
	v.AddRule(NewContentValidationRule())
	v.AddRule(NewTimestampValidationRule())
	
	// Custom Event Rules
	v.AddRule(NewCustomEventRule())
}

// RunLifecycleRule validates run lifecycle events
type RunLifecycleRule struct {
	*BaseValidationRule
}

func NewRunLifecycleRule() *RunLifecycleRule {
	return &RunLifecycleRule{
		BaseValidationRule: NewBaseValidationRule(
			"RUN_LIFECYCLE",
			"Validates run lifecycle events (start, finish, error)",
			ValidationSeverityError,
		),
	}
}

func (r *RunLifecycleRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeRunStarted:
		r.validateRunStarted(event, context, result)
	case EventTypeRunFinished:
		r.validateRunFinished(event, context, result)
	case EventTypeRunError:
		r.validateRunError(event, context, result)
	}
	
	return result
}

func (r *RunLifecycleRule) validateRunStarted(event Event, context *ValidationContext, result *ValidationResult) {
	runEvent, ok := event.(*RunStartedEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid run started event type", nil, nil))
		return
	}
	
	// Check if run is already started
	if _, exists := context.State.ActiveRuns[runEvent.RunID]; exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Run %s is already started", runEvent.RunID),
			map[string]interface{}{"run_id": runEvent.RunID},
			[]string{"Use a different run ID or finish the current run first"}))
	}
	
	// Check if run was already finished
	if _, exists := context.State.FinishedRuns[runEvent.RunID]; exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot restart finished run %s", runEvent.RunID),
			map[string]interface{}{"run_id": runEvent.RunID},
			[]string{"Use a different run ID for a new run"}))
	}
	
	// Validate required fields
	if runEvent.RunID == "" {
		result.AddError(r.CreateError(event, "Run ID is required", nil, 
			[]string{"Provide a unique run ID"}))
	}
	
	if runEvent.ThreadID == "" {
		result.AddError(r.CreateError(event, "Thread ID is required", nil, 
			[]string{"Provide a thread ID for the run"}))
	}
}

func (r *RunLifecycleRule) validateRunFinished(event Event, context *ValidationContext, result *ValidationResult) {
	runEvent, ok := event.(*RunFinishedEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid run finished event type", nil, nil))
		return
	}
	
	// Check if run is active
	if _, exists := context.State.ActiveRuns[runEvent.RunID]; !exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot finish run %s that was not started", runEvent.RunID),
			map[string]interface{}{"run_id": runEvent.RunID},
			[]string{"Start the run first with RUN_STARTED event"}))
	}
	
	// Validate required fields
	if runEvent.RunID == "" {
		result.AddError(r.CreateError(event, "Run ID is required", nil, 
			[]string{"Provide the run ID to finish"}))
	}
}

func (r *RunLifecycleRule) validateRunError(event Event, context *ValidationContext, result *ValidationResult) {
	runEvent, ok := event.(*RunErrorEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid run error event type", nil, nil))
		return
	}
	
	// Check if run is active (if run ID is provided)
	if runEvent.RunID != "" {
		if _, exists := context.State.ActiveRuns[runEvent.RunID]; !exists {
			result.AddError(r.CreateError(event, 
				fmt.Sprintf("Cannot error run %s that was not started", runEvent.RunID),
				map[string]interface{}{"run_id": runEvent.RunID},
				[]string{"Start the run first with RUN_STARTED event"}))
		}
	}
	
	// Validate required fields
	if runEvent.Message == "" {
		result.AddError(r.CreateError(event, "Error message is required", nil, 
			[]string{"Provide an error message describing what went wrong"}))
	}
}

// EventOrderingRule validates event ordering requirements
type EventOrderingRule struct {
	*BaseValidationRule
}

func NewEventOrderingRule() *EventOrderingRule {
	return &EventOrderingRule{
		BaseValidationRule: NewBaseValidationRule(
			"EVENT_ORDERING",
			"Validates proper event ordering according to AG-UI protocol",
			ValidationSeverityError,
		),
	}
}

func (r *EventOrderingRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Check if first event is RUN_STARTED
	if context.EventIndex == 0 && event.Type() != EventTypeRunStarted {
		result.AddError(r.CreateError(event, 
			"First event must be RUN_STARTED",
			map[string]interface{}{"actual_type": event.Type()},
			[]string{"Start the sequence with a RUN_STARTED event"}))
	}
	
	// Check for events after RUN_FINISHED
	if context.State.CurrentPhase == PhaseFinished && event.Type() != EventTypeRunError {
		result.AddError(r.CreateError(event, 
			"No events allowed after RUN_FINISHED except RUN_ERROR",
			map[string]interface{}{"event_type": event.Type()},
			[]string{"Do not send events after RUN_FINISHED"}))
	}
	
	return result
}

// EventSequenceRule validates event sequence requirements
type EventSequenceRule struct {
	*BaseValidationRule
}

func NewEventSequenceRule() *EventSequenceRule {
	return &EventSequenceRule{
		BaseValidationRule: NewBaseValidationRule(
			"EVENT_SEQUENCE",
			"Validates event sequence requirements and state transitions",
			ValidationSeverityError,
		),
	}
}

func (r *EventSequenceRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Validate step events
	switch event.Type() {
	case EventTypeStepStarted:
		r.validateStepStarted(event, context, result)
	case EventTypeStepFinished:
		r.validateStepFinished(event, context, result)
	}
	
	return result
}

func (r *EventSequenceRule) validateStepStarted(event Event, context *ValidationContext, result *ValidationResult) {
	stepEvent, ok := event.(*StepStartedEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid step started event type", nil, nil))
		return
	}
	
	// Check if step is already active
	if context.State.ActiveSteps[stepEvent.StepName] {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Step %s is already active", stepEvent.StepName),
			map[string]interface{}{"step_name": stepEvent.StepName},
			[]string{"Use a different step name or finish the current step first"}))
	}
	
	// Validate required fields
	if stepEvent.StepName == "" {
		result.AddError(r.CreateError(event, "Step name is required", nil, 
			[]string{"Provide a step name"}))
	}
}

func (r *EventSequenceRule) validateStepFinished(event Event, context *ValidationContext, result *ValidationResult) {
	stepEvent, ok := event.(*StepFinishedEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid step finished event type", nil, nil))
		return
	}
	
	// Check if step is active
	if !context.State.ActiveSteps[stepEvent.StepName] {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot finish step %s that was not started", stepEvent.StepName),
			map[string]interface{}{"step_name": stepEvent.StepName},
			[]string{"Start the step first with STEP_STARTED event"}))
	}
	
	// Validate required fields
	if stepEvent.StepName == "" {
		result.AddError(r.CreateError(event, "Step name is required", nil, 
			[]string{"Provide the step name to finish"}))
	}
}

// MessageLifecycleRule validates message lifecycle events
type MessageLifecycleRule struct {
	*BaseValidationRule
}

func NewMessageLifecycleRule() *MessageLifecycleRule {
	return &MessageLifecycleRule{
		BaseValidationRule: NewBaseValidationRule(
			"MESSAGE_LIFECYCLE",
			"Validates message lifecycle events (start, content, end)",
			ValidationSeverityError,
		),
	}
}

func (r *MessageLifecycleRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeTextMessageStart:
		r.validateMessageStart(event, context, result)
	case EventTypeTextMessageContent:
		r.validateMessageContent(event, context, result)
	case EventTypeTextMessageEnd:
		r.validateMessageEnd(event, context, result)
	}
	
	return result
}

func (r *MessageLifecycleRule) validateMessageStart(event Event, context *ValidationContext, result *ValidationResult) {
	msgEvent, ok := event.(*TextMessageStartEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid message start event type", nil, nil))
		return
	}
	
	// Check if message is already started
	if _, exists := context.State.ActiveMessages[msgEvent.MessageID]; exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Message %s is already started", msgEvent.MessageID),
			map[string]interface{}{"message_id": msgEvent.MessageID},
			[]string{"Use a different message ID or finish the current message first"}))
	}
	
	// Validate required fields
	if msgEvent.MessageID == "" {
		result.AddError(r.CreateError(event, "Message ID is required", nil, 
			[]string{"Provide a unique message ID"}))
	}
}

func (r *MessageLifecycleRule) validateMessageContent(event Event, context *ValidationContext, result *ValidationResult) {
	msgEvent, ok := event.(*TextMessageContentEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid message content event type", nil, nil))
		return
	}
	
	// Check if message is active
	if _, exists := context.State.ActiveMessages[msgEvent.MessageID]; !exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot add content to message %s that was not started", msgEvent.MessageID),
			map[string]interface{}{"message_id": msgEvent.MessageID},
			[]string{"Start the message first with TEXT_MESSAGE_START event"}))
	}
	
	// Validate required fields
	if msgEvent.MessageID == "" {
		result.AddError(r.CreateError(event, "Message ID is required", nil, 
			[]string{"Provide the message ID for the content"}))
	}
	
	if msgEvent.Delta == "" {
		result.AddError(r.CreateError(event, "Delta content is required", nil, 
			[]string{"Provide the content delta for the message"}))
	}
}

func (r *MessageLifecycleRule) validateMessageEnd(event Event, context *ValidationContext, result *ValidationResult) {
	msgEvent, ok := event.(*TextMessageEndEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid message end event type", nil, nil))
		return
	}
	
	// Check if message is active
	if _, exists := context.State.ActiveMessages[msgEvent.MessageID]; !exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot end message %s that was not started", msgEvent.MessageID),
			map[string]interface{}{"message_id": msgEvent.MessageID},
			[]string{"Start the message first with TEXT_MESSAGE_START event"}))
	}
	
	// Validate required fields
	if msgEvent.MessageID == "" {
		result.AddError(r.CreateError(event, "Message ID is required", nil, 
			[]string{"Provide the message ID to end"}))
	}
}

// MessageContentRule validates message content requirements
type MessageContentRule struct {
	*BaseValidationRule
}

func NewMessageContentRule() *MessageContentRule {
	return &MessageContentRule{
		BaseValidationRule: NewBaseValidationRule(
			"MESSAGE_CONTENT",
			"Validates message content requirements and formatting",
			ValidationSeverityWarning,
		),
	}
}

func (r *MessageContentRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	if event.Type() == EventTypeTextMessageContent {
		msgEvent, ok := event.(*TextMessageContentEvent)
		if !ok {
			return result
		}
		
		// Check for extremely long content
		if len(msgEvent.Delta) > 10000 {
			result.AddWarning(r.CreateError(event, 
				fmt.Sprintf("Message content delta is very long (%d characters)", len(msgEvent.Delta)),
				map[string]interface{}{"delta_length": len(msgEvent.Delta)},
				[]string{"Consider breaking long content into smaller chunks"}))
		}
		
		// Check for potential control characters
		if strings.ContainsAny(msgEvent.Delta, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F") {
			result.AddWarning(r.CreateError(event, 
				"Message content contains control characters",
				map[string]interface{}{"content": msgEvent.Delta},
				[]string{"Remove control characters from message content"}))
		}
	}
	
	return result
}

// MessageNestingRule validates message nesting requirements
type MessageNestingRule struct {
	*BaseValidationRule
}

func NewMessageNestingRule() *MessageNestingRule {
	return &MessageNestingRule{
		BaseValidationRule: NewBaseValidationRule(
			"MESSAGE_NESTING",
			"Validates message nesting and parent-child relationships",
			ValidationSeverityError,
		),
	}
}

func (r *MessageNestingRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Check parent message relationships
	switch event.Type() {
	case EventTypeTextMessageStart:
		// TextMessageStartEvent doesn't have ParentMessageID field
		// Skip parent message validation for this event type
	}
	
	return result
}

// ToolCallLifecycleRule validates tool call lifecycle events
type ToolCallLifecycleRule struct {
	*BaseValidationRule
}

func NewToolCallLifecycleRule() *ToolCallLifecycleRule {
	return &ToolCallLifecycleRule{
		BaseValidationRule: NewBaseValidationRule(
			"TOOL_CALL_LIFECYCLE",
			"Validates tool call lifecycle events (start, args, end)",
			ValidationSeverityError,
		),
	}
}

func (r *ToolCallLifecycleRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	switch event.Type() {
	case EventTypeToolCallStart:
		r.validateToolCallStart(event, context, result)
	case EventTypeToolCallArgs:
		r.validateToolCallArgs(event, context, result)
	case EventTypeToolCallEnd:
		r.validateToolCallEnd(event, context, result)
	}
	
	return result
}

func (r *ToolCallLifecycleRule) validateToolCallStart(event Event, context *ValidationContext, result *ValidationResult) {
	toolEvent, ok := event.(*ToolCallStartEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid tool call start event type", nil, nil))
		return
	}
	
	// Check if tool call is already started
	if _, exists := context.State.ActiveTools[toolEvent.ToolCallID]; exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Tool call %s is already started", toolEvent.ToolCallID),
			map[string]interface{}{"tool_call_id": toolEvent.ToolCallID},
			[]string{"Use a different tool call ID or finish the current tool call first"}))
	}
	
	// Validate required fields
	if toolEvent.ToolCallID == "" {
		result.AddError(r.CreateError(event, "Tool call ID is required", nil, 
			[]string{"Provide a unique tool call ID"}))
	}
	
	if toolEvent.ToolCallName == "" {
		result.AddError(r.CreateError(event, "Tool call name is required", nil, 
			[]string{"Provide the name of the tool being called"}))
	}
}

func (r *ToolCallLifecycleRule) validateToolCallArgs(event Event, context *ValidationContext, result *ValidationResult) {
	toolEvent, ok := event.(*ToolCallArgsEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid tool call args event type", nil, nil))
		return
	}
	
	// Check if tool call is active
	if _, exists := context.State.ActiveTools[toolEvent.ToolCallID]; !exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot add args to tool call %s that was not started", toolEvent.ToolCallID),
			map[string]interface{}{"tool_call_id": toolEvent.ToolCallID},
			[]string{"Start the tool call first with TOOL_CALL_START event"}))
	}
	
	// Validate required fields
	if toolEvent.ToolCallID == "" {
		result.AddError(r.CreateError(event, "Tool call ID is required", nil, 
			[]string{"Provide the tool call ID for the arguments"}))
	}
	
	if toolEvent.Delta == "" {
		result.AddError(r.CreateError(event, "Delta arguments are required", nil, 
			[]string{"Provide the arguments delta for the tool call"}))
	}
}

func (r *ToolCallLifecycleRule) validateToolCallEnd(event Event, context *ValidationContext, result *ValidationResult) {
	toolEvent, ok := event.(*ToolCallEndEvent)
	if !ok {
		result.AddError(r.CreateError(event, "Invalid tool call end event type", nil, nil))
		return
	}
	
	// Check if tool call is active
	if _, exists := context.State.ActiveTools[toolEvent.ToolCallID]; !exists {
		result.AddError(r.CreateError(event, 
			fmt.Sprintf("Cannot end tool call %s that was not started", toolEvent.ToolCallID),
			map[string]interface{}{"tool_call_id": toolEvent.ToolCallID},
			[]string{"Start the tool call first with TOOL_CALL_START event"}))
	}
	
	// Validate required fields
	if toolEvent.ToolCallID == "" {
		result.AddError(r.CreateError(event, "Tool call ID is required", nil, 
			[]string{"Provide the tool call ID to end"}))
	}
}

// ToolCallContentRule validates tool call content requirements
type ToolCallContentRule struct {
	*BaseValidationRule
}

func NewToolCallContentRule() *ToolCallContentRule {
	return &ToolCallContentRule{
		BaseValidationRule: NewBaseValidationRule(
			"TOOL_CALL_CONTENT",
			"Validates tool call content requirements and formatting",
			ValidationSeverityWarning,
		),
	}
}

func (r *ToolCallContentRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	if event.Type() == EventTypeToolCallArgs {
		toolEvent, ok := event.(*ToolCallArgsEvent)
		if !ok {
			return result
		}
		
		// Check for extremely long arguments
		if len(toolEvent.Delta) > 50000 {
			result.AddWarning(r.CreateError(event, 
				fmt.Sprintf("Tool call arguments delta is very long (%d characters)", len(toolEvent.Delta)),
				map[string]interface{}{"delta_length": len(toolEvent.Delta)},
				[]string{"Consider breaking long arguments into smaller chunks"}))
		}
	}
	
	return result
}

// ToolCallNestingRule validates tool call nesting requirements
type ToolCallNestingRule struct {
	*BaseValidationRule
}

func NewToolCallNestingRule() *ToolCallNestingRule {
	return &ToolCallNestingRule{
		BaseValidationRule: NewBaseValidationRule(
			"TOOL_CALL_NESTING",
			"Validates tool call nesting and parent-child relationships",
			ValidationSeverityError,
		),
	}
}

func (r *ToolCallNestingRule) Validate(event Event, context *ValidationContext) *ValidationResult {
	result := &ValidationResult{
		IsValid:   true,
		Timestamp: time.Now(),
	}
	
	if !r.IsEnabled() {
		return result
	}
	
	// Check parent message relationships for tool calls
	switch event.Type() {
	case EventTypeToolCallStart:
		toolEvent, ok := event.(*ToolCallStartEvent)
		if !ok {
			return result
		}
		
		// If parent message ID is provided, check if it exists
		if toolEvent.ParentMessageID != nil && *toolEvent.ParentMessageID != "" {
			found := false
			parentMsgID := *toolEvent.ParentMessageID
			// Check in active messages
			if _, exists := context.State.ActiveMessages[parentMsgID]; exists {
				found = true
			}
			// Check in finished messages
			if _, exists := context.State.FinishedMessages[parentMsgID]; exists {
				found = true
			}
			
			if !found {
				result.AddError(r.CreateError(event, 
					fmt.Sprintf("Parent message %s not found for tool call", parentMsgID),
					map[string]interface{}{"parent_message_id": parentMsgID},
					[]string{"Ensure the parent message exists before referencing it"}))
			}
		}
	}
	
	return result
}