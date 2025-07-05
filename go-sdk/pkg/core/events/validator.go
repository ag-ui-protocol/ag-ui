package events

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// ValidationSeverity defines the severity level of validation errors
type ValidationSeverity int

const (
	ValidationSeverityError ValidationSeverity = iota
	ValidationSeverityWarning
	ValidationSeverityInfo
)

func (s ValidationSeverity) String() string {
	switch s {
	case ValidationSeverityError:
		return "ERROR"
	case ValidationSeverityWarning:
		return "WARNING"
	case ValidationSeverityInfo:
		return "INFO"
	default:
		return "UNKNOWN"
	}
}

// ValidationError represents a validation error with context
type ValidationError struct {
	RuleID      string                 `json:"rule_id"`
	EventID     string                 `json:"event_id,omitempty"`
	EventType   EventType              `json:"event_type"`
	Message     string                 `json:"message"`
	Severity    ValidationSeverity     `json:"severity"`
	Context     map[string]interface{} `json:"context,omitempty"`
	Suggestions []string               `json:"suggestions,omitempty"`
	Timestamp   time.Time              `json:"timestamp"`
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("[%s] %s: %s", e.Severity, e.RuleID, e.Message)
}

// ValidationResult represents the result of validation
type ValidationResult struct {
	IsValid     bool                `json:"is_valid"`
	Errors      []*ValidationError  `json:"errors,omitempty"`
	Warnings    []*ValidationError  `json:"warnings,omitempty"`
	Information []*ValidationError  `json:"information,omitempty"`
	EventCount  int                 `json:"event_count"`
	Duration    time.Duration       `json:"duration"`
	Timestamp   time.Time           `json:"timestamp"`
}

// HasErrors returns true if there are any validation errors
func (r *ValidationResult) HasErrors() bool {
	return len(r.Errors) > 0
}

// HasWarnings returns true if there are any validation warnings
func (r *ValidationResult) HasWarnings() bool {
	return len(r.Warnings) > 0
}

// AddError adds a validation error to the result
func (r *ValidationResult) AddError(err *ValidationError) {
	r.Errors = append(r.Errors, err)
	r.IsValid = false
}

// AddWarning adds a validation warning to the result
func (r *ValidationResult) AddWarning(warning *ValidationError) {
	r.Warnings = append(r.Warnings, warning)
}

// AddInfo adds a validation info to the result
func (r *ValidationResult) AddInfo(info *ValidationError) {
	r.Information = append(r.Information, info)
}

// ValidationRule defines an interface for validation rules
type ValidationRule interface {
	// ID returns the unique identifier for this rule
	ID() string
	
	// Description returns a human-readable description of the rule
	Description() string
	
	// Validate validates an event against this rule
	Validate(event Event, context *ValidationContext) *ValidationResult
	
	// IsEnabled returns whether this rule is enabled
	IsEnabled() bool
	
	// SetEnabled enables or disables this rule
	SetEnabled(enabled bool)
	
	// GetSeverity returns the severity level for violations of this rule
	GetSeverity() ValidationSeverity
	
	// SetSeverity sets the severity level for violations of this rule
	SetSeverity(severity ValidationSeverity)
}

// BaseValidationRule provides common functionality for validation rules
type BaseValidationRule struct {
	id          string
	description string
	enabled     bool
	severity    ValidationSeverity
	mutex       sync.RWMutex
}

// NewBaseValidationRule creates a new base validation rule
func NewBaseValidationRule(id, description string, severity ValidationSeverity) *BaseValidationRule {
	return &BaseValidationRule{
		id:          id,
		description: description,
		enabled:     true,
		severity:    severity,
	}
}

// ID returns the rule ID
func (r *BaseValidationRule) ID() string {
	return r.id
}

// Description returns the rule description
func (r *BaseValidationRule) Description() string {
	return r.description
}

// IsEnabled returns whether the rule is enabled
func (r *BaseValidationRule) IsEnabled() bool {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.enabled
}

// SetEnabled enables or disables the rule
func (r *BaseValidationRule) SetEnabled(enabled bool) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.enabled = enabled
}

// GetSeverity returns the rule severity
func (r *BaseValidationRule) GetSeverity() ValidationSeverity {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.severity
}

// SetSeverity sets the rule severity
func (r *BaseValidationRule) SetSeverity(severity ValidationSeverity) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.severity = severity
}

// CreateError creates a validation error for this rule
func (r *BaseValidationRule) CreateError(event Event, message string, context map[string]interface{}, suggestions []string) *ValidationError {
	eventID := ""
	// BaseEvent doesn't have EventID field, so we'll leave it empty for now
	// Individual event types can override this if they have IDs

	return &ValidationError{
		RuleID:      r.id,
		EventID:     eventID,
		EventType:   event.Type(),
		Message:     message,
		Severity:    r.severity,
		Context:     context,
		Suggestions: suggestions,
		Timestamp:   time.Now(),
	}
}

// EventPhase represents the current phase of event processing
type EventPhase int

const (
	PhaseInit EventPhase = iota
	PhaseRunning
	PhaseFinished
	PhaseError
)

func (p EventPhase) String() string {
	switch p {
	case PhaseInit:
		return "INIT"
	case PhaseRunning:
		return "RUNNING"
	case PhaseFinished:
		return "FINISHED"
	case PhaseError:
		return "ERROR"
	default:
		return "UNKNOWN"
	}
}

// RunState tracks the state of a specific run
type RunState struct {
	RunID     string    `json:"run_id"`
	ThreadID  string    `json:"thread_id"`
	StartTime time.Time `json:"start_time"`
	Phase     EventPhase `json:"phase"`
	StepCount int       `json:"step_count"`
}

// MessageState tracks the state of a specific message
type MessageState struct {
	MessageID    string    `json:"message_id"`
	ParentMsgID  string    `json:"parent_msg_id,omitempty"`
	StartTime    time.Time `json:"start_time"`
	ContentCount int       `json:"content_count"`
	IsActive     bool      `json:"is_active"`
}

// ToolState tracks the state of a specific tool call
type ToolState struct {
	ToolCallID   string    `json:"tool_call_id"`
	ParentMsgID  string    `json:"parent_msg_id,omitempty"`
	ToolName     string    `json:"tool_name"`
	StartTime    time.Time `json:"start_time"`
	ArgsCount    int       `json:"args_count"`
	IsActive     bool      `json:"is_active"`
}

// ValidationState tracks the current state of validation
type ValidationState struct {
	CurrentPhase     EventPhase                `json:"current_phase"`
	ActiveRuns       map[string]*RunState      `json:"active_runs"`
	FinishedRuns     map[string]*RunState      `json:"finished_runs"`
	ActiveMessages   map[string]*MessageState  `json:"active_messages"`
	FinishedMessages map[string]*MessageState  `json:"finished_messages"`
	ActiveTools      map[string]*ToolState     `json:"active_tools"`
	FinishedTools    map[string]*ToolState     `json:"finished_tools"`
	ActiveSteps      map[string]bool           `json:"active_steps"`
	EventCount       int                       `json:"event_count"`
	LastEventTime    time.Time                 `json:"last_event_time"`
	StartTime        time.Time                 `json:"start_time"`
	
	// Thread safety
	mutex sync.RWMutex
}

// NewValidationState creates a new validation state
func NewValidationState() *ValidationState {
	return &ValidationState{
		CurrentPhase:     PhaseInit,
		ActiveRuns:       make(map[string]*RunState),
		FinishedRuns:     make(map[string]*RunState),
		ActiveMessages:   make(map[string]*MessageState),
		FinishedMessages: make(map[string]*MessageState),
		ActiveTools:      make(map[string]*ToolState),
		FinishedTools:    make(map[string]*ToolState),
		ActiveSteps:      make(map[string]bool),
		StartTime:        time.Now(),
	}
}

// ValidationContext provides context for validation operations
type ValidationContext struct {
	State         *ValidationState   `json:"state"`
	EventSequence []Event            `json:"event_sequence,omitempty"`
	CurrentEvent  Event              `json:"current_event,omitempty"`
	EventIndex    int                `json:"event_index"`
	Config        *ValidationConfig  `json:"config,omitempty"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
}

// ValidationMetrics tracks performance metrics for validation
type ValidationMetrics struct {
	EventsProcessed     int64         `json:"events_processed"`
	ValidationDuration  time.Duration `json:"validation_duration"`
	AverageEventLatency time.Duration `json:"average_event_latency"`
	ErrorCount          int64         `json:"error_count"`
	WarningCount        int64         `json:"warning_count"`
	RuleExecutionTimes  map[string]time.Duration `json:"rule_execution_times"`
	StartTime           time.Time     `json:"start_time"`
	
	// Thread safety
	mutex sync.RWMutex
}

// NewValidationMetrics creates new validation metrics
func NewValidationMetrics() *ValidationMetrics {
	return &ValidationMetrics{
		RuleExecutionTimes: make(map[string]time.Duration),
		StartTime:          time.Now(),
	}
}

// RecordEvent records processing of an event
func (m *ValidationMetrics) RecordEvent(duration time.Duration) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	
	m.EventsProcessed++
	m.ValidationDuration += duration
	
	if m.EventsProcessed > 0 {
		m.AverageEventLatency = m.ValidationDuration / time.Duration(m.EventsProcessed)
	}
}

// RecordError records a validation error
func (m *ValidationMetrics) RecordError() {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.ErrorCount++
}

// RecordWarning records a validation warning
func (m *ValidationMetrics) RecordWarning() {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.WarningCount++
}

// RecordRuleExecution records execution time for a specific rule
func (m *ValidationMetrics) RecordRuleExecution(ruleID string, duration time.Duration) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.RuleExecutionTimes[ruleID] += duration
}

// EventValidator provides comprehensive event validation
type EventValidator struct {
	rules   []ValidationRule
	state   *ValidationState
	metrics *ValidationMetrics
	config  *ValidationConfig
	mutex   sync.RWMutex
}

// NewEventValidator creates a new event validator
func NewEventValidator(config *ValidationConfig) *EventValidator {
	if config == nil {
		config = DefaultValidationConfig()
	}
	
	validator := &EventValidator{
		rules:   make([]ValidationRule, 0),
		state:   NewValidationState(),
		metrics: NewValidationMetrics(),
		config:  config,
	}
	
	// Add default rules
	validator.AddDefaultRules()
	
	return validator
}

// AddRule adds a validation rule
func (v *EventValidator) AddRule(rule ValidationRule) {
	v.mutex.Lock()
	defer v.mutex.Unlock()
	v.rules = append(v.rules, rule)
}

// RemoveRule removes a validation rule by ID
func (v *EventValidator) RemoveRule(ruleID string) bool {
	v.mutex.Lock()
	defer v.mutex.Unlock()
	
	for i, rule := range v.rules {
		if rule.ID() == ruleID {
			v.rules = append(v.rules[:i], v.rules[i+1:]...)
			return true
		}
	}
	return false
}

// GetRule gets a validation rule by ID
func (v *EventValidator) GetRule(ruleID string) ValidationRule {
	v.mutex.RLock()
	defer v.mutex.RUnlock()
	
	for _, rule := range v.rules {
		if rule.ID() == ruleID {
			return rule
		}
	}
	return nil
}

// GetRules returns all validation rules
func (v *EventValidator) GetRules() []ValidationRule {
	v.mutex.RLock()
	defer v.mutex.RUnlock()
	
	rules := make([]ValidationRule, len(v.rules))
	copy(rules, v.rules)
	return rules
}

// ValidateEvent validates a single event
func (v *EventValidator) ValidateEvent(ctx context.Context, event Event) *ValidationResult {
	start := time.Now()
	defer func() {
		duration := time.Since(start)
		v.metrics.RecordEvent(duration)
	}()

	result := &ValidationResult{
		IsValid:   true,
		Errors:    make([]*ValidationError, 0),
		Warnings:  make([]*ValidationError, 0),
		EventCount: 1,
		Timestamp: time.Now(),
	}

	if event == nil {
		result.AddError(&ValidationError{
			RuleID:    "NULL_EVENT",
			Message:   "Event cannot be nil",
			Severity:  ValidationSeverityError,
			Timestamp: time.Now(),
		})
		return result
	}

	// Create validation context (before updating state)
	validationContext := &ValidationContext{
		State:        v.state,
		CurrentEvent: event,
		EventIndex:   0,
		Config:       v.config,
		Metadata:     make(map[string]interface{}),
	}

	// Apply validation rules
	v.mutex.RLock()
	rules := make([]ValidationRule, len(v.rules))
	copy(rules, v.rules)
	v.mutex.RUnlock()

	for _, rule := range rules {
		if !rule.IsEnabled() {
			continue
		}

		ruleStart := time.Now()
		ruleResult := rule.Validate(event, validationContext)
		ruleDuration := time.Since(ruleStart)
		
		v.metrics.RecordRuleExecution(rule.ID(), ruleDuration)

		if ruleResult != nil {
			// Add errors
			for _, err := range ruleResult.Errors {
				result.AddError(err)
				v.metrics.RecordError()
			}
			
			// Add warnings
			for _, warning := range ruleResult.Warnings {
				result.AddWarning(warning)
				v.metrics.RecordWarning()
			}
			
			// Add information
			for _, info := range ruleResult.Information {
				result.AddInfo(info)
			}
		}
	}

	// Update state only after successful validation
	if result.IsValid {
		v.updateState(event)
	}

	result.Duration = time.Since(start)
	return result
}

// ValidateSequence validates a sequence of events
func (v *EventValidator) ValidateSequence(ctx context.Context, events []Event) *ValidationResult {
	start := time.Now()
	
	result := &ValidationResult{
		IsValid:    true,
		Errors:     make([]*ValidationError, 0),
		Warnings:   make([]*ValidationError, 0),
		EventCount: len(events),
		Timestamp:  time.Now(),
	}

	if len(events) == 0 {
		result.Duration = time.Since(start)
		return result
	}

	// Reset state for sequence validation
	v.state = NewValidationState()

	// Create validation context for sequence
	validationContext := &ValidationContext{
		State:         v.state,
		EventSequence: events,
		Config:        v.config,
		Metadata:      make(map[string]interface{}),
	}

	// Validate each event in sequence
	for i, event := range events {
		validationContext.CurrentEvent = event
		validationContext.EventIndex = i
		
		// Validate the event using the sequence context
		eventResult := v.validateEventWithContext(ctx, event, validationContext)
		
		// Merge results
		for _, err := range eventResult.Errors {
			result.AddError(err)
		}
		for _, warning := range eventResult.Warnings {
			result.AddWarning(warning)
		}
		for _, info := range eventResult.Information {
			result.AddInfo(info)
		}
	}

	result.Duration = time.Since(start)
	return result
}

// validateEventWithContext validates an event with a specific validation context
func (v *EventValidator) validateEventWithContext(ctx context.Context, event Event, validationContext *ValidationContext) *ValidationResult {
	start := time.Now()
	defer func() {
		duration := time.Since(start)
		v.metrics.RecordEvent(duration)
	}()

	result := &ValidationResult{
		IsValid:   true,
		Errors:    make([]*ValidationError, 0),
		Warnings:  make([]*ValidationError, 0),
		EventCount: 1,
		Timestamp: time.Now(),
	}

	if event == nil {
		result.AddError(&ValidationError{
			RuleID:    "NULL_EVENT",
			Message:   "Event cannot be nil",
			Severity:  ValidationSeverityError,
			Timestamp: time.Now(),
		})
		return result
	}

	// Apply validation rules using the provided context (validate before updating state)
	v.mutex.RLock()
	rules := make([]ValidationRule, len(v.rules))
	copy(rules, v.rules)
	v.mutex.RUnlock()

	for _, rule := range rules {
		if !rule.IsEnabled() {
			continue
		}

		ruleStart := time.Now()
		ruleResult := rule.Validate(event, validationContext)
		ruleDuration := time.Since(ruleStart)
		
		v.metrics.RecordRuleExecution(rule.ID(), ruleDuration)

		if ruleResult != nil {
			// Add errors
			for _, err := range ruleResult.Errors {
				result.AddError(err)
				v.metrics.RecordError()
			}
			
			// Add warnings
			for _, warning := range ruleResult.Warnings {
				result.AddWarning(warning)
				v.metrics.RecordWarning()
			}
			
			// Add information
			for _, info := range ruleResult.Information {
				result.AddInfo(info)
			}
		}
	}

	// Update state only after successful validation
	if result.IsValid {
		v.updateState(event)
	}

	result.Duration = time.Since(start)
	return result
}

// GetState returns the current validation state
func (v *EventValidator) GetState() *ValidationState {
	v.state.mutex.RLock()
	defer v.state.mutex.RUnlock()
	
	// Return a copy to prevent external modification
	stateCopy := *v.state
	return &stateCopy
}

// GetMetrics returns the validation metrics
func (v *EventValidator) GetMetrics() *ValidationMetrics {
	v.metrics.mutex.RLock()
	defer v.metrics.mutex.RUnlock()
	
	// Return a copy to prevent external modification
	metricsCopy := *v.metrics
	return &metricsCopy
}

// Reset resets the validator state
func (v *EventValidator) Reset() {
	v.state = NewValidationState()
	v.metrics = NewValidationMetrics()
}

// updateState updates the validation state based on the event
func (v *EventValidator) updateState(event Event) {
	v.state.mutex.Lock()
	defer v.state.mutex.Unlock()
	
	v.state.EventCount++
	v.state.LastEventTime = time.Now()
	
	switch event.Type() {
	case EventTypeRunStarted:
		if runEvent, ok := event.(*RunStartedEvent); ok {
			v.state.CurrentPhase = PhaseRunning
			v.state.ActiveRuns[runEvent.RunID] = &RunState{
				RunID:     runEvent.RunID,
				ThreadID:  runEvent.ThreadID,
				StartTime: time.Now(),
				Phase:     PhaseRunning,
			}
		}
		
	case EventTypeRunFinished:
		if runEvent, ok := event.(*RunFinishedEvent); ok {
			v.state.CurrentPhase = PhaseFinished
			if runState, exists := v.state.ActiveRuns[runEvent.RunID]; exists {
				runState.Phase = PhaseFinished
				v.state.FinishedRuns[runEvent.RunID] = runState
				delete(v.state.ActiveRuns, runEvent.RunID)
			}
		}
		
	case EventTypeRunError:
		if runEvent, ok := event.(*RunErrorEvent); ok {
			v.state.CurrentPhase = PhaseError
			if runState, exists := v.state.ActiveRuns[runEvent.RunID]; exists {
				runState.Phase = PhaseError
				v.state.FinishedRuns[runEvent.RunID] = runState
				delete(v.state.ActiveRuns, runEvent.RunID)
			}
		}
		
	case EventTypeStepStarted:
		if stepEvent, ok := event.(*StepStartedEvent); ok {
			v.state.ActiveSteps[stepEvent.StepName] = true
			// Update step count for active runs
			for _, runState := range v.state.ActiveRuns {
				runState.StepCount++
			}
		}
		
	case EventTypeStepFinished:
		if stepEvent, ok := event.(*StepFinishedEvent); ok {
			delete(v.state.ActiveSteps, stepEvent.StepName)
		}
		
	case EventTypeTextMessageStart:
		if msgEvent, ok := event.(*TextMessageStartEvent); ok {
			parentMsgID := ""
			// TextMessageStartEvent doesn't have ParentMessageID field
			v.state.ActiveMessages[msgEvent.MessageID] = &MessageState{
				MessageID:    msgEvent.MessageID,
				ParentMsgID:  parentMsgID,
				StartTime:    time.Now(),
				ContentCount: 0,
				IsActive:     true,
			}
		}
		
	case EventTypeTextMessageContent:
		if msgEvent, ok := event.(*TextMessageContentEvent); ok {
			if msgState, exists := v.state.ActiveMessages[msgEvent.MessageID]; exists {
				msgState.ContentCount++
			}
		}
		
	case EventTypeTextMessageEnd:
		if msgEvent, ok := event.(*TextMessageEndEvent); ok {
			if msgState, exists := v.state.ActiveMessages[msgEvent.MessageID]; exists {
				msgState.IsActive = false
				v.state.FinishedMessages[msgEvent.MessageID] = msgState
				delete(v.state.ActiveMessages, msgEvent.MessageID)
			}
		}
		
	case EventTypeToolCallStart:
		if toolEvent, ok := event.(*ToolCallStartEvent); ok {
			parentMsgID := ""
			if toolEvent.ParentMessageID != nil {
				parentMsgID = *toolEvent.ParentMessageID
			}
			v.state.ActiveTools[toolEvent.ToolCallID] = &ToolState{
				ToolCallID:  toolEvent.ToolCallID,
				ParentMsgID: parentMsgID,
				ToolName:    toolEvent.ToolCallName,
				StartTime:   time.Now(),
				ArgsCount:   0,
				IsActive:    true,
			}
		}
		
	case EventTypeToolCallArgs:
		if toolEvent, ok := event.(*ToolCallArgsEvent); ok {
			if toolState, exists := v.state.ActiveTools[toolEvent.ToolCallID]; exists {
				toolState.ArgsCount++
			}
		}
		
	case EventTypeToolCallEnd:
		if toolEvent, ok := event.(*ToolCallEndEvent); ok {
			if toolState, exists := v.state.ActiveTools[toolEvent.ToolCallID]; exists {
				toolState.IsActive = false
				v.state.FinishedTools[toolEvent.ToolCallID] = toolState
				delete(v.state.ActiveTools, toolEvent.ToolCallID)
			}
		}
	}
}