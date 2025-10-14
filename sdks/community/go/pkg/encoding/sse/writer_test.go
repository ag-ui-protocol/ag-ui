package sse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

type mockEvent struct {
	events.BaseEvent
	dataValue     map[string]interface{}
	validateError error
	toJSONError   error
	customJSON    []byte
}

func (m *mockEvent) Data() map[string]interface{} {
	return m.dataValue
}

func (m *mockEvent) ThreadID() string {
	return "mock-thread-id"
}

func (m *mockEvent) RunID() string {
	return "mock-run-id"
}

func (m *mockEvent) Validate() error {
	return m.validateError
}

func (m *mockEvent) ToJSON() ([]byte, error) {
	if m.toJSONError != nil {
		return nil, m.toJSONError
	}
	if m.customJSON != nil {
		return m.customJSON, nil
	}
	return []byte(`{"type":"mock","data":"test"}`), nil
}

type errorWriter struct {
	err error
}

func (e *errorWriter) Write(p []byte) (n int, err error) {
	return 0, e.err
}

type flushWriter struct {
	bytes.Buffer
	flushCalled bool
	flushError  error
}

func (fw *flushWriter) Flush() error {
	fw.flushCalled = true
	return fw.flushError
}

func TestNewSSEWriter(t *testing.T) {
	writer := NewSSEWriter()
	if writer == nil {
		t.Fatal("expected non-nil writer")
	}
	if writer.encoder == nil {
		t.Fatal("expected non-nil encoder")
	}
	if writer.logger == nil {
		t.Fatal("expected non-nil logger")
	}
}

func TestSSEWriter_WithLogger(t *testing.T) {
	customLogger := slog.New(slog.NewTextHandler(io.Discard, nil))
	writer := NewSSEWriter().WithLogger(customLogger)

	if writer.logger != customLogger {
		t.Error("expected custom logger to be set")
	}
}

func TestSSEWriter_WriteEvent(t *testing.T) {
	tests := []struct {
		name          string
		event         events.Event
		expectedError bool
		errorContains string
		validateSSE   func(t *testing.T, output string)
	}{
		{
			name: "successful write",
			event: &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType:   events.EventTypeCustom,
					TimestampMs: ptr(int64(1234567890)),
				},
			},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if !strings.Contains(output, "data: ") {
					t.Error("expected SSE data line")
				}
				if !strings.HasSuffix(output, "\n\n") {
					t.Error("expected SSE frame to end with double newline")
				}
			},
		},
		{
			name:          "nil event",
			event:         nil,
			expectedError: true,
			errorContains: "event cannot be nil",
		},
		{
			name: "event with JSON error",
			event: &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType: events.EventTypeCustom,
				},
				toJSONError: errors.New("JSON encoding error"),
			},
			expectedError: true,
			errorContains: "event encoding failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			writer := NewSSEWriter()
			var buf bytes.Buffer

			err := writer.WriteEvent(ctx, &buf, tt.event)

			if tt.expectedError {
				if err == nil {
					t.Fatal("expected error but got none")
				}
				if tt.errorContains != "" && !strings.Contains(err.Error(), tt.errorContains) {
					t.Errorf("expected error to contain '%s', got: %v", tt.errorContains, err)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if tt.validateSSE != nil {
					tt.validateSSE(t, buf.String())
				}
			}
		})
	}
}

func TestSSEWriter_WriteBytes(t *testing.T) {
	tests := []struct {
		name          string
		data          []byte
		writer        io.Writer
		expectedError bool
		errorContains string
		validateSSE   func(t *testing.T, output string)
	}{
		{
			name:          "successful write",
			data:          []byte(`{"test":"data"}`),
			writer:        &bytes.Buffer{},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if !strings.Contains(output, `data: {"test":"data"}`) {
					t.Error("expected SSE data line with JSON")
				}
				if !strings.HasSuffix(output, "\n\n") {
					t.Error("expected SSE frame to end with double newline")
				}
			},
		},
		{
			name:          "empty bytes",
			data:          []byte{},
			writer:        &bytes.Buffer{},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if !strings.Contains(output, "data: ") {
					t.Error("expected SSE data line")
				}
			},
		},
		{
			name:          "bytes with newlines",
			data:          []byte("line1\nline2\rline3"),
			writer:        &bytes.Buffer{},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if !strings.Contains(output, `line1\nline2\rline3`) {
					t.Error("expected newlines to be escaped")
				}
			},
		},
		{
			name:          "write error",
			data:          []byte(`{"test":"data"}`),
			writer:        &errorWriter{err: errors.New("write failed")},
			expectedError: true,
			errorContains: "SSE write failed",
		},
		{
			name:          "flush error",
			data:          []byte(`{"test":"data"}`),
			writer:        &flushWriter{flushError: errors.New("flush failed")},
			expectedError: true,
			errorContains: "SSE flush failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			sseWriter := NewSSEWriter()

			var buf *bytes.Buffer
			if b, ok := tt.writer.(*bytes.Buffer); ok {
				buf = b
			}

			err := sseWriter.WriteBytes(ctx, tt.writer, tt.data)

			if tt.expectedError {
				if err == nil {
					t.Fatal("expected error but got none")
				}
				if tt.errorContains != "" && !strings.Contains(err.Error(), tt.errorContains) {
					t.Errorf("expected error to contain '%s', got: %v", tt.errorContains, err)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if tt.validateSSE != nil && buf != nil {
					tt.validateSSE(t, buf.String())
				}
			}
		})
	}
}

func TestSSEWriter_WriteEventWithType(t *testing.T) {
	tests := []struct {
		name          string
		event         events.Event
		eventType     string
		writer        io.Writer
		expectedError bool
		errorContains string
		validateSSE   func(t *testing.T, output string)
	}{
		{
			name: "successful write with type",
			event: &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType:   events.EventTypeCustom,
					TimestampMs: ptr(int64(1234567890)),
				},
			},
			eventType:     "custom",
			writer:        &bytes.Buffer{},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if !strings.Contains(output, "event: custom\n") {
					t.Error("expected SSE event type line")
				}
				if !strings.Contains(output, "id: ") {
					t.Error("expected SSE id line")
				}
				if !strings.Contains(output, "data: ") {
					t.Error("expected SSE data line")
				}
			},
		},
		{
			name: "successful write without type",
			event: &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType: events.EventTypeCustom,
				},
			},
			eventType:     "",
			writer:        &bytes.Buffer{},
			expectedError: false,
			validateSSE: func(t *testing.T, output string) {
				if strings.Contains(output, "event: ") {
					t.Error("unexpected SSE event type line")
				}
			},
		},
		{
			name:          "nil writer",
			event:         &mockEvent{},
			eventType:     "",
			writer:        nil,
			expectedError: true,
			errorContains: "writer cannot be nil",
		},
		{
			name:          "write error",
			event:         &mockEvent{},
			eventType:     "",
			writer:        &errorWriter{err: errors.New("write failed")},
			expectedError: true,
			errorContains: "SSE write failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			sseWriter := NewSSEWriter()

			var buf *bytes.Buffer
			if b, ok := tt.writer.(*bytes.Buffer); ok {
				buf = b
			}

			err := sseWriter.WriteEventWithType(ctx, tt.writer, tt.event, tt.eventType)

			if tt.expectedError {
				if err == nil {
					t.Fatal("expected error but got none")
				}
				if tt.errorContains != "" && !strings.Contains(err.Error(), tt.errorContains) {
					t.Errorf("expected error to contain '%s', got: %v", tt.errorContains, err)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if tt.validateSSE != nil && buf != nil {
					tt.validateSSE(t, buf.String())
				}
			}
		})
	}
}

func TestSSEWriter_WriteEventWithNegotiation(t *testing.T) {
	ctx := context.Background()
	writer := NewSSEWriter()
	var buf bytes.Buffer

	event := &mockEvent{
		BaseEvent: events.BaseEvent{
			EventType: events.EventTypeCustom,
		},
	}

	err := writer.WriteEventWithNegotiation(ctx, &buf, event, "application/json")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "data: ") {
		t.Error("expected SSE data line")
	}
}

func TestSSEWriter_WriteErrorEvent(t *testing.T) {
	ctx := context.Background()
	writer := NewSSEWriter()
	var buf bytes.Buffer

	testError := errors.New("test error")
	requestID := "req-123"

	err := writer.WriteErrorEvent(ctx, &buf, testError, requestID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "event: error") {
		t.Error("expected error event type")
	}
	if !strings.Contains(output, "test error") {
		t.Error("expected error message in output")
	}
	if !strings.Contains(output, requestID) {
		t.Error("expected request ID in output")
	}
}

func TestSSEWriter_Flushing(t *testing.T) {
	tests := []struct {
		name        string
		flushError  error
		expectError bool
	}{
		{
			name:        "successful flush",
			flushError:  nil,
			expectError: false,
		},
		{
			name:        "flush error",
			flushError:  errors.New("flush failed"),
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			writer := NewSSEWriter()
			fw := &flushWriter{flushError: tt.flushError}

			event := &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType: events.EventTypeCustom,
				},
			}

			err := writer.WriteEvent(ctx, fw, event)

			if tt.expectError {
				if err == nil {
					t.Fatal("expected error but got none")
				}
				if !strings.Contains(err.Error(), "SSE flush failed") {
					t.Errorf("expected flush error, got: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
			}

			if !fw.flushCalled {
				t.Error("expected flush to be called")
			}
		})
	}
}

func TestCustomEvent(t *testing.T) {
	t.Run("Data operations", func(t *testing.T) {
		event := &CustomEvent{}

		if data := event.Data(); data != nil {
			t.Error("expected nil data initially")
		}

		testData := map[string]interface{}{
			"key1": "value1",
			"key2": 42,
		}
		event.SetData(testData)

		data := event.Data()
		if data["key1"] != "value1" {
			t.Error("expected key1 to be value1")
		}
		if data["key2"] != 42 {
			t.Error("expected key2 to be 42")
		}

		data["key3"] = "external"
		internalData := event.Data()
		if _, exists := internalData["key3"]; exists {
			t.Error("external modification should not affect internal data")
		}
	})

	t.Run("SetDataField", func(t *testing.T) {
		event := &CustomEvent{}

		event.SetDataField("field1", "value1")
		event.SetDataField("field2", 100)

		data := event.Data()
		if data["field1"] != "value1" {
			t.Error("expected field1 to be value1")
		}
		if data["field2"] != 100 {
			t.Error("expected field2 to be 100")
		}
	})

	t.Run("ThreadID and RunID", func(t *testing.T) {
		event := &CustomEvent{}

		if event.ThreadID() != "" {
			t.Error("expected empty thread ID")
		}
		if event.RunID() != "" {
			t.Error("expected empty run ID")
		}
	})

	t.Run("Validate", func(t *testing.T) {
		event := &CustomEvent{}

		if err := event.Validate(); err == nil {
			t.Error("expected validation error for empty event type")
		}

		event.EventType = events.EventTypeCustom
		if err := event.Validate(); err != nil {
			t.Errorf("unexpected validation error: %v", err)
		}
	})

	t.Run("ToJSON", func(t *testing.T) {
		event := &CustomEvent{
			BaseEvent: events.BaseEvent{
				EventType:   events.EventTypeCustom,
				TimestampMs: ptr(int64(1234567890)),
			},
		}
		event.SetData(map[string]interface{}{
			"test": "data",
		})

		jsonData, err := event.ToJSON()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		jsonStr := string(jsonData)
		if !strings.Contains(jsonStr, `"type":"CUSTOM"`) {
			t.Error("expected type in JSON")
		}
		if !strings.Contains(jsonStr, `"timestamp":1234567890`) {
			t.Error("expected timestamp in JSON")
		}
		if !strings.Contains(jsonStr, `"test":"data"`) {
			t.Error("expected test data in JSON")
		}
	})

	t.Run("Concurrent access", func(t *testing.T) {
		event := &CustomEvent{}
		var wg sync.WaitGroup

		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				event.SetDataField(fmt.Sprintf("key%d", idx), idx)
			}(i)
		}

		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_ = event.Data()
			}()
		}

		wg.Wait()

		data := event.Data()
		if len(data) != 100 {
			t.Errorf("expected 100 fields, got %d", len(data))
		}
	})
}

func TestGetCurrentTimestamp(t *testing.T) {
	before := time.Now().UnixMilli()
	timestamp := getCurrentTimestamp()
	after := time.Now().UnixMilli()

	if timestamp < before || timestamp > after {
		t.Errorf("timestamp %d not in expected range [%d, %d]", timestamp, before, after)
	}
}

func TestCreateSSEFrame(t *testing.T) {
	writer := NewSSEWriter()

	tests := []struct {
		name      string
		jsonData  []byte
		eventType string
		event     events.Event
		validate  func(t *testing.T, frame string)
	}{
		{
			name:      "basic frame",
			jsonData:  []byte(`{"test":"data"}`),
			eventType: "",
			event:     nil,
			validate: func(t *testing.T, frame string) {
				expected := `data: {"test":"data"}` + "\n\n"
				if frame != expected {
					t.Errorf("expected frame:\n%q\ngot:\n%q", expected, frame)
				}
			},
		},
		{
			name:      "frame with event type",
			jsonData:  []byte(`{"test":"data"}`),
			eventType: "message",
			event:     nil,
			validate: func(t *testing.T, frame string) {
				if !strings.HasPrefix(frame, "event: message\n") {
					t.Error("expected frame to start with event type")
				}
			},
		},
		{
			name:     "frame with event ID",
			jsonData: []byte(`{"test":"data"}`),
			event: &mockEvent{
				BaseEvent: events.BaseEvent{
					EventType:   events.EventTypeCustom,
					TimestampMs: ptr(int64(123456)),
				},
			},
			validate: func(t *testing.T, frame string) {
				if !strings.Contains(frame, "id: CUSTOM_123456\n") {
					t.Error("expected frame to contain event ID")
				}
			},
		},
		{
			name:      "frame with newlines escaped",
			jsonData:  []byte("line1\nline2\rline3"),
			eventType: "",
			event:     nil,
			validate: func(t *testing.T, frame string) {
				if !strings.Contains(frame, `line1\nline2\rline3`) {
					t.Error("expected newlines to be escaped")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			frame, err := writer.createSSEFrame(tt.jsonData, tt.eventType, tt.event)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.validate != nil {
				tt.validate(t, frame)
			}
		})
	}
}

func ptr[T any](v T) *T {
	return &v
}
