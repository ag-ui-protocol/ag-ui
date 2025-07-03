package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/ag-ui/go-sdk/pkg/core/events"
)

func main() {
	fmt.Println("AG-UI Events Example")
	fmt.Println("====================")

	// Create a sequence of events representing an agent interaction
	sequence := createEventSequence()

	// Demonstrate validation
	fmt.Println("\n1. Validating event sequence...")
	if err := events.ValidateSequence(sequence); err != nil {
		log.Fatal("Validation failed:", err)
	}
	fmt.Println("✓ Event sequence is valid")

	// Demonstrate JSON serialization
	fmt.Println("\n2. JSON serialization example...")
	demonstrateJSONSerialization(sequence[1]) // Use the message start event

	// Demonstrate protobuf conversion
	fmt.Println("\n3. Protobuf conversion example...")
	demonstrateProtobufConversion(sequence[2]) // Use the message content event

	// Demonstrate event creation with options
	fmt.Println("\n4. Event creation with options...")
	demonstrateEventOptions()

	// Demonstrate state events
	fmt.Println("\n5. State event examples...")
	demonstrateStateEvents()

	fmt.Println("\nAll examples completed successfully!")
}

func createEventSequence() []events.Event {
	fmt.Println("Creating a typical agent interaction sequence...")

	// Create events in order
	runStarted := events.NewRunStartedEvent("thread-123", "run-456")
	fmt.Printf("  - Created RUN_STARTED event (Run ID: %s)\n", runStarted.RunID)

	msgStart := events.NewTextMessageStartEvent("msg-1", events.WithRole("user"))
	fmt.Printf("  - Created TEXT_MESSAGE_START event (Message ID: %s)\n", msgStart.MessageID)

	msgContent1 := events.NewTextMessageContentEvent("msg-1", "What's the weather like in ")
	msgContent2 := events.NewTextMessageContentEvent("msg-1", "San Francisco?")
	fmt.Printf("  - Created TEXT_MESSAGE_CONTENT events\n")

	msgEnd := events.NewTextMessageEndEvent("msg-1")
	fmt.Printf("  - Created TEXT_MESSAGE_END event\n")

	toolStart := events.NewToolCallStartEvent("tool-1", "get_weather", events.WithParentMessageID("msg-1"))
	fmt.Printf("  - Created TOOL_CALL_START event (Tool: %s)\n", toolStart.ToolCallName)

	toolArgs := events.NewToolCallArgsEvent("tool-1", `{"location": "San Francisco, CA"}`)
	fmt.Printf("  - Created TOOL_CALL_ARGS event\n")

	toolEnd := events.NewToolCallEndEvent("tool-1")
	fmt.Printf("  - Created TOOL_CALL_END event\n")

	runFinished := events.NewRunFinishedEvent("thread-123", "run-456")
	fmt.Printf("  - Created RUN_FINISHED event\n")

	return []events.Event{
		runStarted, msgStart, msgContent1, msgContent2, msgEnd,
		toolStart, toolArgs, toolEnd, runFinished,
	}
}

func demonstrateJSONSerialization(event events.Event) {
	// Serialize to JSON
	jsonData, err := event.ToJSON()
	if err != nil {
		log.Fatal("JSON serialization failed:", err)
	}

	// Pretty print the JSON
	var prettyJSON map[string]interface{}
	json.Unmarshal(jsonData, &prettyJSON)
	prettyData, _ := json.MarshalIndent(prettyJSON, "", "  ")

	fmt.Printf("Event type: %s\n", event.Type())
	fmt.Printf("JSON output:\n%s\n", string(prettyData))

	// Parse back from JSON
	parsedEvent, err := events.EventFromJSON(jsonData)
	if err != nil {
		log.Fatal("JSON parsing failed:", err)
	}

	fmt.Printf("✓ Successfully parsed back from JSON (type: %s)\n", parsedEvent.Type())
}

func demonstrateProtobufConversion(event events.Event) {
	// Convert to protobuf
	_, err := event.ToProtobuf()
	if err != nil {
		log.Fatal("Protobuf conversion failed:", err)
	}

	fmt.Printf("Event type: %s\n", event.Type())
	fmt.Printf("✓ Successfully converted to protobuf\n")

	// Serialize to binary
	binaryData, err := events.EventToProtobufBytes(event)
	if err != nil {
		log.Fatal("Protobuf binary serialization failed:", err)
	}

	fmt.Printf("✓ Binary serialization: %d bytes\n", len(binaryData))

	// Parse back from binary
	parsedEvent, err := events.EventFromProtobufBytes(binaryData)
	if err != nil {
		log.Fatal("Protobuf binary parsing failed:", err)
	}

	fmt.Printf("✓ Successfully parsed back from binary (type: %s)\n", parsedEvent.Type())
}

func demonstrateEventOptions() {
	// Run error with options
	errorEvent := events.NewRunErrorEvent(
		"Database connection failed",
		events.WithErrorCode("DB_CONNECTION_ERROR"),
		events.WithRunID("run-789"),
	)
	fmt.Printf("Run error event: %s (code: %s)\n", errorEvent.Message, *errorEvent.Code)

	// Tool call with parent message
	toolEvent := events.NewToolCallStartEvent(
		"tool-2",
		"search_database",
		events.WithParentMessageID("msg-2"),
	)
	fmt.Printf("Tool call event: %s (parent: %s)\n", toolEvent.ToolCallName, *toolEvent.ParentMessageID)

	// Raw event with source
	rawEvent := events.NewRawEvent(
		map[string]interface{}{"system": "external", "data": "raw"},
		events.WithSource("external-api"),
	)
	fmt.Printf("Raw event from source: %s\n", *rawEvent.Source)

	// Custom event with value
	customEvent := events.NewCustomEvent(
		"user-interaction",
		events.WithValue(map[string]interface{}{"action": "click", "target": "button"}),
	)
	fmt.Printf("Custom event: %s\n", customEvent.Name)
}

func demonstrateStateEvents() {
	// State snapshot
	state := map[string]interface{}{
		"counter": 42,
		"status":  "active",
		"user_id": "user-123",
		"preferences": map[string]interface{}{
			"theme": "dark",
			"lang":  "en",
		},
	}

	snapshotEvent := events.NewStateSnapshotEvent(state)
	fmt.Printf("State snapshot with %d top-level keys\n", len(state))

	// State delta (JSON Patch operations)
	delta := []events.JSONPatchOperation{
		{Op: "replace", Path: "/counter", Value: 43},
		{Op: "add", Path: "/preferences/notifications", Value: true},
		{Op: "remove", Path: "/status"},
	}

	deltaEvent := events.NewStateDeltaEvent(delta)
	fmt.Printf("State delta with %d operations:\n", len(delta))
	for i, op := range delta {
		fmt.Printf("  %d. %s %s\n", i+1, op.Op, op.Path)
	}

	// Messages snapshot
	messages := []events.Message{
		{
			ID:      "msg-1",
			Role:    "user",
			Content: stringPtr("Hello, can you help me?"),
		},
		{
			ID:   "msg-2",
			Role: "assistant",
			ToolCalls: []events.ToolCall{
				{
					ID:   "tool-1",
					Type: "function",
					Function: events.Function{
						Name:      "search_help",
						Arguments: `{"query": "user assistance"}`,
					},
				},
			},
		},
	}

	messagesEvent := events.NewMessagesSnapshotEvent(messages)
	fmt.Printf("Messages snapshot with %d messages\n", len(messages))

	// Validate all state events
	stateEvents := []events.Event{snapshotEvent, deltaEvent, messagesEvent}
	if err := events.ValidateSequence(stateEvents); err != nil {
		log.Fatal("State events validation failed:", err)
	}
	fmt.Printf("✓ All state events validated successfully\n")
}

func stringPtr(s string) *string {
	return &s
}
