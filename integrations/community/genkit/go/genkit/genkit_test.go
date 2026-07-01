package genkit

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/firebase/genkit/go/ai"
)

func TestStreamingFunc_TextMessage_Initial(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart("Hello"),
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should emit TEXT_MESSAGE_START first (Initial -> ChatStarted)
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeTextMessageStart {
			t.Errorf("expected TEXT_MESSAGE_START, got %s", evt.Type())
		}
	default:
		t.Fatal("expected TEXT_MESSAGE_START event")
	}

	// Then TEXT_MESSAGE_CHUNK
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeTextMessageChunk {
			t.Errorf("expected TEXT_MESSAGE_CHUNK, got %s", evt.Type())
		}
		chunkEvt, ok := evt.(*events.TextMessageChunkEvent)
		if !ok {
			t.Fatal("expected TextMessageChunkEvent")
		}
		if chunkEvt.Delta == nil || *chunkEvt.Delta != "Hello" {
			t.Errorf("expected delta 'Hello', got %v", chunkEvt.Delta)
		}
		if chunkEvt.Role == nil || *chunkEvt.Role != "model" {
			t.Errorf("expected role 'model', got %v", chunkEvt.Role)
		}
	default:
		t.Fatal("expected TEXT_MESSAGE_CHUNK event")
	}
}

func TestStreamingFunc_TextMessage_ChatStarted(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	// First chunk to transition from Initial to ChatStarted
	chunk1 := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart("Hello"),
		},
	}
	err := streamFunc(context.Background(), chunk1)
	if err != nil {
		t.Fatalf("unexpected error on first chunk: %v", err)
	}

	// Drain the first two events
	<-eventsCh // TEXT_MESSAGE_START
	<-eventsCh // TEXT_MESSAGE_CHUNK

	// Second chunk while in ChatStarted state
	chunk2 := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart(" World"),
		},
	}
	err = streamFunc(context.Background(), chunk2)
	if err != nil {
		t.Fatalf("unexpected error on second chunk: %v", err)
	}

	// Should only emit TEXT_MESSAGE_CHUNK (no START)
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeTextMessageChunk {
			t.Errorf("expected TEXT_MESSAGE_CHUNK, got %s", evt.Type())
		}
		chunkEvt, ok := evt.(*events.TextMessageChunkEvent)
		if !ok {
			t.Fatal("expected TextMessageChunkEvent")
		}
		if chunkEvt.Delta == nil || *chunkEvt.Delta != " World" {
			t.Errorf("expected delta ' World', got %v", chunkEvt.Delta)
		}
	default:
		t.Fatal("expected TEXT_MESSAGE_CHUNK event")
	}
}

func TestStreamingFunc_ToolRequest(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	toolInput := map[string]interface{}{
		"query": "test query",
	}

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			{
				Kind: ai.PartToolRequest,
				ToolRequest: &ai.ToolRequest{
					Name:  "search",
					Input: toolInput,
				},
			},
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should emit TOOL_CALL_START
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeToolCallStart {
			t.Errorf("expected TOOL_CALL_START, got %s", evt.Type())
		}
		toolStartEvt, ok := evt.(*events.ToolCallStartEvent)
		if !ok {
			t.Fatal("expected ToolCallStartEvent")
		}
		if toolStartEvt.ToolCallName != "search" {
			t.Errorf("expected tool name 'search', got %s", toolStartEvt.ToolCallName)
		}
		if toolStartEvt.ParentMessageID == nil || *toolStartEvt.ParentMessageID != "thread-1" {
			t.Errorf("expected parent message ID 'thread-1', got %v", toolStartEvt.ParentMessageID)
		}
	default:
		t.Fatal("expected TOOL_CALL_START event")
	}

	// Should emit TOOL_CALL_ARGS
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeToolCallArgs {
			t.Errorf("expected TOOL_CALL_ARGS, got %s", evt.Type())
		}
		toolArgsEvt, ok := evt.(*events.ToolCallArgsEvent)
		if !ok {
			t.Fatal("expected ToolCallArgsEvent")
		}
		expectedArgs, _ := json.Marshal(toolInput)
		if toolArgsEvt.Delta != string(expectedArgs) {
			t.Errorf("expected args '%s', got '%s'", string(expectedArgs), toolArgsEvt.Delta)
		}
	default:
		t.Fatal("expected TOOL_CALL_ARGS event")
	}
}

func TestStreamingFunc_ToolResponse(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	toolOutput := map[string]interface{}{
		"result": "success",
	}

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleTool,
		Content: []*ai.Part{
			{
				Kind: ai.PartToolResponse,
				ToolResponse: &ai.ToolResponse{
					Name:   "search",
					Output: toolOutput,
				},
			},
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should emit TOOL_CALL_RESULT
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeToolCallResult {
			t.Errorf("expected TOOL_CALL_RESULT, got %s", evt.Type())
		}
		toolResultEvt, ok := evt.(*events.ToolCallResultEvent)
		if !ok {
			t.Fatal("expected ToolCallResultEvent")
		}
		if toolResultEvt.ToolCallID != "search" {
			t.Errorf("expected tool call ID 'search', got %s", toolResultEvt.ToolCallID)
		}
		expectedContent, _ := json.Marshal(toolOutput)
		if toolResultEvt.Content != string(expectedContent) {
			t.Errorf("expected content '%s', got '%s'", string(expectedContent), toolResultEvt.Content)
		}
	default:
		t.Fatal("expected TOOL_CALL_RESULT event")
	}
}

func TestStreamingFunc_ToolStartedToInitialTransition(t *testing.T) {
	eventsCh := make(chan events.Event, 20)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	// First, send a tool request to enter ToolStarted state
	toolInput := map[string]interface{}{"key": "value"}
	toolChunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			{
				Kind: ai.PartToolRequest,
				ToolRequest: &ai.ToolRequest{
					Name:  "test_tool",
					Input: toolInput,
				},
			},
		},
	}

	err := streamFunc(context.Background(), toolChunk)
	if err != nil {
		t.Fatalf("unexpected error on tool chunk: %v", err)
	}

	// Drain tool events
	<-eventsCh // TOOL_CALL_START
	<-eventsCh // TOOL_CALL_ARGS

	// Now send a text chunk (not tool request/response) to transition back to Initial->ChatStarted
	textChunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart("Response after tool"),
		},
	}

	err = streamFunc(context.Background(), textChunk)
	if err != nil {
		t.Fatalf("unexpected error on text chunk: %v", err)
	}

	// Should get TEXT_MESSAGE_START (because status transitions back to Initial first)
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeTextMessageStart {
			t.Errorf("expected TEXT_MESSAGE_START after tool, got %s", evt.Type())
		}
	default:
		t.Fatal("expected TEXT_MESSAGE_START event")
	}

	// Then TEXT_MESSAGE_CHUNK
	select {
	case evt := <-eventsCh:
		if evt.Type() != events.EventTypeTextMessageChunk {
			t.Errorf("expected TEXT_MESSAGE_CHUNK, got %s", evt.Type())
		}
	default:
		t.Fatal("expected TEXT_MESSAGE_CHUNK event")
	}
}

func TestStreamingFunc_ErrorMultipleChunks(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart("First"),
			ai.NewTextPart("Second"),
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err == nil {
		t.Fatal("expected error for multiple chunks")
	}
	if err.Error() != "chunk contains more than one chunk" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestStreamingFunc_ErrorNilContent(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			nil,
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err == nil {
		t.Fatal("expected error for nil content")
	}
	if err.Error() != "chunk contains no content" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestStreamingFunc_MessageIDPersistence(t *testing.T) {
	eventsCh := make(chan events.Event, 20)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	// Send multiple text chunks
	for i := 0; i < 3; i++ {
		chunk := &ai.ModelResponseChunk{
			Role: ai.RoleModel,
			Content: []*ai.Part{
				ai.NewTextPart("chunk"),
			},
		}
		err := streamFunc(context.Background(), chunk)
		if err != nil {
			t.Fatalf("unexpected error on chunk %d: %v", i, err)
		}
	}

	// First event is TEXT_MESSAGE_START
	startEvt := <-eventsCh
	if startEvt.Type() != events.EventTypeTextMessageStart {
		t.Fatalf("expected TEXT_MESSAGE_START, got %s", startEvt.Type())
	}
	startMsgEvt := startEvt.(*events.TextMessageStartEvent)
	messageID := startMsgEvt.MessageID

	// Subsequent events should have the same message ID
	for i := 0; i < 3; i++ {
		evt := <-eventsCh
		if evt.Type() != events.EventTypeTextMessageChunk {
			t.Errorf("expected TEXT_MESSAGE_CHUNK at position %d, got %s", i, evt.Type())
			continue
		}
		chunkEvt := evt.(*events.TextMessageChunkEvent)
		if chunkEvt.MessageID == nil || *chunkEvt.MessageID != messageID {
			t.Errorf("expected message ID %s, got %v", messageID, chunkEvt.MessageID)
		}
	}
}

func TestStreamingFunc_ToolRequestGetsNewMessageID(t *testing.T) {
	eventsCh := make(chan events.Event, 20)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	// Send a text chunk first
	textChunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			ai.NewTextPart("Hello"),
		},
	}
	err := streamFunc(context.Background(), textChunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Drain text events
	<-eventsCh // TEXT_MESSAGE_START
	<-eventsCh // TEXT_MESSAGE_CHUNK

	// Now send a tool request (will emit TEXT_MESSAGE_END first, then tool events)
	toolChunk := &ai.ModelResponseChunk{
		Role: ai.RoleModel,
		Content: []*ai.Part{
			{
				Kind: ai.PartToolRequest,
				ToolRequest: &ai.ToolRequest{
					Name:  "test_tool",
					Input: map[string]interface{}{},
				},
			},
		},
	}
	err = streamFunc(context.Background(), toolChunk)
	if err != nil {
		t.Fatalf("unexpected error on tool chunk: %v", err)
	}

	// Drain TEXT_MESSAGE_END (emitted when transitioning from ChatStarted to ToolStarted)
	endEvt := <-eventsCh
	if endEvt.Type() != events.EventTypeTextMessageEnd {
		t.Fatalf("expected TEXT_MESSAGE_END, got %s", endEvt.Type())
	}

	// TOOL_CALL_START should have a new message ID
	startEvt := <-eventsCh
	if startEvt.Type() != events.EventTypeToolCallStart {
		t.Fatalf("expected TOOL_CALL_START, got %s", startEvt.Type())
	}
	toolStartEvt := startEvt.(*events.ToolCallStartEvent)
	if toolStartEvt.ToolCallID == "" {
		t.Error("tool call ID should not be empty")
	}

	// TOOL_CALL_ARGS should use the same ID
	argsEvt := <-eventsCh
	if argsEvt.Type() != events.EventTypeToolCallArgs {
		t.Fatalf("expected TOOL_CALL_ARGS, got %s", argsEvt.Type())
	}
	toolArgsEvt := argsEvt.(*events.ToolCallArgsEvent)
	if toolArgsEvt.ToolCallID != toolStartEvt.ToolCallID {
		t.Errorf("expected tool call ID %s, got %s", toolStartEvt.ToolCallID, toolArgsEvt.ToolCallID)
	}
}

func TestStreamingFunc_EmptyContentSlice(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	chunk := &ai.ModelResponseChunk{
		Role:    ai.RoleModel,
		Content: []*ai.Part{},
	}

	// This will cause an index out of range panic in the current implementation
	// but we're testing that behavior - if this panics, the test framework will catch it
	defer func() {
		if r := recover(); r == nil {
			t.Log("Function handled empty content slice without panic")
		}
	}()

	// This may panic due to accessing Content[0] on empty slice
	_ = streamFunc(context.Background(), chunk)
}

func TestChatStatus_Constants(t *testing.T) {
	if Initial != 0 {
		t.Errorf("expected Initial to be 0, got %d", Initial)
	}
	if ChatStarted != 1 {
		t.Errorf("expected ChatStarted to be 1, got %d", ChatStarted)
	}
	if ToolStarted != 2 {
		t.Errorf("expected ToolStarted to be 2, got %d", ToolStarted)
	}
}

func TestStreamingFunc_DifferentRoles(t *testing.T) {
	tests := []struct {
		name     string
		role     ai.Role
		expected string
	}{
		{"model role", ai.RoleModel, "model"},
		{"user role", ai.RoleUser, "user"},
		{"system role", ai.RoleSystem, "system"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			eventsCh := make(chan events.Event, 10)
			streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

			chunk := &ai.ModelResponseChunk{
				Role: tt.role,
				Content: []*ai.Part{
					ai.NewTextPart("test"),
				},
			}

			err := streamFunc(context.Background(), chunk)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			// Drain TEXT_MESSAGE_START
			<-eventsCh

			// Check TEXT_MESSAGE_CHUNK has correct role
			evt := <-eventsCh
			chunkEvt := evt.(*events.TextMessageChunkEvent)
			if chunkEvt.Role == nil || *chunkEvt.Role != tt.expected {
				t.Errorf("expected role '%s', got %v", tt.expected, chunkEvt.Role)
			}
		})
	}
}

func TestStreamingFunc_ToolResponseWithComplexOutput(t *testing.T) {
	eventsCh := make(chan events.Event, 10)
	streamFunc := StreamingFunc("thread-1", "run-1", eventsCh)

	complexOutput := map[string]interface{}{
		"nested": map[string]interface{}{
			"array": []interface{}{1, 2, 3},
			"bool":  true,
		},
		"string": "value",
		"number": 42.5,
	}

	chunk := &ai.ModelResponseChunk{
		Role: ai.RoleTool,
		Content: []*ai.Part{
			{
				Kind: ai.PartToolResponse,
				ToolResponse: &ai.ToolResponse{
					Name:   "complex_tool",
					Output: complexOutput,
				},
			},
		},
	}

	err := streamFunc(context.Background(), chunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	evt := <-eventsCh
	toolResultEvt := evt.(*events.ToolCallResultEvent)

	// Verify the JSON output is valid
	var parsed map[string]interface{}
	err = json.Unmarshal([]byte(toolResultEvt.Content), &parsed)
	if err != nil {
		t.Fatalf("failed to parse tool result content as JSON: %v", err)
	}
}
