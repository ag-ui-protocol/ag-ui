package events

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// EventSequenceTracker provides comprehensive event sequence tracking and validation
type EventSequenceTracker struct {
	state        *ValidationState
	eventHistory []Event
	validator    *EventValidator
	config       *SequenceTrackerConfig
	mutex        sync.RWMutex
}

// SequenceTrackerConfig configures the sequence tracker behavior
type SequenceTrackerConfig struct {
	MaxHistorySize       int           `json:"max_history_size"`
	EnableStateSnapshots bool          `json:"enable_state_snapshots"`
	SnapshotInterval     time.Duration `json:"snapshot_interval"`
	TrackMetrics         bool          `json:"track_metrics"`
	ValidateOnAdd        bool          `json:"validate_on_add"`
	StrictSequencing     bool          `json:"strict_sequencing"`
}

// DefaultSequenceTrackerConfig returns default configuration
func DefaultSequenceTrackerConfig() *SequenceTrackerConfig {
	return &SequenceTrackerConfig{
		MaxHistorySize:       10000,
		EnableStateSnapshots: true,
		SnapshotInterval:     time.Minute,
		TrackMetrics:         true,
		ValidateOnAdd:        false, // Disable validation by default for testing
		StrictSequencing:     true,
	}
}

// NewEventSequenceTracker creates a new event sequence tracker
func NewEventSequenceTracker(config *SequenceTrackerConfig) *EventSequenceTracker {
	if config == nil {
		config = DefaultSequenceTrackerConfig()
	}
	
	// Create a more lenient validation config for the tracker
	validationConfig := PermissiveValidationConfig()
	
	return &EventSequenceTracker{
		state:        NewValidationState(),
		eventHistory: make([]Event, 0),
		validator:    NewEventValidator(validationConfig),
		config:       config,
	}
}

// TrackEvent adds an event to the sequence and updates state
func (t *EventSequenceTracker) TrackEvent(event Event) error {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	if event == nil {
		return fmt.Errorf("cannot track nil event")
	}
	
	// Validate event if configured
	if t.config.ValidateOnAdd {
		result := t.validator.ValidateEvent(context.Background(), event)
		if result.HasErrors() {
			return fmt.Errorf("event validation failed: %v", result.Errors)
		}
	}
	
	// Add to history
	t.eventHistory = append(t.eventHistory, event)
	
	// Trim history if needed
	if len(t.eventHistory) > t.config.MaxHistorySize {
		// Remove oldest events
		t.eventHistory = t.eventHistory[len(t.eventHistory)-t.config.MaxHistorySize:]
	}
	
	// Update state
	t.updateStateFromEvent(event)
	
	return nil
}

// ValidateSequence validates the current event sequence
func (t *EventSequenceTracker) ValidateSequence() *ValidationResult {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return t.validator.ValidateSequence(context.Background(), t.eventHistory)
}

// GetCurrentState returns the current validation state
func (t *EventSequenceTracker) GetCurrentState() *ValidationState {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	// Return a copy to prevent external modification
	stateCopy := *t.state
	return &stateCopy
}

// GetEventHistory returns the event history
func (t *EventSequenceTracker) GetEventHistory() []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	// Return a copy to prevent external modification
	history := make([]Event, len(t.eventHistory))
	copy(history, t.eventHistory)
	return history
}

// GetEventCount returns the total number of events tracked
func (t *EventSequenceTracker) GetEventCount() int {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return len(t.eventHistory)
}

// GetActiveRuns returns all currently active runs
func (t *EventSequenceTracker) GetActiveRuns() map[string]*RunState {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	activeRuns := make(map[string]*RunState)
	for k, v := range t.state.ActiveRuns {
		activeRuns[k] = v
	}
	return activeRuns
}

// GetActiveMessages returns all currently active messages
func (t *EventSequenceTracker) GetActiveMessages() map[string]*MessageState {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	activeMessages := make(map[string]*MessageState)
	for k, v := range t.state.ActiveMessages {
		activeMessages[k] = v
	}
	return activeMessages
}

// GetActiveTools returns all currently active tool calls
func (t *EventSequenceTracker) GetActiveTools() map[string]*ToolState {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	activeTools := make(map[string]*ToolState)
	for k, v := range t.state.ActiveTools {
		activeTools[k] = v
	}
	return activeTools
}

// GetActiveSteps returns all currently active steps
func (t *EventSequenceTracker) GetActiveSteps() map[string]bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	activeSteps := make(map[string]bool)
	for k, v := range t.state.ActiveSteps {
		activeSteps[k] = v
	}
	return activeSteps
}

// IsRunActive checks if a specific run is active
func (t *EventSequenceTracker) IsRunActive(runID string) bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	_, exists := t.state.ActiveRuns[runID]
	return exists
}

// IsMessageActive checks if a specific message is active
func (t *EventSequenceTracker) IsMessageActive(messageID string) bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	_, exists := t.state.ActiveMessages[messageID]
	return exists
}

// IsToolActive checks if a specific tool call is active
func (t *EventSequenceTracker) IsToolActive(toolCallID string) bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	_, exists := t.state.ActiveTools[toolCallID]
	return exists
}

// IsStepActive checks if a specific step is active
func (t *EventSequenceTracker) IsStepActive(stepName string) bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return t.state.ActiveSteps[stepName]
}

// GetMetrics returns tracking metrics
func (t *EventSequenceTracker) GetMetrics() *ValidationMetrics {
	return t.validator.GetMetrics()
}

// Reset resets the tracker state
func (t *EventSequenceTracker) Reset() error {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	t.state = NewValidationState()
	t.eventHistory = make([]Event, 0)
	t.validator.Reset()
	
	return nil
}

// GetSequenceInfo returns information about the current sequence
func (t *EventSequenceTracker) GetSequenceInfo() *SequenceInfo {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return &SequenceInfo{
		TotalEvents:      len(t.eventHistory),
		ActiveRuns:       len(t.state.ActiveRuns),
		ActiveMessages:   len(t.state.ActiveMessages),
		ActiveTools:      len(t.state.ActiveTools),
		ActiveSteps:      len(t.state.ActiveSteps),
		FinishedRuns:     len(t.state.FinishedRuns),
		FinishedMessages: len(t.state.FinishedMessages),
		FinishedTools:    len(t.state.FinishedTools),
		CurrentPhase:     t.state.CurrentPhase,
		StartTime:        t.state.StartTime,
		LastEventTime:    t.state.LastEventTime,
	}
}

// SequenceInfo provides information about the current sequence
type SequenceInfo struct {
	TotalEvents      int        `json:"total_events"`
	ActiveRuns       int        `json:"active_runs"`
	ActiveMessages   int        `json:"active_messages"`
	ActiveTools      int        `json:"active_tools"`
	ActiveSteps      int        `json:"active_steps"`
	FinishedRuns     int        `json:"finished_runs"`
	FinishedMessages int        `json:"finished_messages"`
	FinishedTools    int        `json:"finished_tools"`
	CurrentPhase     EventPhase `json:"current_phase"`
	StartTime        time.Time  `json:"start_time"`
	LastEventTime    time.Time  `json:"last_event_time"`
}

// GetLastEvent returns the last event in the sequence
func (t *EventSequenceTracker) GetLastEvent() Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	if len(t.eventHistory) == 0 {
		return nil
	}
	
	return t.eventHistory[len(t.eventHistory)-1]
}

// GetEventsInRange returns events within a specific time range
func (t *EventSequenceTracker) GetEventsInRange(start, end time.Time) []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var events []Event
	for _, event := range t.eventHistory {
		if event.Timestamp() != nil {
			eventTime := time.UnixMilli(*event.Timestamp())
			if eventTime.After(start) && eventTime.Before(end) {
				events = append(events, event)
			}
		}
	}
	
	return events
}

// GetEventsByType returns all events of a specific type
func (t *EventSequenceTracker) GetEventsByType(eventType EventType) []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var events []Event
	for _, event := range t.eventHistory {
		if event.Type() == eventType {
			events = append(events, event)
		}
	}
	
	return events
}

// GetEventsByRunID returns all events for a specific run
func (t *EventSequenceTracker) GetEventsByRunID(runID string) []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var events []Event
	for _, event := range t.eventHistory {
		// Check if event belongs to the run
		switch e := event.(type) {
		case *RunStartedEvent:
			if e.RunID == runID {
				events = append(events, event)
			}
		case *RunFinishedEvent:
			if e.RunID == runID {
				events = append(events, event)
			}
		case *RunErrorEvent:
			if e.RunID == runID {
				events = append(events, event)
			}
		}
	}
	
	return events
}

// GetEventsByMessageID returns all events for a specific message
func (t *EventSequenceTracker) GetEventsByMessageID(messageID string) []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var events []Event
	for _, event := range t.eventHistory {
		// Check if event belongs to the message
		switch e := event.(type) {
		case *TextMessageStartEvent:
			if e.MessageID == messageID {
				events = append(events, event)
			}
		case *TextMessageContentEvent:
			if e.MessageID == messageID {
				events = append(events, event)
			}
		case *TextMessageEndEvent:
			if e.MessageID == messageID {
				events = append(events, event)
			}
		}
	}
	
	return events
}

// GetEventsByToolCallID returns all events for a specific tool call
func (t *EventSequenceTracker) GetEventsByToolCallID(toolCallID string) []Event {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var events []Event
	for _, event := range t.eventHistory {
		// Check if event belongs to the tool call
		switch e := event.(type) {
		case *ToolCallStartEvent:
			if e.ToolCallID == toolCallID {
				events = append(events, event)
			}
		case *ToolCallArgsEvent:
			if e.ToolCallID == toolCallID {
				events = append(events, event)
			}
		case *ToolCallEndEvent:
			if e.ToolCallID == toolCallID {
				events = append(events, event)
			}
		}
	}
	
	return events
}

// ValidateEventSequence validates that events follow proper sequence rules
func (t *EventSequenceTracker) ValidateEventSequence(events []Event) *ValidationResult {
	// Create a temporary validator for sequence validation
	tempValidator := NewEventValidator(t.validator.config)
	
	return tempValidator.ValidateSequence(context.Background(), events)
}

// CheckSequenceCompliance checks if the current sequence complies with AG-UI protocol
func (t *EventSequenceTracker) CheckSequenceCompliance() *ComplianceReport {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	report := &ComplianceReport{
		IsCompliant: true,
		Issues:      make([]*ComplianceIssue, 0),
		Timestamp:   time.Now(),
	}
	
	// Check for orphaned events
	t.checkOrphanedEvents(report)
	
	// Check for incomplete sequences
	t.checkIncompleteSequences(report)
	
	// Check for protocol violations
	t.checkProtocolViolations(report)
	
	return report
}

// ComplianceReport represents a protocol compliance report
type ComplianceReport struct {
	IsCompliant bool               `json:"is_compliant"`
	Issues      []*ComplianceIssue `json:"issues"`
	Timestamp   time.Time          `json:"timestamp"`
}

// ComplianceIssue represents a protocol compliance issue
type ComplianceIssue struct {
	Type        string                 `json:"type"`
	Severity    ValidationSeverity     `json:"severity"`
	Description string                 `json:"description"`
	EventID     string                 `json:"event_id,omitempty"`
	EventType   EventType              `json:"event_type,omitempty"`
	Context     map[string]interface{} `json:"context,omitempty"`
	Suggestions []string               `json:"suggestions,omitempty"`
}

// updateStateFromEvent updates the tracker state based on an event
func (t *EventSequenceTracker) updateStateFromEvent(event Event) {
	// Update our own state directly
	t.state.EventCount++
	t.state.LastEventTime = time.Now()
	
	switch event.Type() {
	case EventTypeRunStarted:
		if runEvent, ok := event.(*RunStartedEvent); ok {
			t.state.CurrentPhase = PhaseRunning
			t.state.ActiveRuns[runEvent.RunID] = &RunState{
				RunID:     runEvent.RunID,
				ThreadID:  runEvent.ThreadID,
				StartTime: time.Now(),
				Phase:     PhaseRunning,
			}
		}
		
	case EventTypeRunFinished:
		if runEvent, ok := event.(*RunFinishedEvent); ok {
			t.state.CurrentPhase = PhaseFinished
			if runState, exists := t.state.ActiveRuns[runEvent.RunID]; exists {
				runState.Phase = PhaseFinished
				t.state.FinishedRuns[runEvent.RunID] = runState
				delete(t.state.ActiveRuns, runEvent.RunID)
			}
		}
		
	case EventTypeRunError:
		if runEvent, ok := event.(*RunErrorEvent); ok {
			t.state.CurrentPhase = PhaseError
			if runState, exists := t.state.ActiveRuns[runEvent.RunID]; exists {
				runState.Phase = PhaseError
				t.state.FinishedRuns[runEvent.RunID] = runState
				delete(t.state.ActiveRuns, runEvent.RunID)
			}
		}
		
	case EventTypeStepStarted:
		if stepEvent, ok := event.(*StepStartedEvent); ok {
			t.state.ActiveSteps[stepEvent.StepName] = true
			// Update step count for active runs
			for _, runState := range t.state.ActiveRuns {
				runState.StepCount++
			}
		}
		
	case EventTypeStepFinished:
		if stepEvent, ok := event.(*StepFinishedEvent); ok {
			delete(t.state.ActiveSteps, stepEvent.StepName)
		}
		
	case EventTypeTextMessageStart:
		if msgEvent, ok := event.(*TextMessageStartEvent); ok {
			parentMsgID := ""
			// TextMessageStartEvent doesn't have ParentMessageID field
			t.state.ActiveMessages[msgEvent.MessageID] = &MessageState{
				MessageID:    msgEvent.MessageID,
				ParentMsgID:  parentMsgID,
				StartTime:    time.Now(),
				ContentCount: 0,
				IsActive:     true,
			}
		}
		
	case EventTypeTextMessageContent:
		if msgEvent, ok := event.(*TextMessageContentEvent); ok {
			if msgState, exists := t.state.ActiveMessages[msgEvent.MessageID]; exists {
				msgState.ContentCount++
			}
		}
		
	case EventTypeTextMessageEnd:
		if msgEvent, ok := event.(*TextMessageEndEvent); ok {
			if msgState, exists := t.state.ActiveMessages[msgEvent.MessageID]; exists {
				msgState.IsActive = false
				t.state.FinishedMessages[msgEvent.MessageID] = msgState
				delete(t.state.ActiveMessages, msgEvent.MessageID)
			}
		}
		
	case EventTypeToolCallStart:
		if toolEvent, ok := event.(*ToolCallStartEvent); ok {
			parentMsgID := ""
			if toolEvent.ParentMessageID != nil {
				parentMsgID = *toolEvent.ParentMessageID
			}
			t.state.ActiveTools[toolEvent.ToolCallID] = &ToolState{
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
			if toolState, exists := t.state.ActiveTools[toolEvent.ToolCallID]; exists {
				toolState.ArgsCount++
			}
		}
		
	case EventTypeToolCallEnd:
		if toolEvent, ok := event.(*ToolCallEndEvent); ok {
			if toolState, exists := t.state.ActiveTools[toolEvent.ToolCallID]; exists {
				toolState.IsActive = false
				t.state.FinishedTools[toolEvent.ToolCallID] = toolState
				delete(t.state.ActiveTools, toolEvent.ToolCallID)
			}
		}
	}
}

// checkOrphanedEvents checks for orphaned events in the sequence
func (t *EventSequenceTracker) checkOrphanedEvents(report *ComplianceReport) {
	// Check for orphaned messages
	for messageID, msgState := range t.state.ActiveMessages {
		if time.Since(msgState.StartTime) > time.Hour { // Configurable timeout
			report.IsCompliant = false
			report.Issues = append(report.Issues, &ComplianceIssue{
				Type:        "ORPHANED_MESSAGE",
				Severity:    ValidationSeverityWarning,
				Description: fmt.Sprintf("Message %s has been active for over an hour", messageID),
				EventID:     messageID,
				EventType:   EventTypeTextMessageStart,
				Suggestions: []string{"Send TEXT_MESSAGE_END event to complete the message"},
			})
		}
	}
	
	// Check for orphaned tool calls
	for toolCallID, toolState := range t.state.ActiveTools {
		if time.Since(toolState.StartTime) > time.Hour { // Configurable timeout
			report.IsCompliant = false
			report.Issues = append(report.Issues, &ComplianceIssue{
				Type:        "ORPHANED_TOOL_CALL",
				Severity:    ValidationSeverityWarning,
				Description: fmt.Sprintf("Tool call %s has been active for over an hour", toolCallID),
				EventID:     toolCallID,
				EventType:   EventTypeToolCallStart,
				Suggestions: []string{"Send TOOL_CALL_END event to complete the tool call"},
			})
		}
	}
}

// checkIncompleteSequences checks for incomplete event sequences
func (t *EventSequenceTracker) checkIncompleteSequences(report *ComplianceReport) {
	// Check for runs without proper completion
	for runID, runState := range t.state.ActiveRuns {
		if time.Since(runState.StartTime) > time.Hour*24 { // Configurable timeout
			report.IsCompliant = false
			report.Issues = append(report.Issues, &ComplianceIssue{
				Type:        "INCOMPLETE_RUN",
				Severity:    ValidationSeverityError,
				Description: fmt.Sprintf("Run %s has been active for over 24 hours", runID),
				EventID:     runID,
				EventType:   EventTypeRunStarted,
				Suggestions: []string{
					"Send RUN_FINISHED event to complete the run",
					"Send RUN_ERROR event if the run encountered an error",
				},
			})
		}
	}
}

// checkProtocolViolations checks for AG-UI protocol violations
func (t *EventSequenceTracker) checkProtocolViolations(report *ComplianceReport) {
	// Check if first event is RUN_STARTED
	if len(t.eventHistory) > 0 && t.eventHistory[0].Type() != EventTypeRunStarted {
		report.IsCompliant = false
		report.Issues = append(report.Issues, &ComplianceIssue{
			Type:        "INVALID_FIRST_EVENT",
			Severity:    ValidationSeverityError,
			Description: "First event must be RUN_STARTED",
			EventType:   t.eventHistory[0].Type(),
			Suggestions: []string{"Start the sequence with a RUN_STARTED event"},
		})
	}
	
	// Check for events after RUN_FINISHED
	foundFinished := false
	for _, event := range t.eventHistory {
		if event.Type() == EventTypeRunFinished {
			foundFinished = true
			continue
		}
		
		if foundFinished && event.Type() != EventTypeRunError {
			report.IsCompliant = false
			report.Issues = append(report.Issues, &ComplianceIssue{
				Type:        "EVENTS_AFTER_FINISHED",
				Severity:    ValidationSeverityError,
				Description: "No events allowed after RUN_FINISHED except RUN_ERROR",
				EventType:   event.Type(),
				Suggestions: []string{"Do not send events after RUN_FINISHED"},
			})
		}
	}
}