package events

import (
	"testing"
	"time"
)

func TestIDTracker_TrackEvent(t *testing.T) {
	tracker := NewIDTracker()

	// Track message events
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType:   EventTypeTextMessageStart,
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	msgContent := &TextMessageContentEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageContent,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		MessageID: "msg-123",
		Delta:     "Hello",
	}
	tracker.TrackEvent(msgContent)

	msgEnd := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageEnd,
			// EventID:   "event-3",
			TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgEnd)

	// Verify events are tracked
	start, contents, end := tracker.GetMessageTriplet("msg-123")
	
	if start == nil {
		t.Error("Message start should be tracked")
	}
	if start.MessageID != "msg-123" {
		t.Errorf("Start message ID should be msg-123, got %s", start.MessageID)
	}

	if len(contents) != 1 {
		t.Errorf("Should have 1 content event, got %d", len(contents))
	}
	if contents[0].Delta != "Hello" {
		t.Errorf("Content delta should be 'Hello', got %s", contents[0].Delta)
	}

	if end == nil {
		t.Error("Message end should be tracked")
	}
	if end.MessageID != "msg-123" {
		t.Errorf("End message ID should be msg-123, got %s", end.MessageID)
	}
}

func TestIDTracker_ToolCallTracking(t *testing.T) {
	tracker := NewIDTracker()

	// Track tool call events
	toolStart := &ToolCallStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallStart,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		ToolCallID:   "tool-123",
		ToolCallName: "calculator",
	}
	tracker.TrackEvent(toolStart)

	toolArgs := &ToolCallArgsEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallArgs,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		ToolCallID: "tool-123",
		Delta:      "2 + 2",
	}
	tracker.TrackEvent(toolArgs)

	toolEnd := &ToolCallEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallEnd,
			// EventID:   "event-3",
			TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
		},
		ToolCallID: "tool-123",
	}
	tracker.TrackEvent(toolEnd)

	// Verify events are tracked
	start, args, end := tracker.GetToolCallTriplet("tool-123")
	
	if start == nil {
		t.Error("Tool call start should be tracked")
	}
	if start.ToolCallID != "tool-123" {
		t.Errorf("Start tool call ID should be tool-123, got %s", start.ToolCallID)
	}

	if len(args) != 1 {
		t.Errorf("Should have 1 args event, got %d", len(args))
	}
	if args[0].Delta != "2 + 2" {
		t.Errorf("Args delta should be '2 + 2', got %s", args[0].Delta)
	}

	if end == nil {
		t.Error("Tool call end should be tracked")
	}
	if end.ToolCallID != "tool-123" {
		t.Errorf("End tool call ID should be tool-123, got %s", end.ToolCallID)
	}
}

func TestIDTracker_RunLifecycle(t *testing.T) {
	tracker := NewIDTracker()

	// Track run events
	runStart := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runStart)

	runFinish := &RunFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunFinished,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		RunID: "run-123",
	}
	tracker.TrackEvent(runFinish)

	// Verify events are tracked
	start, finish, error := tracker.GetRunLifecycle("run-123")
	
	if start == nil {
		t.Error("Run start should be tracked")
	}
	if start.RunID != "run-123" {
		t.Errorf("Start run ID should be run-123, got %s", start.RunID)
	}

	if finish == nil {
		t.Error("Run finish should be tracked")
	}
	if finish.RunID != "run-123" {
		t.Errorf("Finish run ID should be run-123, got %s", finish.RunID)
	}

	if error != nil {
		t.Error("Run error should be nil")
	}
}

func TestIDTracker_StepPairs(t *testing.T) {
	tracker := NewIDTracker()

	// Track step events
	stepStart := &StepStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeStepStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		StepName: "step-1",
	}
	tracker.TrackEvent(stepStart)

	stepFinish := &StepFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeStepFinished,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		StepName: "step-1",
	}
	tracker.TrackEvent(stepFinish)

	// Verify events are tracked
	start, finish := tracker.GetStepPair("step-1")
	
	if start == nil {
		t.Error("Step start should be tracked")
	}
	if start.StepName != "step-1" {
		t.Errorf("Start step name should be step-1, got %s", start.StepName)
	}

	if finish == nil {
		t.Error("Step finish should be tracked")
	}
	if finish.StepName != "step-1" {
		t.Errorf("Finish step name should be step-1, got %s", finish.StepName)
	}
}

func TestIDTracker_ValidateIDConsistency_ValidSequence(t *testing.T) {
	tracker := NewIDTracker()

	// Track a valid sequence
	events := []Event{
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-1",
				TimestampMs: timePtr(time.Now().UnixMilli()),
			},
			MessageID: "msg-123",
		},
		&TextMessageContentEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageContent,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			MessageID: "msg-123",
			Delta:     "Hello",
		},
		&TextMessageEndEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageEnd,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			MessageID: "msg-123",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) != 0 {
		t.Errorf("Valid sequence should have no errors, got %d errors: %v", len(errors), errors)
	}
}

func TestIDTracker_ValidateIDConsistency_OrphanedContent(t *testing.T) {
	tracker := NewIDTracker()

	// Track content without start
	msgContent := &TextMessageContentEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageContent,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
		Delta:     "Hello",
	}
	tracker.TrackEvent(msgContent)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for orphaned content")
	}

	// Check for orphaned content error
	found := false
	for _, err := range errors {
		if err.RuleID == "MESSAGE_ORPHANED_CONTENT" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find MESSAGE_ORPHANED_CONTENT error")
	}
}

func TestIDTracker_ValidateIDConsistency_OrphanedEnd(t *testing.T) {
	tracker := NewIDTracker()

	// Track end without start
	msgEnd := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageEnd,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgEnd)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for orphaned end")
	}

	// Check for orphaned end error
	found := false
	for _, err := range errors {
		if err.RuleID == "MESSAGE_ORPHANED_END" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find MESSAGE_ORPHANED_END error")
	}
}

func TestIDTracker_ValidateIDConsistency_IncompleteMessage(t *testing.T) {
	tracker := NewIDTracker()

	// Track start without end
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for incomplete message")
	}

	// Check for incomplete message error
	found := false
	for _, err := range errors {
		if err.RuleID == "MESSAGE_INCOMPLETE" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find MESSAGE_INCOMPLETE error")
	}
}

func TestIDTracker_ValidateIDConsistency_MessageNoContent(t *testing.T) {
	tracker := NewIDTracker()

	// Track start and end without content
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	msgEnd := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageEnd,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgEnd)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for message without content")
	}

	// Check for no content error
	found := false
	for _, err := range errors {
		if err.RuleID == "MESSAGE_NO_CONTENT" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find MESSAGE_NO_CONTENT error")
	}
}

func TestIDTracker_ValidateIDConsistency_ToolCallErrors(t *testing.T) {
	tracker := NewIDTracker()

	// Track tool args without start
	toolArgs := &ToolCallArgsEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallArgs,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		ToolCallID: "tool-123",
		Delta:      "2 + 2",
	}
	tracker.TrackEvent(toolArgs)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for orphaned tool args")
	}

	// Check for orphaned args error
	found := false
	for _, err := range errors {
		if err.RuleID == "TOOL_ORPHANED_ARGS" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find TOOL_ORPHANED_ARGS error")
	}
}

func TestIDTracker_ValidateIDConsistency_RunErrors(t *testing.T) {
	tracker := NewIDTracker()

	// Track run finish without start
	runFinish := &RunFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunFinished,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID: "run-123",
	}
	tracker.TrackEvent(runFinish)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for orphaned run finish")
	}

	// Check for orphaned finish error
	found := false
	for _, err := range errors {
		if err.RuleID == "RUN_ORPHANED_FINISH" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find RUN_ORPHANED_FINISH error")
	}
}

func TestIDTracker_ValidateIDConsistency_StepErrors(t *testing.T) {
	tracker := NewIDTracker()

	// Track step finish without start
	stepFinish := &StepFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeStepFinished,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		StepName: "step-1",
	}
	tracker.TrackEvent(stepFinish)

	// Validate consistency
	errors := tracker.ValidateIDConsistency()
	if len(errors) == 0 {
		t.Error("Should have errors for orphaned step finish")
	}

	// Check for orphaned finish error
	found := false
	for _, err := range errors {
		if err.RuleID == "STEP_ORPHANED_FINISH" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find STEP_ORPHANED_FINISH error")
	}
}

func TestIDTracker_ValidateIDConsistency_DuplicateStarts(t *testing.T) {
	tracker := NewIDTracker()

	// Track duplicate run starts
	runStart1 := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runStart1)

	runStart2 := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		RunID:    "run-123",
		ThreadID: "thread-789",
	}
	tracker.TrackEvent(runStart2)

	// Note: The current implementation doesn't actually track duplicate starts
	// since the map just overwrites. This test documents the current behavior.
	
	// Get the final start event (should be the last one)
	start, _, _ := tracker.GetRunLifecycle("run-123")
	if start.ThreadID != "thread-789" {
		t.Errorf("Expected thread-789, got %s", start.ThreadID)
	}
}

func TestIDTracker_GetStatistics(t *testing.T) {
	tracker := NewIDTracker()

	// Track various events
	events := []Event{
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-1",
				TimestampMs: timePtr(time.Now().UnixMilli()),
			},
			MessageID: "msg-123",
		},
		&TextMessageContentEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageContent,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			MessageID: "msg-123",
			Delta:     "Hello",
		},
		&ToolCallStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeToolCallStart,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			ToolCallID:   "tool-123",
			ToolCallName: "calculator",
		},
		&RunStartedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunStarted,
				// EventID:   "event-4",
				TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
			},
			RunID:    "run-123",
			ThreadID: "thread-456",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Get statistics
	stats := tracker.GetStatistics()
	
	if stats.MessageStartCount != 1 {
		t.Errorf("Expected 1 message start, got %d", stats.MessageStartCount)
	}
	
	if stats.MessageContentCount != 1 {
		t.Errorf("Expected 1 message content, got %d", stats.MessageContentCount)
	}
	
	if stats.ToolStartCount != 1 {
		t.Errorf("Expected 1 tool start, got %d", stats.ToolStartCount)
	}
	
	if stats.RunStartCount != 1 {
		t.Errorf("Expected 1 run start, got %d", stats.RunStartCount)
	}
	
	if stats.MessageEndCount != 0 {
		t.Errorf("Expected 0 message ends, got %d", stats.MessageEndCount)
	}
}

func TestIDTracker_Reset(t *testing.T) {
	tracker := NewIDTracker()

	// Track some events
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	// Verify events are tracked
	start, _, _ := tracker.GetMessageTriplet("msg-123")
	if start == nil {
		t.Error("Message start should be tracked before reset")
	}

	// Reset
	tracker.Reset()

	// Verify events are cleared
	start, _, _ = tracker.GetMessageTriplet("msg-123")
	if start != nil {
		t.Error("Message start should be cleared after reset")
	}

	// Verify statistics are cleared
	stats := tracker.GetStatistics()
	if stats.MessageStartCount != 0 {
		t.Errorf("Message start count should be 0 after reset, got %d", stats.MessageStartCount)
	}
}

func TestSequenceIDValidator_ValidateSequence(t *testing.T) {
	validator := NewSequenceIDValidator()

	// Test valid sequence
	validEvents := []Event{
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-1",
				TimestampMs: timePtr(time.Now().UnixMilli()),
			},
			MessageID: "msg-123",
		},
		&TextMessageContentEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageContent,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			MessageID: "msg-123",
			Delta:     "Hello",
		},
		&TextMessageEndEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageEnd,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			MessageID: "msg-123",
		},
	}

	result := validator.ValidateSequence(validEvents)
	if !result.IsValid {
		t.Errorf("Valid sequence should pass validation, errors: %v", result.Errors)
	}

	// Test invalid sequence
	invalidEvents := []Event{
		&TextMessageContentEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageContent,
				// EventID:   "event-1",
				TimestampMs: timePtr(time.Now().UnixMilli()),
			},
			MessageID: "msg-123",
			Delta:     "Hello",
		},
	}

	result = validator.ValidateSequence(invalidEvents)
	if result.IsValid {
		t.Error("Invalid sequence should fail validation")
	}

	if len(result.Errors) == 0 {
		t.Error("Invalid sequence should have errors")
	}
}

func TestSequenceIDValidator_GetTracker(t *testing.T) {
	validator := NewSequenceIDValidator()
	
	tracker := validator.GetTracker()
	if tracker == nil {
		t.Error("GetTracker() should return the internal tracker")
	}

	// Verify it's the same tracker
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		MessageID: "msg-123",
	}
	
	tracker.TrackEvent(msgStart)
	
	// Get the tracker again and verify it has the same state
	tracker2 := validator.GetTracker()
	start, _, _ := tracker2.GetMessageTriplet("msg-123")
	if start == nil {
		t.Error("Tracker should maintain state across calls")
	}
}