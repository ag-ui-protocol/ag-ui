// Protocol Buffer Compatibility Verification Script
//
// This script verifies that the generated Go protocol buffer code maintains
// compatibility with the original TypeScript SDK definitions.
//
// Run with: go run scripts/verify-proto-compatibility.go

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/ag-ui/go-sdk/pkg/proto/generated"
)

func main() {
	fmt.Println("🔍 Verifying Protocol Buffer Compatibility...")
	fmt.Println(strings.Repeat("=", 50))

	// Test 1: Verify all event types are present
	fmt.Println("\n1. Testing Event Types...")
	testEventTypes()

	// Test 2: Verify JSON field naming compatibility
	fmt.Println("\n2. Testing JSON Field Naming...")
	testJSONFieldNaming()

	// Test 3: Verify complex message structures
	fmt.Println("\n3. Testing Complex Message Structures...")
	testComplexStructures()

	// Test 4: Verify protobuf binary compatibility
	fmt.Println("\n4. Testing Protobuf Binary Serialization...")
	testBinaryCompatibility()

	fmt.Println("\n✅ All compatibility tests passed!")
	fmt.Println("🎉 Go SDK protobuf generation is compatible with TypeScript SDK")
}

func testEventTypes() {
	// Pre-allocate slice with known capacity for better memory efficiency
	expectedTypes := make([]generated.EventType, 0, 16)
	expectedTypes = append(expectedTypes,
		generated.EventType_TEXT_MESSAGE_START,
		generated.EventType_TEXT_MESSAGE_CONTENT,
		generated.EventType_TEXT_MESSAGE_END,
		generated.EventType_TOOL_CALL_START,
		generated.EventType_TOOL_CALL_ARGS,
		generated.EventType_TOOL_CALL_END,
		generated.EventType_STATE_SNAPSHOT,
		generated.EventType_STATE_DELTA,
		generated.EventType_MESSAGES_SNAPSHOT,
		generated.EventType_RAW,
		generated.EventType_CUSTOM,
		generated.EventType_RUN_STARTED,
		generated.EventType_RUN_FINISHED,
		generated.EventType_RUN_ERROR,
		generated.EventType_STEP_STARTED,
		generated.EventType_STEP_FINISHED,
	)

	fmt.Printf("   - Checking %d event types...\n", len(expectedTypes))
	for i, eventType := range expectedTypes {
		// Ensure safe conversion - event types should be small integers
		if i < 0 || i > 255 {
			log.Fatalf("   ❌ Event type index out of safe range: %d", i)
		}
		expectedValue := int32(i)
		actualValue := int32(eventType)
		if actualValue != expectedValue {
			log.Fatalf("   ❌ Event type %s has wrong value: got %d, expected %d", eventType.String(), actualValue, expectedValue)
		}
	}
	fmt.Printf("   ✅ All %d event types have correct values\n", len(expectedTypes))
}

func testJSONFieldNaming() {
	// Create a complex event to test field naming
	baseEvent := &generated.BaseEvent{
		Type:      generated.EventType_TOOL_CALL_START,
		Timestamp: proto.Int64(time.Now().Unix()),
	}

	toolCallEvent := &generated.ToolCallStartEvent{
		BaseEvent:       baseEvent,
		ToolCallId:      "tool-123",
		ToolCallName:    "test_function",
		ParentMessageId: proto.String("msg-456"),
	}

	// Convert to JSON
	jsonData, err := protojson.Marshal(toolCallEvent)
	if err != nil {
		log.Fatalf("   ❌ Failed to marshal to JSON: %v", err)
	}

	// Parse JSON to verify field names
	var jsonObj map[string]any
	if err := json.Unmarshal(jsonData, &jsonObj); err != nil {
		log.Fatalf("   ❌ Failed to parse JSON: %v", err)
	}

	// Verify camelCase field names (compatible with TypeScript)
	expectedFields := map[string]bool{
		"baseEvent":       true,
		"toolCallId":      true,
		"toolCallName":    true,
		"parentMessageId": true,
	}

	for field := range expectedFields {
		if _, exists := jsonObj[field]; !exists {
			log.Fatalf("   ❌ Missing expected field in JSON: %s", field)
		}
	}

	// Verify baseEvent structure
	baseEventObj, ok := jsonObj["baseEvent"].(map[string]any)
	if !ok {
		log.Fatal("   ❌ baseEvent field is not an object")
	}

	if _, exists := baseEventObj["type"]; !exists {
		log.Fatal("   ❌ Missing type field in baseEvent")
	}

	fmt.Println("   ✅ JSON field naming is compatible with TypeScript SDK")
}

func testComplexStructures() {
	// Test Message structure with tool calls
	message := &generated.Message{
		Id:      "msg-1",
		Role:    "assistant",
		Content: proto.String("Here's the weather information."),
		ToolCalls: []*generated.ToolCall{
			{
				Id:   "tool-1",
				Type: "function",
				Function: &generated.ToolCall_Function{
					Name:      "get_weather",
					Arguments: `{"location": "San Francisco", "units": "celsius"}`,
				},
			},
		},
	}

	// Test MessagesSnapshotEvent
	baseEvent := &generated.BaseEvent{
		Type:      generated.EventType_MESSAGES_SNAPSHOT,
		Timestamp: proto.Int64(time.Now().Unix()),
	}

	snapshotEvent := &generated.MessagesSnapshotEvent{
		BaseEvent: baseEvent,
		Messages:  []*generated.Message{message},
	}

	// Test JSON serialization
	jsonData, err := protojson.Marshal(snapshotEvent)
	if err != nil {
		log.Fatalf("   ❌ Failed to marshal complex structure: %v", err)
	}

	// Test JSON deserialization
	var decoded generated.MessagesSnapshotEvent
	if err := protojson.Unmarshal(jsonData, &decoded); err != nil {
		log.Fatalf("   ❌ Failed to unmarshal complex structure: %v", err)
	}

	// Verify structure integrity
	if len(decoded.Messages) != 1 {
		log.Fatalf("   ❌ Message count mismatch: got %d, expected 1", len(decoded.Messages))
	}

	decodedMessage := decoded.Messages[0]
	if decodedMessage.Id != message.Id {
		log.Fatalf("   ❌ Message ID mismatch: got %s, expected %s", decodedMessage.Id, message.Id)
	}

	if len(decodedMessage.ToolCalls) != 1 {
		log.Fatalf("   ❌ ToolCall count mismatch: got %d, expected 1", len(decodedMessage.ToolCalls))
	}

	toolCall := decodedMessage.ToolCalls[0]
	if toolCall.Function.Name != "get_weather" {
		log.Fatalf("   ❌ Function name mismatch: got %s, expected get_weather", toolCall.Function.Name)
	}

	fmt.Println("   ✅ Complex message structures work correctly")
}

func testBinaryCompatibility() {
	// Create an event and test binary serialization
	baseEvent := &generated.BaseEvent{
		Type:      generated.EventType_TEXT_MESSAGE_START,
		Timestamp: proto.Int64(1698765432123),
	}

	textEvent := &generated.TextMessageStartEvent{
		BaseEvent: baseEvent,
		MessageId: "msg-test-123",
		Role:      proto.String("user"),
	}

	// Serialize to binary
	binaryData, err := proto.Marshal(textEvent)
	if err != nil {
		log.Fatalf("   ❌ Failed to marshal to binary: %v", err)
	}

	// Deserialize from binary
	var decoded generated.TextMessageStartEvent
	if err := proto.Unmarshal(binaryData, &decoded); err != nil {
		log.Fatalf("   ❌ Failed to unmarshal from binary: %v", err)
	}

	// Verify data integrity
	if decoded.MessageId != textEvent.MessageId {
		log.Fatalf("   ❌ Binary serialization corrupted MessageId: got %s, expected %s",
			decoded.MessageId, textEvent.MessageId)
	}

	if decoded.GetRole() != textEvent.GetRole() {
		log.Fatalf("   ❌ Binary serialization corrupted Role: got %s, expected %s",
			decoded.GetRole(), textEvent.GetRole())
	}

	if decoded.BaseEvent.Type != textEvent.BaseEvent.Type {
		log.Fatalf("   ❌ Binary serialization corrupted Type: got %s, expected %s",
			decoded.BaseEvent.Type.String(), textEvent.BaseEvent.Type.String())
	}

	fmt.Printf("   ✅ Binary protobuf serialization works correctly (%d bytes)\n", len(binaryData))
}
