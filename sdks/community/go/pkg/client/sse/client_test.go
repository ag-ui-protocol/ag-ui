package sse

import (
	"testing"
	"time"
)

func TestNewClient(t *testing.T) {
	tests := []struct {
		name   string
		config Config
	}{
		{
			name: "default config",
			config: Config{
				Endpoint: "http://localhost:8080/sse",
			},
		},
		{
			name: "custom timeouts",
			config: Config{
				Endpoint:       "http://localhost:8080/sse",
				ConnectTimeout: 10 * time.Second,
				ReadTimeout:    1 * time.Minute,
				BufferSize:     50,
			},
		},
		{
			name: "with API key",
			config: Config{
				Endpoint: "http://localhost:8080/sse",
				APIKey:   "test-api-key",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient(tt.config)
			if client == nil {
				t.Fatal("expected non-nil client")
			}
			if client.httpClient == nil {
				t.Fatal("expected non-nil http client")
			}
			if client.logger == nil {
				t.Fatal("expected non-nil logger")
			}
		})
	}
}

// TODO: re-enable this test once RunAgentInput exists
//func TestClientStream(t *testing.T) {
//	tests := []struct {
//		name        string
//		serverFunc  func(w http.ResponseWriter, r *http.Request)
//		config      Config
//		payload     interface{}
//		wantFrames  int
//		wantErr     bool
//		checkFrames func(t *testing.T, frames []Frame)
//	}{
//		{
//			name: "successful stream",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				w.Header().Set("Content-Type", "text/event-stream")
//				w.WriteHeader(http.StatusOK)
//
//				flusher, ok := w.(http.Flusher)
//				if !ok {
//					t.Fatal("ResponseWriter does not support flushing")
//				}
//
//				_, _ = fmt.Fprintf(w, "data: {\"event\":\"start\"}\n\n")
//				flusher.Flush()
//
//				time.Sleep(10 * time.Millisecond)
//
//				_, _ = fmt.Fprintf(w, "data: {\"event\":\"message\",\"content\":\"Hello\"}\n\n")
//				flusher.Flush()
//
//				time.Sleep(10 * time.Millisecond)
//
//				_, _ = fmt.Fprintf(w, "data: {\"event\":\"end\"}\n\n")
//				flusher.Flush()
//			},
//			config: Config{
//				BufferSize: 10,
//			},
//			payload: RunAgentInput{
//				SessionID: "test-session",
//				Messages: []Message{
//					{Role: "user", Content: "Hello"},
//				},
//				Stream: true,
//			},
//			wantFrames: 3,
//			checkFrames: func(t *testing.T, frames []Frame) {
//				if len(frames) != 3 {
//					t.Errorf("expected 3 frames, got %d", len(frames))
//					return
//				}
//
//				var event1, event2, event3 map[string]interface{}
//				_ = json.Unmarshal(frames[0].Data, &event1)
//				_ = json.Unmarshal(frames[1].Data, &event2)
//				_ = json.Unmarshal(frames[2].Data, &event3)
//
//				if event1["event"] != "start" {
//					t.Errorf("expected first event to be 'start', got %v", event1["event"])
//				}
//				if event2["event"] != "message" {
//					t.Errorf("expected second event to be 'message', got %v", event2["event"])
//				}
//				if event3["event"] != "end" {
//					t.Errorf("expected third event to be 'end', got %v", event3["event"])
//				}
//			},
//		},
//		{
//			name: "multi-line data",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				w.Header().Set("Content-Type", "text/event-stream")
//				w.WriteHeader(http.StatusOK)
//
//				flusher, ok := w.(http.Flusher)
//				if !ok {
//					t.Fatal("ResponseWriter does not support flushing")
//				}
//
//				_, _ = fmt.Fprintf(w, "data: {\"event\":\"multi\",\n")
//				_, _ = fmt.Fprintf(w, "data: \"line1\":\"value1\",\n")
//				_, _ = fmt.Fprintf(w, "data: \"line2\":\"value2\"}\n\n")
//				flusher.Flush()
//			},
//			config: Config{
//				BufferSize: 10,
//			},
//			payload:    RunAgentInput{Stream: true},
//			wantFrames: 1,
//			checkFrames: func(t *testing.T, frames []Frame) {
//				if len(frames) != 1 {
//					t.Errorf("expected 1 frame, got %d", len(frames))
//					return
//				}
//
//				expected := `{"event":"multi",
//"line1":"value1",
//"line2":"value2"}`
//				if string(frames[0].Data) != expected {
//					t.Errorf("unexpected frame data:\ngot:  %s\nwant: %s", frames[0].Data, expected)
//				}
//			},
//		},
//		{
//			name: "non-200 status",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				w.WriteHeader(http.StatusInternalServerError)
//				_, _ = fmt.Fprintf(w, "Internal Server Error")
//			},
//			config:  Config{},
//			payload: RunAgentInput{Stream: true},
//			wantErr: true,
//		},
//		{
//			name: "wrong content type",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				w.Header().Set("Content-Type", "application/json")
//				w.WriteHeader(http.StatusOK)
//				_, _ = fmt.Fprintf(w, "{\"error\":\"wrong type\"}")
//			},
//			config:  Config{},
//			payload: RunAgentInput{Stream: true},
//			wantErr: true,
//		},
//		{
//			name: "with auth header",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				auth := r.Header.Get("Authorization")
//				if auth != "Bearer test-key-123" {
//					w.WriteHeader(http.StatusUnauthorized)
//					return
//				}
//
//				w.Header().Set("Content-Type", "text/event-stream")
//				w.WriteHeader(http.StatusOK)
//
//				flusher, ok := w.(http.Flusher)
//				if !ok {
//					t.Fatal("ResponseWriter does not support flushing")
//				}
//
//				_, _ = fmt.Fprintf(w, "data: {\"authorized\":true}\n\n")
//				flusher.Flush()
//			},
//			config: Config{
//				APIKey:     "test-key-123",
//				BufferSize: 10,
//			},
//			payload:    RunAgentInput{Stream: true},
//			wantFrames: 1,
//		},
//		{
//			name: "with custom auth header",
//			serverFunc: func(w http.ResponseWriter, r *http.Request) {
//				auth := r.Header.Get("X-API-Key")
//				if auth != "custom-key-456" {
//					w.WriteHeader(http.StatusUnauthorized)
//					return
//				}
//
//				w.Header().Set("Content-Type", "text/event-stream")
//				w.WriteHeader(http.StatusOK)
//
//				flusher, ok := w.(http.Flusher)
//				if !ok {
//					t.Fatal("ResponseWriter does not support flushing")
//				}
//
//				_, _ = fmt.Fprintf(w, "data: {\"authorized\":true}\n\n")
//				flusher.Flush()
//			},
//			config: Config{
//				APIKey:     "custom-key-456",
//				AuthHeader: "X-API-Key",
//				BufferSize: 10,
//			},
//			payload:    RunAgentInput{Stream: true},
//			wantFrames: 1,
//		},
//	}
//
//	for _, tt := range tests {
//		t.Run(tt.name, func(t *testing.T) {
//			server := httptest.NewServer(http.HandlerFunc(tt.serverFunc))
//			defer server.Close()
//
//			tt.config.Endpoint = server.URL + "/tool_based_generative_ui"
//			if tt.config.Logger == nil {
//				logger := logrus.New()
//				logger.SetLevel(logrus.DebugLevel)
//				tt.config.Logger = logger
//			}
//
//			client := NewClient(tt.config)
//
//			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
//			defer cancel()
//
//			frames, errors, err := client.Stream(StreamOptions{
//				Context: ctx,
//				Payload: tt.payload,
//			})
//
//			if tt.wantErr {
//				if err == nil {
//					t.Fatal("expected error, got nil")
//				}
//				return
//			}
//
//			if err != nil {
//				t.Fatalf("unexpected error: %v", err)
//			}
//
//			var collectedFrames []Frame
//			done := false
//
//			for !done {
//				select {
//				case frame, ok := <-frames:
//					if !ok {
//						done = true
//						break
//					}
//					collectedFrames = append(collectedFrames, frame)
//				case err := <-errors:
//					if err != nil && !strings.Contains(err.Error(), "EOF") {
//						t.Fatalf("unexpected stream error: %v", err)
//					}
//				case <-ctx.Done():
//					done = true
//				}
//			}
//
//			if tt.wantFrames > 0 && len(collectedFrames) != tt.wantFrames {
//				t.Errorf("expected %d frames, got %d", tt.wantFrames, len(collectedFrames))
//			}
//
//			if tt.checkFrames != nil {
//				tt.checkFrames(t, collectedFrames)
//			}
//		})
//	}
//}

// TODO: re-enable this test once RunAgentInput exists
//func TestClientContextCancellation(t *testing.T) {
//	slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
//		w.Header().Set("Content-Type", "text/event-stream")
//		w.WriteHeader(http.StatusOK)
//
//		flusher, ok := w.(http.Flusher)
//		if !ok {
//			t.Fatal("ResponseWriter does not support flushing")
//		}
//
//		for i := 0; i < 100; i++ {
//			_, _ = fmt.Fprintf(w, "data: {\"count\":%d}\n\n", i)
//			flusher.Flush()
//			time.Sleep(100 * time.Millisecond)
//		}
//	}))
//	defer slowServer.Close()
//
//	client := NewClient(Config{
//		Endpoint:   slowServer.URL + "/sse",
//		BufferSize: 10,
//		Logger:     logrus.New(),
//	})
//
//	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
//	defer cancel()
//
//	frames, errors, err := client.Stream(StreamOptions{
//		Context: ctx,
//		Payload: RunAgentInput{Stream: true},
//	})
//
//	if err != nil {
//		t.Fatalf("unexpected error: %v", err)
//	}
//
//	frameCount := 0
//	for {
//		select {
//		case _, ok := <-frames:
//			if !ok {
//				goto done
//			}
//			frameCount++
//		case <-errors:
//			goto done
//		case <-ctx.Done():
//			goto done
//		}
//	}
//
//done:
//	if frameCount == 0 {
//		t.Error("expected at least one frame before cancellation")
//	}
//	if frameCount >= 10 {
//		t.Error("expected cancellation to stop stream early")
//	}
//}

func TestClientClose(t *testing.T) {
	client := NewClient(Config{
		Endpoint: "http://localhost:8080/sse",
	})

	err := client.Close()
	if err != nil {
		t.Errorf("unexpected error closing client: %v", err)
	}
}
