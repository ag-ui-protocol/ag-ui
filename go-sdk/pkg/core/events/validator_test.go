package events

import (
	"context"
	"testing"
	"time"
)

func TestEventValidator_ValidateEvent(t *testing.T) {
	tests := []struct {
		name          string
		event         Event
		expectedValid bool
		expectedError string
	}{
		{
			name:          "nil event",
			event:         nil,
			expectedValid: false,
			expectedError: "Event cannot be nil",
		},
		{
			name: "valid run started event",
			event: &RunStartedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunStarted,
					// EventID:   "event-1",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				RunID:    "run-123",
				ThreadID: "thread-456",
			},
			expectedValid: true, // First RUN_STARTED event should be valid
		},
		{
			name: "invalid run started event - missing run ID",
			event: &RunStartedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunStarted,
					// EventID:   "event-1",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				ThreadID: "thread-456",
			},
			expectedValid: false,
			expectedError: "Run ID is required",
		},
		{
			name: "invalid message start event - no run started first",
			event: &TextMessageStartEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageStart,
					// EventID:   "event-2",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				MessageID: "msg-123",
			},
			expectedValid: false,
			expectedError: "First event must be RUN_STARTED",
		},
		{
			name: "invalid message content event - no active message",
			event: &TextMessageContentEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageContent,
					// EventID:   "event-3",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				MessageID: "msg-999",
				Delta:     "Hello",
			},
			expectedValid: false,
			expectedError: "Cannot add content to message msg-999 that was not started",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewEventValidator(DefaultValidationConfig()) // Fresh validator for each test
			result := validator.ValidateEvent(context.Background(), tt.event)

			if result.IsValid != tt.expectedValid {
				t.Errorf("ValidateEvent() isValid = %v, want %v, errors: %v", result.IsValid, tt.expectedValid, result.Errors)
			}

			if !tt.expectedValid && len(result.Errors) == 0 {
				t.Errorf("ValidateEvent() expected errors but got none")
			}

			if !tt.expectedValid && tt.expectedError != "" {
				found := false
				for _, err := range result.Errors {
					if err.Message == tt.expectedError {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("ValidateEvent() expected error '%s' but didn't find it", tt.expectedError)
				}
			}
		})
	}
}

func TestEventValidator_ValidateSequence(t *testing.T) {
	tests := []struct {
		name          string
		events        []Event
		expectedValid bool
		expectedError string
	}{
		{
			name:          "empty sequence",
			events:        []Event{},
			expectedValid: true,
		},
		{
			name: "valid simple sequence",
			events: []Event{
				&RunStartedEvent{
					BaseEvent: &BaseEvent{
						EventType: EventTypeRunStarted,
						// EventID:   "event-1",
						TimestampMs: timePtr(time.Now().UnixMilli()),
					},
					RunID:    "run-simple001",
					ThreadID: "thread-simple002",
				},
				&RunFinishedEvent{
					BaseEvent: &BaseEvent{
						EventType: EventTypeRunFinished,
						// EventID:   "event-2",
						TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
					},
					RunID: "run-simple001",
				},
			},
			expectedValid: true,
		},
		{
			name: "invalid sequence - message without start",
			events: []Event{
				&RunStartedEvent{
					BaseEvent: &BaseEvent{
						EventType: EventTypeRunStarted,
						// EventID:   "event-1",
						TimestampMs: timePtr(time.Now().UnixMilli()),
					},
					RunID:    "run-invalid001",
					ThreadID: "thread-invalid001",
				},
				&TextMessageContentEvent{
					BaseEvent: &BaseEvent{
						EventType: EventTypeTextMessageContent,
						// EventID:   "event-2",
						TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
					},
					MessageID: "msg-invalid001",
					Delta:     "Hello",
				},
			},
			expectedValid: false,
			expectedError: "Cannot add content to message msg-invalid001 that was not started",
		},
		{
			name: "invalid sequence - no run started first",
			events: []Event{
				&TextMessageStartEvent{
					BaseEvent: &BaseEvent{
						EventType: EventTypeTextMessageStart,
						// EventID:   "event-1",
						TimestampMs: timePtr(time.Now().UnixMilli()),
					},
					MessageID: "msg-invalid002",
				},
			},
			expectedValid: false,
			expectedError: "First event must be RUN_STARTED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewEventValidator(DefaultValidationConfig()) // Fresh validator for each test
			result := validator.ValidateSequence(context.Background(), tt.events)

			if result.IsValid != tt.expectedValid {
				t.Errorf("ValidateSequence() isValid = %v, want %v", result.IsValid, tt.expectedValid)
			}

			if !tt.expectedValid && len(result.Errors) == 0 {
				t.Errorf("ValidateSequence() expected errors but got none")
			}

			if !tt.expectedValid && tt.expectedError != "" {
				found := false
				for _, err := range result.Errors {
					if err.Message == tt.expectedError {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("ValidateSequence() expected error '%s' but didn't find it", tt.expectedError)
				}
			}
		})
	}
}

func TestEventValidator_AddRemoveRules(t *testing.T) {
	validator := NewEventValidator(DefaultValidationConfig())

	// Count initial rules
	initialRules := len(validator.GetRules())

	// Add a custom rule
	customRule := NewRunLifecycleRule()
	customRule.SetEnabled(false)
	validator.AddRule(customRule)

	// Check rule was added
	rules := validator.GetRules()
	if len(rules) != initialRules+1 {
		t.Errorf("AddRule() expected %d rules, got %d", initialRules+1, len(rules))
	}

	// Remove the rule
	if !validator.RemoveRule(customRule.ID()) {
		t.Error("RemoveRule() should return true when rule is found and removed")
	}

	// Check rule was removed
	rules = validator.GetRules()
	if len(rules) != initialRules {
		t.Errorf("RemoveRule() expected %d rules, got %d", initialRules, len(rules))
	}

	// Try to remove non-existent rule
	if validator.RemoveRule("non-existent") {
		t.Error("RemoveRule() should return false when rule is not found")
	}
}

func TestEventValidator_GetRule(t *testing.T) {
	validator := NewEventValidator(DefaultValidationConfig())

	// Get an existing rule
	rule := validator.GetRule("RUN_LIFECYCLE")
	if rule == nil {
		t.Error("GetRule() should return the rule when it exists")
	}

	// Get a non-existent rule
	rule = validator.GetRule("NON_EXISTENT")
	if rule != nil {
		t.Error("GetRule() should return nil when rule doesn't exist")
	}
}

func TestEventValidator_StateTracking(t *testing.T) {
	validator := NewEventValidator(DefaultValidationConfig())

	// Start with empty state
	state := validator.GetState()
	if state.EventCount != 0 {
		t.Errorf("Initial state should have 0 events, got %d", state.EventCount)
	}

	// Validate a run started event
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}

	result := validator.ValidateEvent(context.Background(), runEvent)
	if !result.IsValid {
		t.Errorf("ValidateEvent() should succeed for valid run started event: %v", result.Errors)
	}

	// Check state was updated
	state = validator.GetState()
	if state.EventCount != 1 {
		t.Errorf("State should have 1 event after validation, got %d", state.EventCount)
	}

	if len(state.ActiveRuns) != 1 {
		t.Errorf("State should have 1 active run, got %d", len(state.ActiveRuns))
	}

	if state.CurrentPhase != PhaseRunning {
		t.Errorf("State phase should be Running, got %s", state.CurrentPhase)
	}

	// Now test that a message start event is valid when validated as a sequence
	// (Individual event validation treats each event as index 0, which violates EVENT_ORDERING)
	events := []Event{
		runEvent,
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			MessageID: "msg-abc456", // Different ID to avoid conflicts
		},
	}

	// Reset for sequence validation
	validator.Reset()
	seqResult := validator.ValidateSequence(context.Background(), events)
	if !seqResult.IsValid {
		t.Errorf("ValidateSequence() should succeed for valid message start after run started: %v", seqResult.Errors)
	}
}

func TestEventValidator_Reset(t *testing.T) {
	validator := NewEventValidator(DefaultValidationConfig())

	// Add some state
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}

	validator.ValidateEvent(context.Background(), runEvent)

	// Verify state exists
	state := validator.GetState()
	if state.EventCount == 0 {
		t.Error("State should have events before reset")
	}

	// Reset
	validator.Reset()

	// Verify state is cleared
	state = validator.GetState()
	if state.EventCount != 0 {
		t.Errorf("State should have 0 events after reset, got %d", state.EventCount)
	}

	if len(state.ActiveRuns) != 0 {
		t.Errorf("State should have 0 active runs after reset, got %d", len(state.ActiveRuns))
	}

	if state.CurrentPhase != PhaseInit {
		t.Errorf("State phase should be Init after reset, got %s", state.CurrentPhase)
	}
}

func TestEventValidator_Metrics(t *testing.T) {
	validator := NewEventValidator(DefaultValidationConfig())

	// Validate some events
	events := []Event{
		&RunStartedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunStarted,
				// EventID:   "event-1",
				TimestampMs: timePtr(time.Now().UnixMilli()),
			},
			RunID:    "run-123",
			ThreadID: "thread-456",
		},
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			MessageID: "msg-123",
		},
		&TextMessageContentEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageContent,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			MessageID: "msg-123",
			Delta:     "Hello",
		},
	}

	for _, event := range events {
		validator.ValidateEvent(context.Background(), event)
	}

	// Check metrics
	metrics := validator.GetMetrics()
	if metrics.EventsProcessed != int64(len(events)) {
		t.Errorf("Metrics should show %d events processed, got %d", len(events), metrics.EventsProcessed)
	}

	if metrics.ValidationDuration == 0 {
		t.Error("Metrics should show non-zero validation duration")
	}

	if len(metrics.RuleExecutionTimes) == 0 {
		t.Error("Metrics should show rule execution times")
	}
}

func TestValidationRule_Interface(t *testing.T) {
	rule := NewRunLifecycleRule()

	// Test ID
	if rule.ID() != "RUN_LIFECYCLE" {
		t.Errorf("Rule ID should be 'RUN_LIFECYCLE', got '%s'", rule.ID())
	}

	// Test description
	if rule.Description() == "" {
		t.Error("Rule should have a description")
	}

	// Test enabled/disabled
	if !rule.IsEnabled() {
		t.Error("Rule should be enabled by default")
	}

	rule.SetEnabled(false)
	if rule.IsEnabled() {
		t.Error("Rule should be disabled after SetEnabled(false)")
	}

	// Test severity
	if rule.GetSeverity() != ValidationSeverityError {
		t.Errorf("Rule severity should be Error, got %s", rule.GetSeverity())
	}

	rule.SetSeverity(ValidationSeverityWarning)
	if rule.GetSeverity() != ValidationSeverityWarning {
		t.Error("Rule severity should be Warning after setting")
	}
}

func TestValidationError_Interface(t *testing.T) {
	err := &ValidationError{
		RuleID:      "TEST_RULE",
		EventID:     "event-123",
		EventType:   EventTypeRunStarted,
		Message:     "Test error message",
		Severity:    ValidationSeverityError,
		Context:     map[string]interface{}{"key": "value"},
		Suggestions: []string{"Fix the issue"},
		Timestamp:   time.Now(),
	}

	// Test Error() method
	errorString := err.Error()
	if errorString == "" {
		t.Error("ValidationError should implement Error() interface")
	}

	// Test that all fields are accessible
	if err.RuleID != "TEST_RULE" {
		t.Error("RuleID should be accessible")
	}
	if err.EventID != "event-123" {
		t.Error("EventID should be accessible")
	}
	if err.EventType != EventTypeRunStarted {
		t.Error("EventType should be accessible")
	}
}

func TestValidationResult_Methods(t *testing.T) {
	result := &ValidationResult{
		IsValid:   true,
		Errors:    make([]*ValidationError, 0),
		Warnings:  make([]*ValidationError, 0),
		Timestamp: time.Now(),
	}

	// Test initial state
	if result.HasErrors() {
		t.Error("Result should not have errors initially")
	}
	if result.HasWarnings() {
		t.Error("Result should not have warnings initially")
	}

	// Add an error
	err := &ValidationError{
		RuleID:    "TEST_RULE",
		Message:   "Test error",
		Severity:  ValidationSeverityError,
		Timestamp: time.Now(),
	}
	result.AddError(err)

	if !result.HasErrors() {
		t.Error("Result should have errors after adding one")
	}
	if result.IsValid {
		t.Error("Result should not be valid after adding an error")
	}

	// Add a warning
	warning := &ValidationError{
		RuleID:    "TEST_RULE",
		Message:   "Test warning",
		Severity:  ValidationSeverityWarning,
		Timestamp: time.Now(),
	}
	result.AddWarning(warning)

	if !result.HasWarnings() {
		t.Error("Result should have warnings after adding one")
	}

	// Add info
	info := &ValidationError{
		RuleID:    "TEST_RULE",
		Message:   "Test info",
		Severity:  ValidationSeverityInfo,
		Timestamp: time.Now(),
	}
	result.AddInfo(info)

	if len(result.Information) != 1 {
		t.Error("Result should have one info message after adding one")
	}
}

// Helper function to create time pointers
func timePtr(t int64) *int64 {
	return &t
}

// Test complex validation scenarios
func TestEventValidator_ComplexScenarios(t *testing.T) {

	t.Run("complete message lifecycle", func(t *testing.T) {
		validator := NewEventValidator(DefaultValidationConfig()) // Fresh validator for this test
		
		events := []Event{
			&RunStartedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunStarted,
					// EventID:   "event-1",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				RunID:    "run-abc123", // Use unique run ID
				ThreadID: "thread-def456",
			},
			&TextMessageStartEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageStart,
					// EventID:   "event-2",
					TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
				},
				MessageID: "msg-xyz789", // Use unique message ID
			},
			&TextMessageContentEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageContent,
					// EventID:   "event-3",
					TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
				},
				MessageID: "msg-xyz789",
				Delta:     "Hello ",
			},
			&TextMessageContentEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageContent,
					// EventID:   "event-4",
					TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
				},
				MessageID: "msg-xyz789",
				Delta:     "world!",
			},
			&TextMessageEndEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageEnd,
					// EventID:   "event-5",
					TimestampMs: timePtr(time.Now().UnixMilli() + 4000),
				},
				MessageID: "msg-xyz789",
			},
			&RunFinishedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunFinished,
					// EventID:   "event-6",
					TimestampMs: timePtr(time.Now().UnixMilli() + 5000),
				},
				RunID: "run-abc123",
			},
		}

		result := validator.ValidateSequence(context.Background(), events)
		if !result.IsValid {
			t.Errorf("Complete message lifecycle should be valid, errors: %v", result.Errors)
		}
	})

	t.Run("complete tool call lifecycle", func(t *testing.T) {
		validator := NewEventValidator(DefaultValidationConfig()) // Fresh validator for this test

		events := []Event{
			&RunStartedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunStarted,
					// EventID:   "event-1",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				RunID:    "run-pqr890", // Use unique run ID
				ThreadID: "thread-stu123",
			},
			&ToolCallStartEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeToolCallStart,
					// EventID:   "event-2",
					TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
				},
				ToolCallID:   "tool-vwx456", // Use unique tool ID
				ToolCallName: "calculator",
			},
			&ToolCallArgsEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeToolCallArgs,
					// EventID:   "event-3",
					TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
				},
				ToolCallID: "tool-vwx456",
				Delta:      "2 + 2",
			},
			&ToolCallEndEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeToolCallEnd,
					// EventID:   "event-4",
					TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
				},
				ToolCallID: "tool-vwx456",
			},
			&RunFinishedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunFinished,
					// EventID:   "event-5",
					TimestampMs: timePtr(time.Now().UnixMilli() + 4000),
				},
				RunID: "run-pqr890",
			},
		}

		result := validator.ValidateSequence(context.Background(), events)
		if !result.IsValid {
			t.Errorf("Complete tool call lifecycle should be valid, errors: %v", result.Errors)
		}
	})

	t.Run("multiple concurrent messages", func(t *testing.T) {
		validator := NewEventValidator(DefaultValidationConfig()) // Fresh validator for this test

		events := []Event{
			&RunStartedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunStarted,
					// EventID:   "event-1",
					TimestampMs: timePtr(time.Now().UnixMilli()),
				},
				RunID:    "run-hij789", // Use unique run ID
				ThreadID: "thread-klm012",
			},
			&TextMessageStartEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageStart,
					// EventID:   "event-2",
					TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
				},
				MessageID: "msg-nop345", // Use unique message IDs
			},
			&TextMessageStartEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageStart,
					// EventID:   "event-3",
					TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
				},
				MessageID: "msg-qrs678",
			},
			&TextMessageContentEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageContent,
					// EventID:   "event-4",
					TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
				},
				MessageID: "msg-nop345",
				Delta:     "First message",
			},
			&TextMessageContentEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageContent,
					// EventID:   "event-5",
					TimestampMs: timePtr(time.Now().UnixMilli() + 4000),
				},
				MessageID: "msg-qrs678",
				Delta:     "Second message",
			},
			&TextMessageEndEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageEnd,
					// EventID:   "event-6",
					TimestampMs: timePtr(time.Now().UnixMilli() + 5000),
				},
				MessageID: "msg-nop345",
			},
			&TextMessageEndEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeTextMessageEnd,
					// EventID:   "event-7",
					TimestampMs: timePtr(time.Now().UnixMilli() + 6000),
				},
				MessageID: "msg-qrs678",
			},
			&RunFinishedEvent{
				BaseEvent: &BaseEvent{
					EventType: EventTypeRunFinished,
					// EventID:   "event-8",
					TimestampMs: timePtr(time.Now().UnixMilli() + 7000),
				},
				RunID: "run-hij789",
			},
		}

		result := validator.ValidateSequence(context.Background(), events)
		if !result.IsValid {
			t.Errorf("Multiple concurrent messages should be valid, errors: %v", result.Errors)
		}
	})
}