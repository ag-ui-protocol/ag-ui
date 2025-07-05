package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/ag-ui/go-sdk/pkg/core/events"
)

func main() {
	fmt.Println("AG-UI Events Example")
	fmt.Println("====================")

	// 1. Basic event creation and validation
	demonstrateBasicEvents()

	// 2. Auto-generation features
	demonstrateAutoGeneration()

	// 3. Fluent builder pattern
	demonstrateFluentBuilder()

	// 4. Validation levels
	demonstrateValidationLevels()

	// 5. Event sequence validation
	demonstrateSequenceValidation()

	// 6. JSON and protobuf serialization
	demonstrateSerialization()

	// 7. State management
	demonstrateStateEvents()

	// 8. Custom events
	demonstrateCustomEvents()

	fmt.Println("\nAll examples completed successfully!")
}

func demonstrateBasicEvents() {
	fmt.Println("\n1. Basic Event Creation and Validation")
	fmt.Println("======================================")

	// Create basic events
	runEvent := events.NewRunStartedEvent("thread-123", "run-456")
	msgEvent := events.NewTextMessageStartEvent("msg-1", events.WithRole("user"))
	toolEvent := events.NewToolCallStartEvent("tool-1", "get_weather",
		events.WithParentMessageID("msg-1"))

	// Validate events
	events := []events.Event{runEvent, msgEvent, toolEvent}
	for i, event := range events {
		if err := event.Validate(); err != nil {
			log.Printf("Event %d validation failed: %v", i, err)
		} else {
			fmt.Printf("✓ %s event is valid\n", event.Type())
		}
	}
}

func demonstrateAutoGeneration() {
	fmt.Println("\n2. Automatic ID Generation")
	fmt.Println("===========================")

	// Manual ID generation
	runID := events.GenerateRunID()
	messageID := events.GenerateMessageID()
	toolCallID := events.GenerateToolCallID()
	fmt.Printf("Generated IDs: run=%s, message=%s, tool=%s\n", runID, messageID, toolCallID)

	// Auto-generation with options
	runEvent := events.NewRunStartedEventWithOptions("", "",
		events.WithAutoRunID(),
		events.WithAutoThreadID())

	msgEvent := events.NewTextMessageStartEvent("",
		events.WithAutoMessageID(),
		events.WithRole("assistant"))

	fmt.Printf("Auto-generated run event: threadId=%s, runId=%s\n",
		runEvent.ThreadID, runEvent.RunID)
	fmt.Printf("Auto-generated message event: messageId=%s\n",
		msgEvent.MessageID)
}

func demonstrateFluentBuilder() {
	fmt.Println("\n3. Fluent Builder Pattern")
	fmt.Println("=========================")

	// Simple event with builder
	event, err := events.NewEventBuilder().
		RunStarted().
		WithThreadID("thread-456").
		WithRunID("run-789").
		WithCurrentTimestamp().
		Build()

	if err != nil {
		log.Printf("Builder error: %v", err)
		return
	}

	fmt.Printf("✓ Built run started event with timestamp: %d\n", *event.Timestamp())

	// Complex event with auto-generation
	complexEvent, err := events.NewEventBuilder().
		TextMessageStart().
		WithRole("user").
		WithAutoGenerateIDs().
		Build()

	if err != nil {
		log.Printf("Builder error: %v", err)
		return
	}

	if msgEvent, ok := complexEvent.(*events.TextMessageStartEvent); ok {
		fmt.Printf("✓ Built message start event with auto ID: %s\n", msgEvent.MessageID)
	}

	// State delta with multiple operations
	stateEvent, err := events.NewEventBuilder().
		StateDelta().
		AddDeltaOperation("add", "/counter", 42).
		AddDeltaOperation("replace", "/status", "active").
		AddDeltaOperation("remove", "/oldField", nil).
		Build()

	if err != nil {
		log.Printf("Builder error: %v", err)
		return
	}

	if deltaEvent, ok := stateEvent.(*events.StateDeltaEvent); ok {
		fmt.Printf("✓ Built state delta event with %d operations\n", len(deltaEvent.Delta))
	}
}

func demonstrateValidationLevels() {
	fmt.Println("\n4. Validation Levels")
	fmt.Println("====================")

	// Create an event with some missing fields
	baseEvent := &events.BaseEvent{
		EventType: events.EventTypeRunStarted,
		// Missing timestamp
	}

	runEvent := &events.RunStartedEvent{
		BaseEvent: baseEvent,
		ThreadID:  "thread-123",
		RunID:     "", // Empty run ID
	}

	ctx := context.Background()

	// Strict validation (should fail)
	strictValidator := events.NewValidator(events.DefaultValidationConfig())
	if err := strictValidator.ValidateEvent(ctx, runEvent); err != nil {
		fmt.Printf("✓ Strict validation failed as expected: %v\n", err)
	}

	// Permissive validation (should pass with allowEmptyIDs)
	permissiveConfig := events.PermissiveValidationConfig()
	permissiveConfig.AllowEmptyIDs = true
	permissiveValidator := events.NewValidator(permissiveConfig)

	if err := permissiveValidator.ValidateEvent(ctx, runEvent); err != nil {
		fmt.Printf("Permissive validation failed: %v\n", err)
	} else {
		fmt.Printf("✓ Permissive validation passed\n")
	}

	// Custom validation with timestamp range
	start := time.Now().Add(-1 * time.Hour).UnixMilli()
	end := time.Now().Add(1 * time.Hour).UnixMilli()

	customConfig := &events.ValidationConfig{
		Level: events.ValidationCustom,
		CustomValidators: []events.CustomValidator{
			events.NewTimestampValidator(start, end),
			events.NewEventTypeValidator(events.EventTypeRunStarted, events.EventTypeRunFinished),
		},
	}

	customValidator := events.NewValidator(customConfig)

	// Create event with valid timestamp
	validEvent := events.NewRunStartedEvent("thread-123", "run-456")
	if err := customValidator.ValidateEvent(ctx, validEvent); err != nil {
		fmt.Printf("Custom validation failed: %v\n", err)
	} else {
		fmt.Printf("✓ Custom validation passed\n")
	}
}

func demonstrateSequenceValidation() {
	fmt.Println("\n5. Event Sequence Validation")
	fmt.Println("=============================")

	// Create a valid sequence
	validSequence := []events.Event{
		events.NewRunStartedEvent("thread-1", "run-1"),
		events.NewStepStartedEvent("planning"),
		events.NewTextMessageStartEvent("msg-1", events.WithRole("user")),
		events.NewTextMessageContentEvent("msg-1", "What's the weather like?"),
		events.NewTextMessageEndEvent("msg-1"),
		events.NewToolCallStartEvent("tool-1", "get_weather",
			events.WithParentMessageID("msg-1")),
		events.NewToolCallArgsEvent("tool-1", `{"location": "San Francisco"}`),
		events.NewToolCallEndEvent("tool-1"),
		events.NewStepFinishedEvent("planning"),
		events.NewRunFinishedEvent("thread-1", "run-1"),
	}

	if err := events.ValidateSequence(validSequence); err != nil {
		log.Printf("Valid sequence validation failed: %v", err)
	} else {
		fmt.Printf("✓ Valid sequence passed validation (%d events)\n", len(validSequence))
	}

	// Create an invalid sequence (duplicate message start)
	invalidSequence := []events.Event{
		events.NewTextMessageStartEvent("msg-1", events.WithRole("user")),
		events.NewTextMessageStartEvent("msg-1", events.WithRole("user")), // Duplicate
	}

	if err := events.ValidateSequence(invalidSequence); err != nil {
		fmt.Printf("✓ Invalid sequence correctly rejected: %v\n", err)
	} else {
		fmt.Println("Invalid sequence unexpectedly passed validation")
	}
}

func demonstrateSerialization() {
	fmt.Println("\n6. JSON and Protobuf Serialization")
	fmt.Println("===================================")

	// Create a complex event
	event := events.NewToolCallStartEvent("tool-123", "get_weather",
		events.WithParentMessageID("msg-456"))

	// JSON serialization
	jsonData, err := event.ToJSON()
	if err != nil {
		log.Printf("JSON serialization failed: %v", err)
		return
	}

	fmt.Printf("JSON: %s\n", string(jsonData))

	// JSON deserialization
	parsedEvent, err := events.EventFromJSON(jsonData)
	if err != nil {
		log.Printf("JSON deserialization failed: %v", err)
		return
	}

	fmt.Printf("✓ JSON round-trip successful, type: %s\n", parsedEvent.Type())

	// Protobuf serialization
	pbEvent, err := event.ToProtobuf()
	if err != nil {
		log.Printf("Protobuf serialization failed: %v", err)
		return
	}

	fmt.Printf("✓ Protobuf serialization successful\n")

	// Protobuf deserialization
	parsedPbEvent, err := events.EventFromProtobuf(pbEvent)
	if err != nil {
		log.Printf("Protobuf deserialization failed: %v", err)
		return
	}

	fmt.Printf("✓ Protobuf round-trip successful, type: %s\n", parsedPbEvent.Type())
}

func demonstrateStateEvents() {
	fmt.Println("\n7. State Management")
	fmt.Println("===================")

	// State snapshot
	state := map[string]any{
		"counter": 42,
		"status":  "active",
		"data":    []string{"item1", "item2", "item3"},
		"config": map[string]any{
			"timeout": 30,
			"retries": 3,
		},
	}

	snapshotEvent := events.NewStateSnapshotEvent(state)
	fmt.Printf("✓ Created state snapshot with %d top-level fields\n", len(state))

	// State delta with JSON Patch operations
	deltaOps := []events.JSONPatchOperation{
		{Op: "add", Path: "/newField", Value: "newValue"},
		{Op: "replace", Path: "/counter", Value: 43},
		{Op: "remove", Path: "/data/1"}, // Remove "item2"
		{Op: "replace", Path: "/config/timeout", Value: 60},
	}

	deltaEvent := events.NewStateDeltaEvent(deltaOps)
	fmt.Printf("✓ Created state delta with %d operations\n", len(deltaOps))

	// Validate events
	if err := snapshotEvent.Validate(); err != nil {
		log.Printf("Snapshot validation failed: %v", err)
	} else {
		fmt.Printf("✓ State snapshot validation passed\n")
	}

	if err := deltaEvent.Validate(); err != nil {
		log.Printf("Delta validation failed: %v", err)
	} else {
		fmt.Printf("✓ State delta validation passed\n")
	}

	// Messages snapshot
	messages := []events.Message{
		{
			ID:      "msg-1",
			Role:    "user",
			Content: stringPtr("Hello, how can you help me?"),
		},
		{
			ID:      "msg-2",
			Role:    "assistant",
			Content: stringPtr("I can help you with various tasks. What would you like to do?"),
		},
		{
			ID:   "msg-3",
			Role: "assistant",
			ToolCalls: []events.ToolCall{
				{
					ID:   "tool-1",
					Type: "function",
					Function: events.Function{
						Name:      "search_docs",
						Arguments: `{"query": "task examples"}`,
					},
				},
			},
		},
	}

	messagesEvent := events.NewMessagesSnapshotEvent(messages)
	fmt.Printf("✓ Created messages snapshot with %d messages\n", len(messages))

	if err := messagesEvent.Validate(); err != nil {
		log.Printf("Messages validation failed: %v", err)
	} else {
		fmt.Printf("✓ Messages snapshot validation passed\n")
	}
}

func demonstrateCustomEvents() {
	fmt.Println("\n8. Custom Events")
	fmt.Println("================")

	// Custom event with structured data
	customEvent := events.NewCustomEvent("user-interaction",
		events.WithValue(map[string]any{
			"action":    "button_click",
			"target":    "submit-form",
			"timestamp": time.Now().Unix(),
			"metadata": map[string]any{
				"page":    "/checkout",
				"session": "sess-789",
			},
		}))

	fmt.Printf("✓ Created custom event: %s\n", customEvent.Name)

	// Raw event for external data
	externalData := map[string]any{
		"source": "analytics-service",
		"event":  "page_view",
		"url":    "/dashboard",
		"userId": "user-123",
	}

	rawEvent := events.NewRawEvent(externalData,
		events.WithSource("analytics-service"))

	fmt.Printf("✓ Created raw event from source: %s\n", *rawEvent.Source)

	// Validate custom events
	events := []events.Event{customEvent, rawEvent}
	for i, event := range events {
		if err := event.Validate(); err != nil {
			log.Printf("Custom event %d validation failed: %v", i, err)
		} else {
			fmt.Printf("✓ Custom event %d validation passed\n", i)
		}
	}

	// Serialize custom event to see the output
	jsonData, err := customEvent.ToJSON()
	if err != nil {
		log.Printf("Custom event JSON serialization failed: %v", err)
	} else {
		var prettyJSON map[string]any
		_ = json.Unmarshal(jsonData, &prettyJSON) // Ignore error for pretty printing
		prettyData, _ := json.MarshalIndent(prettyJSON, "", "  ")
		fmt.Printf("Custom event JSON:\n%s\n", string(prettyData))
	}
}

// Helper function for creating string pointers
func stringPtr(s string) *string {
	return &s
}
