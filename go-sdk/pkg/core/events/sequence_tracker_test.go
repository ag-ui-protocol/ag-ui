package events

import (
	"fmt"
	"testing"
	"time"
)

func TestEventSequenceTracker_TrackEvent(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Test tracking a run started event
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}

	err := tracker.TrackEvent(runEvent)
	if err != nil {
		t.Errorf("TrackEvent() should not return error for valid event: %v", err)
	}

	// Verify event count
	if tracker.GetEventCount() != 1 {
		t.Errorf("Event count should be 1, got %d", tracker.GetEventCount())
	}

	// Verify run is active
	if !tracker.IsRunActive("run-123") {
		t.Error("Run should be active after tracking run started event")
	}

	// Test tracking nil event
	err = tracker.TrackEvent(nil)
	if err == nil {
		t.Error("TrackEvent() should return error for nil event")
	}
}

func TestEventSequenceTracker_MessageLifecycle(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Start a run first
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Track message lifecycle
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	// Verify message is active
	if !tracker.IsMessageActive("msg-123") {
		t.Error("Message should be active after tracking start event")
	}

	// Track content
	msgContent := &TextMessageContentEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageContent,
			// EventID:   "event-3",
			TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
		},
		MessageID: "msg-123",
		Delta:     "Hello",
	}
	tracker.TrackEvent(msgContent)

	// Track end
	msgEnd := &TextMessageEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageEnd,
			// EventID:   "event-4",
			TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgEnd)

	// Verify message is no longer active
	if tracker.IsMessageActive("msg-123") {
		t.Error("Message should not be active after tracking end event")
	}

	// Verify total event count
	if tracker.GetEventCount() != 4 {
		t.Errorf("Event count should be 4, got %d", tracker.GetEventCount())
	}
}

func TestEventSequenceTracker_ToolCallLifecycle(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Start a run first
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Track tool call lifecycle
	toolStart := &ToolCallStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallStart,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		ToolCallID:   "tool-123",
		ToolCallName: "calculator",
	}
	tracker.TrackEvent(toolStart)

	// Verify tool is active
	if !tracker.IsToolActive("tool-123") {
		t.Error("Tool call should be active after tracking start event")
	}

	// Track args
	toolArgs := &ToolCallArgsEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallArgs,
			// EventID:   "event-3",
			TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
		},
		ToolCallID: "tool-123",
		Delta:      "2 + 2",
	}
	tracker.TrackEvent(toolArgs)

	// Track end
	toolEnd := &ToolCallEndEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeToolCallEnd,
			// EventID:   "event-4",
			TimestampMs: timePtr(time.Now().UnixMilli() + 3000),
		},
		ToolCallID: "tool-123",
	}
	tracker.TrackEvent(toolEnd)

	// Verify tool is no longer active
	if tracker.IsToolActive("tool-123") {
		t.Error("Tool call should not be active after tracking end event")
	}
}

func TestEventSequenceTracker_StepLifecycle(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Start a run first
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Track step lifecycle
	stepStart := &StepStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeStepStarted,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		StepName: "step-1",
	}
	tracker.TrackEvent(stepStart)

	// Verify step is active
	if !tracker.IsStepActive("step-1") {
		t.Error("Step should be active after tracking start event")
	}

	// Track step finish
	stepFinish := &StepFinishedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeStepFinished,
			// EventID:   "event-3",
			TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
		},
		StepName: "step-1",
	}
	tracker.TrackEvent(stepFinish)

	// Verify step is no longer active
	if tracker.IsStepActive("step-1") {
		t.Error("Step should not be active after tracking finish event")
	}
}

func TestEventSequenceTracker_GetEventHistory(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track some events
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
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Get history
	history := tracker.GetEventHistory()
	if len(history) != len(events) {
		t.Errorf("History length should be %d, got %d", len(events), len(history))
	}

	// Verify events are in order
	for i, event := range history {
		if event.Type() != events[i].Type() {
			t.Errorf("Event %d type mismatch: expected %s, got %s", i, events[i].Type(), event.Type())
		}
	}
}

func TestEventSequenceTracker_GetSequenceInfo(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Initial state
	info := tracker.GetSequenceInfo()
	if info.TotalEvents != 0 {
		t.Errorf("Initial total events should be 0, got %d", info.TotalEvents)
	}
	if info.CurrentPhase != PhaseInit {
		t.Errorf("Initial phase should be Init, got %s", info.CurrentPhase)
	}

	// Track a run started event
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Check updated info
	info = tracker.GetSequenceInfo()
	if info.TotalEvents != 1 {
		t.Errorf("Total events should be 1, got %d", info.TotalEvents)
	}
	if info.CurrentPhase != PhaseRunning {
		t.Errorf("Phase should be Running, got %s", info.CurrentPhase)
	}
	if info.ActiveRuns != 1 {
		t.Errorf("Active runs should be 1, got %d", info.ActiveRuns)
	}
}

func TestEventSequenceTracker_ValidateSequence(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track a valid sequence
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
		&RunFinishedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunFinished,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			RunID: "run-123",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Validate sequence
	result := tracker.ValidateSequence()
	if !result.IsValid {
		t.Errorf("Valid sequence should pass validation, errors: %v", result.Errors)
	}
}

func TestEventSequenceTracker_CheckSequenceCompliance(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track a sequence with some issues
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Start a message but don't end it
	msgStart := &TextMessageStartEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeTextMessageStart,
			// EventID:   "event-2",
			TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
		},
		MessageID: "msg-123",
	}
	tracker.TrackEvent(msgStart)

	// Set the message start time to be old for testing
	state := tracker.GetCurrentState()
	if msgState, exists := state.ActiveMessages["msg-123"]; exists {
		msgState.StartTime = time.Now().Add(-2 * time.Hour)
	}

	// Check compliance
	report := tracker.CheckSequenceCompliance()
	if report.IsCompliant {
		t.Error("Sequence with orphaned message should not be compliant")
	}

	if len(report.Issues) == 0 {
		t.Error("Compliance report should contain issues")
	}

	// Check for orphaned message issue
	found := false
	for _, issue := range report.Issues {
		if issue.Type == "ORPHANED_MESSAGE" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Should find orphaned message issue")
	}
}

func TestEventSequenceTracker_GetEventsByType(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track events of different types
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
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			MessageID: "msg-456",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Get events by type
	runEvents := tracker.GetEventsByType(EventTypeRunStarted)
	if len(runEvents) != 1 {
		t.Errorf("Should have 1 run started event, got %d", len(runEvents))
	}

	messageEvents := tracker.GetEventsByType(EventTypeTextMessageStart)
	if len(messageEvents) != 2 {
		t.Errorf("Should have 2 message started events, got %d", len(messageEvents))
	}

	toolEvents := tracker.GetEventsByType(EventTypeToolCallStart)
	if len(toolEvents) != 0 {
		t.Errorf("Should have 0 tool call started events, got %d", len(toolEvents))
	}
}

func TestEventSequenceTracker_GetEventsByRunID(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track events for different runs
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
		&RunStartedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunStarted,
				// EventID:   "event-2",
				TimestampMs: timePtr(time.Now().UnixMilli() + 1000),
			},
			RunID:    "run-456",
			ThreadID: "thread-789",
		},
		&RunFinishedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunFinished,
				// EventID:   "event-3",
				TimestampMs: timePtr(time.Now().UnixMilli() + 2000),
			},
			RunID: "run-123",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Get events by run ID
	run123Events := tracker.GetEventsByRunID("run-123")
	if len(run123Events) != 2 {
		t.Errorf("Should have 2 events for run-123, got %d", len(run123Events))
	}

	run456Events := tracker.GetEventsByRunID("run-456")
	if len(run456Events) != 1 {
		t.Errorf("Should have 1 event for run-456, got %d", len(run456Events))
	}

	run999Events := tracker.GetEventsByRunID("run-999")
	if len(run999Events) != 0 {
		t.Errorf("Should have 0 events for run-999, got %d", len(run999Events))
	}
}

func TestEventSequenceTracker_Reset(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Track some events
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Verify state exists
	if tracker.GetEventCount() == 0 {
		t.Error("Should have events before reset")
	}

	// Reset
	err := tracker.Reset()
	if err != nil {
		t.Errorf("Reset should not return error: %v", err)
	}

	// Verify state is cleared
	if tracker.GetEventCount() != 0 {
		t.Errorf("Should have 0 events after reset, got %d", tracker.GetEventCount())
	}

	state := tracker.GetCurrentState()
	if len(state.ActiveRuns) != 0 {
		t.Errorf("Should have 0 active runs after reset, got %d", len(state.ActiveRuns))
	}

	if state.CurrentPhase != PhaseInit {
		t.Errorf("Phase should be Init after reset, got %s", state.CurrentPhase)
	}
}

func TestEventSequenceTracker_HistoryLimit(t *testing.T) {
	config := DefaultSequenceTrackerConfig()
	config.MaxHistorySize = 3 // Set small history size for testing
	tracker := NewEventSequenceTracker(config)

	// Track more events than the history limit
	for i := 0; i < 5; i++ {
		event := &RunStartedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunStarted,
				// EventID:   fmt.Sprintf("event-%d", i+1),
				TimestampMs: timePtr(time.Now().UnixMilli() + int64(i*1000)),
			},
			RunID:    fmt.Sprintf("run-%d", i+1),
			ThreadID: "thread-456",
		}
		tracker.TrackEvent(event)
	}

	// Verify history is limited
	history := tracker.GetEventHistory()
	if len(history) != 3 {
		t.Errorf("History should be limited to 3 events, got %d", len(history))
	}

	// Verify we kept the most recent events
	lastEvent := history[len(history)-1].(*RunStartedEvent)
	if lastEvent.RunID != "run-5" {
		t.Errorf("Last event should be run-5, got %s", lastEvent.RunID)
	}
}

func TestEventSequenceTracker_GetEventsInRange(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	baseTime := time.Now()

	// Track events with different timestamps
	events := []Event{
		&RunStartedEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeRunStarted,
				// EventID:   "event-1",
				TimestampMs: timePtr(baseTime.UnixMilli()),
			},
			RunID:    "run-123",
			ThreadID: "thread-456",
		},
		&TextMessageStartEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageStart,
				// EventID:   "event-2",
				TimestampMs: timePtr(baseTime.Add(time.Hour).UnixMilli()),
			},
			MessageID: "msg-123",
		},
		&TextMessageEndEvent{
			BaseEvent: &BaseEvent{
				EventType: EventTypeTextMessageEnd,
				// EventID:   "event-3",
				TimestampMs: timePtr(baseTime.Add(2 * time.Hour).UnixMilli()),
			},
			MessageID: "msg-123",
		},
	}

	for _, event := range events {
		tracker.TrackEvent(event)
	}

	// Get events in specific range
	start := baseTime.Add(-30 * time.Minute)
	end := baseTime.Add(90 * time.Minute)
	
	rangeEvents := tracker.GetEventsInRange(start, end)
	if len(rangeEvents) != 2 {
		t.Errorf("Should have 2 events in range, got %d", len(rangeEvents))
	}
}

func TestSequenceTrackerConfig(t *testing.T) {
	config := DefaultSequenceTrackerConfig()

	// Test default values
	if config.MaxHistorySize != 10000 {
		t.Errorf("Default MaxHistorySize should be 10000, got %d", config.MaxHistorySize)
	}

	if !config.EnableStateSnapshots {
		t.Error("Default EnableStateSnapshots should be true")
	}

	if !config.TrackMetrics {
		t.Error("Default TrackMetrics should be true")
	}

	if config.ValidateOnAdd {
		t.Error("Default ValidateOnAdd should be false")
	}

	if !config.StrictSequencing {
		t.Error("Default StrictSequencing should be true")
	}
}

func TestEventSequenceTracker_GetLastEvent(t *testing.T) {
	tracker := NewEventSequenceTracker(DefaultSequenceTrackerConfig())

	// Initially no events
	lastEvent := tracker.GetLastEvent()
	if lastEvent != nil {
		t.Error("GetLastEvent() should return nil when no events tracked")
	}

	// Track an event
	runEvent := &RunStartedEvent{
		BaseEvent: &BaseEvent{
			EventType: EventTypeRunStarted,
			// EventID:   "event-1",
			TimestampMs: timePtr(time.Now().UnixMilli()),
		},
		RunID:    "run-123",
		ThreadID: "thread-456",
	}
	tracker.TrackEvent(runEvent)

	// Get last event
	lastEvent = tracker.GetLastEvent()
	if lastEvent == nil {
		t.Error("GetLastEvent() should return the last event")
	}

	if lastEvent.Type() != EventTypeRunStarted {
		t.Errorf("Last event type should be RunStarted, got %s", lastEvent.Type())
	}
}