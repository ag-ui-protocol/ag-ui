package events

import (
	"fmt"
	"sync"
	"time"
)

// IDTracker tracks event IDs and their relationships
type IDTracker struct {
	// Message tracking
	messageStarts   map[string]*TextMessageStartEvent
	messageContents map[string][]*TextMessageContentEvent
	messageEnds     map[string]*TextMessageEndEvent
	
	// Tool call tracking
	toolStarts map[string]*ToolCallStartEvent
	toolArgs   map[string][]*ToolCallArgsEvent
	toolEnds   map[string]*ToolCallEndEvent
	
	// Run tracking
	runStarts    map[string]*RunStartedEvent
	runFinishes  map[string]*RunFinishedEvent
	runErrors    map[string]*RunErrorEvent
	
	// Step tracking
	stepStarts   map[string]*StepStartedEvent
	stepFinishes map[string]*StepFinishedEvent
	
	// Thread safety
	mutex sync.RWMutex
}

// NewIDTracker creates a new ID tracker
func NewIDTracker() *IDTracker {
	return &IDTracker{
		messageStarts:   make(map[string]*TextMessageStartEvent),
		messageContents: make(map[string][]*TextMessageContentEvent),
		messageEnds:     make(map[string]*TextMessageEndEvent),
		toolStarts:      make(map[string]*ToolCallStartEvent),
		toolArgs:        make(map[string][]*ToolCallArgsEvent),
		toolEnds:        make(map[string]*ToolCallEndEvent),
		runStarts:       make(map[string]*RunStartedEvent),
		runFinishes:     make(map[string]*RunFinishedEvent),
		runErrors:       make(map[string]*RunErrorEvent),
		stepStarts:      make(map[string]*StepStartedEvent),
		stepFinishes:    make(map[string]*StepFinishedEvent),
	}
}

// TrackEvent tracks an event in the ID tracker
func (t *IDTracker) TrackEvent(event Event) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	switch e := event.(type) {
	case *TextMessageStartEvent:
		t.messageStarts[e.MessageID] = e
	case *TextMessageContentEvent:
		t.messageContents[e.MessageID] = append(t.messageContents[e.MessageID], e)
	case *TextMessageEndEvent:
		t.messageEnds[e.MessageID] = e
		
	case *ToolCallStartEvent:
		t.toolStarts[e.ToolCallID] = e
	case *ToolCallArgsEvent:
		t.toolArgs[e.ToolCallID] = append(t.toolArgs[e.ToolCallID], e)
	case *ToolCallEndEvent:
		t.toolEnds[e.ToolCallID] = e
		
	case *RunStartedEvent:
		t.runStarts[e.RunID] = e
	case *RunFinishedEvent:
		t.runFinishes[e.RunID] = e
	case *RunErrorEvent:
		if e.RunID != "" {
			t.runErrors[e.RunID] = e
		}
		
	case *StepStartedEvent:
		t.stepStarts[e.StepName] = e
	case *StepFinishedEvent:
		t.stepFinishes[e.StepName] = e
	}
}

// ValidateIDConsistency validates ID consistency across all tracked events
func (t *IDTracker) ValidateIDConsistency() []*ValidationError {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	var errors []*ValidationError
	
	// Validate message triplets
	errors = append(errors, t.validateMessageTriplets()...)
	
	// Validate tool call triplets
	errors = append(errors, t.validateToolCallTriplets()...)
	
	// Validate run lifecycle
	errors = append(errors, t.validateRunLifecycle()...)
	
	// Validate step pairs
	errors = append(errors, t.validateStepPairs()...)
	
	// Check for orphaned events
	errors = append(errors, t.checkOrphanedEvents()...)
	
	return errors
}

// validateMessageTriplets validates message start/content/end triplets
func (t *IDTracker) validateMessageTriplets() []*ValidationError {
	var errors []*ValidationError
	
	// Check for message contents without starts
	for messageID, contents := range t.messageContents {
		if _, hasStart := t.messageStarts[messageID]; !hasStart {
			for range contents {
				errors = append(errors, &ValidationError{
					RuleID:    "MESSAGE_ORPHANED_CONTENT",
					EventID:   messageID,
					EventType: EventTypeTextMessageContent,
					Message:   fmt.Sprintf("Message content for ID %s has no corresponding start event", messageID),
					Severity:  ValidationSeverityError,
					Context:   map[string]interface{}{"message_id": messageID},
					Suggestions: []string{"Send TEXT_MESSAGE_START event before sending content"},
					Timestamp: time.Now(),
				})
			}
		}
	}
	
	// Check for message ends without starts
	for messageID := range t.messageEnds {
		if _, hasStart := t.messageStarts[messageID]; !hasStart {
			errors = append(errors, &ValidationError{
				RuleID:    "MESSAGE_ORPHANED_END",
				EventID:   messageID,
				EventType: EventTypeTextMessageEnd,
				Message:   fmt.Sprintf("Message end for ID %s has no corresponding start event", messageID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"message_id": messageID},
				Suggestions: []string{"Send TEXT_MESSAGE_START event before sending end"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for message starts without ends
	for messageID := range t.messageStarts {
		if _, hasEnd := t.messageEnds[messageID]; !hasEnd {
			errors = append(errors, &ValidationError{
				RuleID:    "MESSAGE_INCOMPLETE",
				EventID:   messageID,
				EventType: EventTypeTextMessageStart,
				Message:   fmt.Sprintf("Message start for ID %s has no corresponding end event", messageID),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"message_id": messageID},
				Suggestions: []string{"Send TEXT_MESSAGE_END event to complete the message"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for message ends without content
	for messageID := range t.messageEnds {
		if contents, hasContents := t.messageContents[messageID]; !hasContents || len(contents) == 0 {
			errors = append(errors, &ValidationError{
				RuleID:    "MESSAGE_NO_CONTENT",
				EventID:   messageID,
				EventType: EventTypeTextMessageEnd,
				Message:   fmt.Sprintf("Message end for ID %s has no content events", messageID),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"message_id": messageID},
				Suggestions: []string{"Send TEXT_MESSAGE_CONTENT events between start and end"},
				Timestamp: time.Now(),
			})
		}
	}
	
	return errors
}

// validateToolCallTriplets validates tool call start/args/end triplets
func (t *IDTracker) validateToolCallTriplets() []*ValidationError {
	var errors []*ValidationError
	
	// Check for tool args without starts
	for toolCallID, args := range t.toolArgs {
		if _, hasStart := t.toolStarts[toolCallID]; !hasStart {
			for range args {
				errors = append(errors, &ValidationError{
					RuleID:    "TOOL_ORPHANED_ARGS",
					EventID:   toolCallID,
					EventType: EventTypeToolCallArgs,
					Message:   fmt.Sprintf("Tool call args for ID %s has no corresponding start event", toolCallID),
					Severity:  ValidationSeverityError,
					Context:   map[string]interface{}{"tool_call_id": toolCallID},
					Suggestions: []string{"Send TOOL_CALL_START event before sending args"},
					Timestamp: time.Now(),
				})
			}
		}
	}
	
	// Check for tool ends without starts
	for toolCallID := range t.toolEnds {
		if _, hasStart := t.toolStarts[toolCallID]; !hasStart {
			errors = append(errors, &ValidationError{
				RuleID:    "TOOL_ORPHANED_END",
				EventID:   toolCallID,
				EventType: EventTypeToolCallEnd,
				Message:   fmt.Sprintf("Tool call end for ID %s has no corresponding start event", toolCallID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"tool_call_id": toolCallID},
				Suggestions: []string{"Send TOOL_CALL_START event before sending end"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for tool starts without ends
	for toolCallID := range t.toolStarts {
		if _, hasEnd := t.toolEnds[toolCallID]; !hasEnd {
			errors = append(errors, &ValidationError{
				RuleID:    "TOOL_INCOMPLETE",
				EventID:   toolCallID,
				EventType: EventTypeToolCallStart,
				Message:   fmt.Sprintf("Tool call start for ID %s has no corresponding end event", toolCallID),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"tool_call_id": toolCallID},
				Suggestions: []string{"Send TOOL_CALL_END event to complete the tool call"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for tool ends without args
	for toolCallID := range t.toolEnds {
		if args, hasArgs := t.toolArgs[toolCallID]; !hasArgs || len(args) == 0 {
			errors = append(errors, &ValidationError{
				RuleID:    "TOOL_NO_ARGS",
				EventID:   toolCallID,
				EventType: EventTypeToolCallEnd,
				Message:   fmt.Sprintf("Tool call end for ID %s has no args events", toolCallID),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"tool_call_id": toolCallID},
				Suggestions: []string{"Send TOOL_CALL_ARGS events between start and end"},
				Timestamp: time.Now(),
			})
		}
	}
	
	return errors
}

// validateRunLifecycle validates run lifecycle consistency
func (t *IDTracker) validateRunLifecycle() []*ValidationError {
	var errors []*ValidationError
	
	// Check for run finishes without starts
	for runID := range t.runFinishes {
		if _, hasStart := t.runStarts[runID]; !hasStart {
			errors = append(errors, &ValidationError{
				RuleID:    "RUN_ORPHANED_FINISH",
				EventID:   runID,
				EventType: EventTypeRunFinished,
				Message:   fmt.Sprintf("Run finish for ID %s has no corresponding start event", runID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"run_id": runID},
				Suggestions: []string{"Send RUN_STARTED event before finishing the run"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for run errors without starts (if run ID is specified)
	for runID := range t.runErrors {
		if runID != "" {
			if _, hasStart := t.runStarts[runID]; !hasStart {
				errors = append(errors, &ValidationError{
					RuleID:    "RUN_ORPHANED_ERROR",
					EventID:   runID,
					EventType: EventTypeRunError,
					Message:   fmt.Sprintf("Run error for ID %s has no corresponding start event", runID),
					Severity:  ValidationSeverityError,
					Context:   map[string]interface{}{"run_id": runID},
					Suggestions: []string{"Send RUN_STARTED event before sending run error"},
					Timestamp: time.Now(),
				})
			}
		}
	}
	
	// Check for run starts without completion
	for runID := range t.runStarts {
		hasFinish := false
		hasError := false
		
		if _, exists := t.runFinishes[runID]; exists {
			hasFinish = true
		}
		if _, exists := t.runErrors[runID]; exists {
			hasError = true
		}
		
		if !hasFinish && !hasError {
			errors = append(errors, &ValidationError{
				RuleID:    "RUN_INCOMPLETE",
				EventID:   runID,
				EventType: EventTypeRunStarted,
				Message:   fmt.Sprintf("Run start for ID %s has no corresponding finish or error event", runID),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"run_id": runID},
				Suggestions: []string{"Send RUN_FINISHED or RUN_ERROR event to complete the run"},
				Timestamp: time.Now(),
			})
		}
	}
	
	return errors
}

// validateStepPairs validates step start/finish pairs
func (t *IDTracker) validateStepPairs() []*ValidationError {
	var errors []*ValidationError
	
	// Check for step finishes without starts
	for stepName := range t.stepFinishes {
		if _, hasStart := t.stepStarts[stepName]; !hasStart {
			errors = append(errors, &ValidationError{
				RuleID:    "STEP_ORPHANED_FINISH",
				EventID:   stepName,
				EventType: EventTypeStepFinished,
				Message:   fmt.Sprintf("Step finish for name %s has no corresponding start event", stepName),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"step_name": stepName},
				Suggestions: []string{"Send STEP_STARTED event before finishing the step"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for step starts without finishes
	for stepName := range t.stepStarts {
		if _, hasFinish := t.stepFinishes[stepName]; !hasFinish {
			errors = append(errors, &ValidationError{
				RuleID:    "STEP_INCOMPLETE",
				EventID:   stepName,
				EventType: EventTypeStepStarted,
				Message:   fmt.Sprintf("Step start for name %s has no corresponding finish event", stepName),
				Severity:  ValidationSeverityWarning,
				Context:   map[string]interface{}{"step_name": stepName},
				Suggestions: []string{"Send STEP_FINISHED event to complete the step"},
				Timestamp: time.Now(),
			})
		}
	}
	
	return errors
}

// checkOrphanedEvents checks for other types of orphaned events
func (t *IDTracker) checkOrphanedEvents() []*ValidationError {
	var errors []*ValidationError
	
	// Check for duplicate run IDs (multiple starts for same ID)
	duplicateStarts := make(map[string]int)
	for runID := range t.runStarts {
		duplicateStarts[runID]++
		if duplicateStarts[runID] > 1 {
			errors = append(errors, &ValidationError{
				RuleID:    "RUN_DUPLICATE_START",
				EventID:   runID,
				EventType: EventTypeRunStarted,
				Message:   fmt.Sprintf("Multiple start events found for run ID %s", runID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"run_id": runID},
				Suggestions: []string{"Use unique run IDs for each run"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for duplicate message IDs (multiple starts for same ID)
	duplicateMessageStarts := make(map[string]int)
	for messageID := range t.messageStarts {
		duplicateMessageStarts[messageID]++
		if duplicateMessageStarts[messageID] > 1 {
			errors = append(errors, &ValidationError{
				RuleID:    "MESSAGE_DUPLICATE_START",
				EventID:   messageID,
				EventType: EventTypeTextMessageStart,
				Message:   fmt.Sprintf("Multiple start events found for message ID %s", messageID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"message_id": messageID},
				Suggestions: []string{"Use unique message IDs for each message"},
				Timestamp: time.Now(),
			})
		}
	}
	
	// Check for duplicate tool call IDs (multiple starts for same ID)
	duplicateToolStarts := make(map[string]int)
	for toolCallID := range t.toolStarts {
		duplicateToolStarts[toolCallID]++
		if duplicateToolStarts[toolCallID] > 1 {
			errors = append(errors, &ValidationError{
				RuleID:    "TOOL_DUPLICATE_START",
				EventID:   toolCallID,
				EventType: EventTypeToolCallStart,
				Message:   fmt.Sprintf("Multiple start events found for tool call ID %s", toolCallID),
				Severity:  ValidationSeverityError,
				Context:   map[string]interface{}{"tool_call_id": toolCallID},
				Suggestions: []string{"Use unique tool call IDs for each tool call"},
				Timestamp: time.Now(),
			})
		}
	}
	
	return errors
}

// GetMessageTriplet returns the complete triplet for a message ID
func (t *IDTracker) GetMessageTriplet(messageID string) (*TextMessageStartEvent, []*TextMessageContentEvent, *TextMessageEndEvent) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	start := t.messageStarts[messageID]
	contents := t.messageContents[messageID]
	end := t.messageEnds[messageID]
	
	return start, contents, end
}

// GetToolCallTriplet returns the complete triplet for a tool call ID
func (t *IDTracker) GetToolCallTriplet(toolCallID string) (*ToolCallStartEvent, []*ToolCallArgsEvent, *ToolCallEndEvent) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	start := t.toolStarts[toolCallID]
	args := t.toolArgs[toolCallID]
	end := t.toolEnds[toolCallID]
	
	return start, args, end
}

// GetRunLifecycle returns the run lifecycle events for a run ID
func (t *IDTracker) GetRunLifecycle(runID string) (*RunStartedEvent, *RunFinishedEvent, *RunErrorEvent) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	start := t.runStarts[runID]
	finish := t.runFinishes[runID]
	error := t.runErrors[runID]
	
	return start, finish, error
}

// GetStepPair returns the step pair for a step name
func (t *IDTracker) GetStepPair(stepName string) (*StepStartedEvent, *StepFinishedEvent) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	start := t.stepStarts[stepName]
	finish := t.stepFinishes[stepName]
	
	return start, finish
}

// Reset clears all tracked IDs
func (t *IDTracker) Reset() {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	t.messageStarts = make(map[string]*TextMessageStartEvent)
	t.messageContents = make(map[string][]*TextMessageContentEvent)
	t.messageEnds = make(map[string]*TextMessageEndEvent)
	t.toolStarts = make(map[string]*ToolCallStartEvent)
	t.toolArgs = make(map[string][]*ToolCallArgsEvent)
	t.toolEnds = make(map[string]*ToolCallEndEvent)
	t.runStarts = make(map[string]*RunStartedEvent)
	t.runFinishes = make(map[string]*RunFinishedEvent)
	t.runErrors = make(map[string]*RunErrorEvent)
	t.stepStarts = make(map[string]*StepStartedEvent)
	t.stepFinishes = make(map[string]*StepFinishedEvent)
}

// GetStatistics returns statistics about tracked events
func (t *IDTracker) GetStatistics() *IDTrackerStatistics {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return &IDTrackerStatistics{
		MessageStartCount:   len(t.messageStarts),
		MessageContentCount: len(t.messageContents),
		MessageEndCount:     len(t.messageEnds),
		ToolStartCount:      len(t.toolStarts),
		ToolArgsCount:       len(t.toolArgs),
		ToolEndCount:        len(t.toolEnds),
		RunStartCount:       len(t.runStarts),
		RunFinishCount:      len(t.runFinishes),
		RunErrorCount:       len(t.runErrors),
		StepStartCount:      len(t.stepStarts),
		StepFinishCount:     len(t.stepFinishes),
	}
}

// IDTrackerStatistics provides statistics about tracked events
type IDTrackerStatistics struct {
	MessageStartCount   int `json:"message_start_count"`
	MessageContentCount int `json:"message_content_count"`
	MessageEndCount     int `json:"message_end_count"`
	ToolStartCount      int `json:"tool_start_count"`
	ToolArgsCount       int `json:"tool_args_count"`
	ToolEndCount        int `json:"tool_end_count"`
	RunStartCount       int `json:"run_start_count"`
	RunFinishCount      int `json:"run_finish_count"`
	RunErrorCount       int `json:"run_error_count"`
	StepStartCount      int `json:"step_start_count"`
	StepFinishCount     int `json:"step_finish_count"`
}

// SequenceIDValidator validates ID consistency for event sequences
type SequenceIDValidator struct {
	tracker *IDTracker
}

// NewSequenceIDValidator creates a new sequence ID validator
func NewSequenceIDValidator() *SequenceIDValidator {
	return &SequenceIDValidator{
		tracker: NewIDTracker(),
	}
}

// ValidateSequence validates ID consistency for a sequence of events
func (v *SequenceIDValidator) ValidateSequence(events []Event) *ValidationResult {
	v.tracker.Reset()
	
	// Track all events
	for _, event := range events {
		v.tracker.TrackEvent(event)
	}
	
	// Validate ID consistency
	errors := v.tracker.ValidateIDConsistency()
	
	result := &ValidationResult{
		IsValid:    len(errors) == 0,
		Errors:     make([]*ValidationError, 0),
		Warnings:   make([]*ValidationError, 0),
		EventCount: len(events),
		Timestamp:  time.Now(),
	}
	
	// Categorize errors by severity
	for _, err := range errors {
		switch err.Severity {
		case ValidationSeverityError:
			result.AddError(err)
		case ValidationSeverityWarning:
			result.AddWarning(err)
		case ValidationSeverityInfo:
			result.AddInfo(err)
		}
	}
	
	return result
}

// GetTracker returns the internal ID tracker
func (v *SequenceIDValidator) GetTracker() *IDTracker {
	return v.tracker
}