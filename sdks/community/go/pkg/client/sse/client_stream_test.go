package sse

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStream(t *testing.T) {
	t.Run("successful stream", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
			assert.Equal(t, "text/event-stream", r.Header.Get("Accept"))
			
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			fmt.Fprintf(w, "data: first message\n\n")
			flusher.Flush()
			
			fmt.Fprintf(w, "data: second message\n\n")
			flusher.Flush()
			
			fmt.Fprintf(w, "data: {\"type\":\"json\",\"value\":123}\n\n")
			flusher.Flush()
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint:   server.URL,
			BufferSize: 10,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		
		frames, errors, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: map[string]string{"test": "data"},
		})
		require.NoError(t, err)
		
		var received []string
		done := make(chan bool)
		
		go func() {
			for {
				select {
				case frame, ok := <-frames:
					if !ok {
						done <- true
						return
					}
					received = append(received, string(frame.Data))
				case err := <-errors:
					if err != nil {
						t.Errorf("unexpected error: %v", err)
					}
				case <-time.After(1 * time.Second):
					done <- true
					return
				}
			}
		}()
		
		<-done
		assert.Len(t, received, 3)
		assert.Contains(t, received, "first message")
		assert.Contains(t, received, "second message")
		assert.Contains(t, received, `{"type":"json","value":123}`)
	})
	
	t.Run("multiline data handling", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			// Send multiline data
			fmt.Fprintf(w, "data: line1\ndata: line2\ndata: line3\n\n")
			flusher.Flush()
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint: server.URL,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		defer cancel()
		
		frames, _, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		require.NoError(t, err)
		
		select {
		case frame := <-frames:
			assert.Equal(t, "line1\nline2\nline3", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for frame")
		}
	})
	
	t.Run("authentication headers", func(t *testing.T) {
		tests := []struct {
			name           string
			config         Config
			expectedHeader string
			expectedValue  string
		}{
			{
				name: "default bearer auth",
				config: Config{
					APIKey: "test-key",
				},
				expectedHeader: "Authorization",
				expectedValue:  "Bearer test-key",
			},
			{
				name: "custom auth scheme",
				config: Config{
					APIKey:     "test-key",
					AuthScheme: "Token",
				},
				expectedHeader: "Authorization",
				expectedValue:  "Token test-key",
			},
			{
				name: "custom header",
				config: Config{
					APIKey:     "test-key",
					AuthHeader: "X-API-Key",
				},
				expectedHeader: "X-API-Key",
				expectedValue:  "test-key",
			},
		}
		
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					assert.Equal(t, tt.expectedValue, r.Header.Get(tt.expectedHeader))
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(http.StatusOK)
				}))
				defer server.Close()
				
				tt.config.Endpoint = server.URL
				client := NewClient(tt.config)
				
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				
				_, _, err := client.Stream(StreamOptions{
					Context: ctx,
					Payload: struct{}{},
				})
				require.NoError(t, err)
			})
		}
	})
	
	t.Run("custom headers", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "custom-value", r.Header.Get("X-Custom-Header"))
			assert.Equal(t, "another-value", r.Header.Get("X-Another-Header"))
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint: server.URL,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		
		_, _, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
			Headers: map[string]string{
				"X-Custom-Header":  "custom-value",
				"X-Another-Header": "another-value",
			},
		})
		require.NoError(t, err)
	})
	
	t.Run("error responses", func(t *testing.T) {
		tests := []struct {
			name         string
			statusCode   int
			contentType  string
			responseBody string
			expectedErr  string
		}{
			{
				name:         "404 not found",
				statusCode:   http.StatusNotFound,
				contentType:  "text/plain",
				responseBody: "Not Found",
				expectedErr:  "unexpected status code 404",
			},
			{
				name:         "500 internal server error",
				statusCode:   http.StatusInternalServerError,
				contentType:  "application/json",
				responseBody: `{"error":"internal server error"}`,
				expectedErr:  "unexpected status code 500",
			},
			{
				name:        "wrong content type",
				statusCode:  http.StatusOK,
				contentType: "application/json",
				expectedErr: "unexpected content-type: application/json",
			},
		}
		
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if tt.contentType != "" {
						w.Header().Set("Content-Type", tt.contentType)
					}
					w.WriteHeader(tt.statusCode)
					if tt.responseBody != "" {
						w.Write([]byte(tt.responseBody))
					}
				}))
				defer server.Close()
				
				client := NewClient(Config{
					Endpoint: server.URL,
				})
				
				_, _, err := client.Stream(StreamOptions{
					Payload: struct{}{},
				})
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.expectedErr)
			})
		}
	})
	
	t.Run("context cancellation", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			// Send data slowly
			for i := 0; i < 100; i++ {
				fmt.Fprintf(w, "data: message %d\n\n", i)
				flusher.Flush()
				time.Sleep(100 * time.Millisecond)
			}
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint: server.URL,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		
		frames, errors, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		require.NoError(t, err)
		
		messageCount := 0
		for {
			select {
			case _, ok := <-frames:
				if !ok {
					// Channel closed due to context cancellation
					assert.Greater(t, messageCount, 0)
					assert.Less(t, messageCount, 10) // Should not receive all 100 messages
					return
				}
				messageCount++
			case <-errors:
				// Might receive an error due to context cancellation
			case <-time.After(1 * time.Second):
				t.Fatal("test took too long")
			}
		}
	})
	
	t.Run("invalid payload marshaling", func(t *testing.T) {
		client := NewClient(Config{
			Endpoint: "http://localhost",
		})
		
		// Create an unmarshalable payload
		invalidPayload := make(chan int)
		
		_, _, err := client.Stream(StreamOptions{
			Payload: invalidPayload,
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to marshal payload")
	})
	
	t.Run("invalid endpoint", func(t *testing.T) {
		client := NewClient(Config{
			Endpoint: "http://[::1]:namedport", // Invalid URL
		})
		
		_, _, err := client.Stream(StreamOptions{
			Payload: struct{}{},
		})
		require.Error(t, err)
	})
	
	t.Run("concurrent reads", func(t *testing.T) {
		messageCount := 50
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			for i := 0; i < messageCount; i++ {
				fmt.Fprintf(w, "data: message-%d\n\n", i)
				flusher.Flush()
			}
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint:   server.URL,
			BufferSize: 100,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		
		frames, _, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		require.NoError(t, err)
		
		var wg sync.WaitGroup
		received := make(map[string]bool)
		mu := sync.Mutex{}
		
		// Start multiple goroutines to read frames
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for frame := range frames {
					mu.Lock()
					received[string(frame.Data)] = true
					mu.Unlock()
				}
			}()
		}
		
		wg.Wait()
		assert.Len(t, received, messageCount)
	})
	
	t.Run("read timeout handling", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			// Send one message then hang
			fmt.Fprintf(w, "data: initial\n\n")
			flusher.Flush()
			
			// Simulate a hung connection
			time.Sleep(5 * time.Second)
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint:    server.URL,
			ReadTimeout: 500 * time.Millisecond,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		
		frames, errors, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		require.NoError(t, err)
		
		// Should receive initial message
		select {
		case frame := <-frames:
			assert.Equal(t, "initial", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for initial frame")
		}
		
		// Should eventually get an error or channel closure due to read timeout
		select {
		case <-frames:
			// Channel closed
		case err := <-errors:
			assert.NotNil(t, err)
		case <-time.After(2 * time.Second):
			t.Fatal("timeout waiting for error or closure")
		}
	})
	
	t.Run("logger output", func(t *testing.T) {
		var logBuffer bytes.Buffer
		logger := logrus.New()
		logger.SetOutput(&logBuffer)
		logger.SetLevel(logrus.DebugLevel)
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			
			flusher, ok := w.(http.Flusher)
			require.True(t, ok)
			
			for i := 0; i < 150; i++ {
				fmt.Fprintf(w, "data: msg%d\n\n", i)
				flusher.Flush()
			}
		}))
		defer server.Close()
		
		client := NewClient(Config{
			Endpoint: server.URL,
			Logger:   logger,
		})
		
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		defer cancel()
		
		frames, _, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		require.NoError(t, err)
		
		// Consume all frames
		go func() {
			for range frames {
			}
		}()
		
		time.Sleep(500 * time.Millisecond)
		cancel()
		time.Sleep(100 * time.Millisecond)
		
		logs := logBuffer.String()
		assert.Contains(t, logs, "Initiating SSE connection")
		assert.Contains(t, logs, "SSE connection established")
		assert.Contains(t, logs, "SSE stream progress") // Should log progress every 100 frames
	})
}

func TestReadStream(t *testing.T) {
	t.Run("EOF handling", func(t *testing.T) {
		pr, pw := io.Pipe()
		resp := &http.Response{
			Body: pr,
		}
		
		client := NewClient(Config{})
		frames := make(chan Frame, 10)
		errors := make(chan error, 1)
		
		go client.readStream(context.Background(), resp, frames, errors)
		
		// Write some data then close
		go func() {
			pw.Write([]byte("data: test\n\n"))
			time.Sleep(100 * time.Millisecond)
			pw.Close()
		}()
		
		// Should receive one frame
		select {
		case frame := <-frames:
			assert.Equal(t, "test", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for frame")
		}
		
		// Channels should be closed after EOF
		select {
		case _, ok := <-frames:
			assert.False(t, ok, "frames channel should be closed")
		case <-time.After(1 * time.Second):
			t.Fatal("frames channel not closed")
		}
	})
	
	t.Run("carriage return handling", func(t *testing.T) {
		pr, pw := io.Pipe()
		resp := &http.Response{
			Body: pr,
		}
		
		client := NewClient(Config{})
		frames := make(chan Frame, 10)
		errors := make(chan error, 1)
		
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		
		go client.readStream(ctx, resp, frames, errors)
		
		// Write data with carriage returns
		go func() {
			pw.Write([]byte("data: test\r\n\r\n"))
			time.Sleep(100 * time.Millisecond)
			pw.Close()
		}()
		
		select {
		case frame := <-frames:
			assert.Equal(t, "test", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for frame")
		}
	})
	
	t.Run("empty lines between data", func(t *testing.T) {
		pr, pw := io.Pipe()
		resp := &http.Response{
			Body: pr,
		}
		
		client := NewClient(Config{})
		frames := make(chan Frame, 10)
		errors := make(chan error, 1)
		
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		
		go client.readStream(ctx, resp, frames, errors)
		
		go func() {
			// Multiple empty lines should be ignored
			pw.Write([]byte("\n\n\ndata: test\n\n\n\n"))
			time.Sleep(100 * time.Millisecond)
			pw.Close()
		}()
		
		select {
		case frame := <-frames:
			assert.Equal(t, "test", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for frame")
		}
	})
	
	t.Run("non-data lines ignored", func(t *testing.T) {
		pr, pw := io.Pipe()
		resp := &http.Response{
			Body: pr,
		}
		
		client := NewClient(Config{})
		frames := make(chan Frame, 10)
		errors := make(chan error, 1)
		
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		
		go client.readStream(ctx, resp, frames, errors)
		
		go func() {
			// Lines without "data: " prefix should be ignored
			pw.Write([]byte("event: custom\nid: 123\nretry: 1000\ndata: actual-data\n\n"))
			time.Sleep(100 * time.Millisecond)
			pw.Close()
		}()
		
		select {
		case frame := <-frames:
			assert.Equal(t, "actual-data", string(frame.Data))
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for frame")
		}
	})
}

// Mock reader that returns an error after some data
type errorReader struct {
	data []byte
	err  error
	pos  int
}

func (r *errorReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, r.err
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	if r.pos >= len(r.data) && r.err != nil {
		return n, r.err
	}
	return n, nil
}

func TestReadStreamWithErrors(t *testing.T) {
	t.Run("read error handling", func(t *testing.T) {
		reader := &errorReader{
			data: []byte("data: partial\n"),
			err:  fmt.Errorf("network error"),
		}
		
		resp := &http.Response{
			Body: io.NopCloser(reader),
		}
		
		client := NewClient(Config{})
		frames := make(chan Frame, 10)
		errors := make(chan error, 1)
		
		go client.readStream(context.Background(), resp, frames, errors)
		
		select {
		case err := <-errors:
			assert.Contains(t, err.Error(), "read error")
			assert.Contains(t, err.Error(), "network error")
		case <-time.After(1 * time.Second):
			t.Fatal("timeout waiting for error")
		}
	})
}

// Benchmark tests
func BenchmarkStream(b *testing.B) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		
		for i := 0; i < 1000; i++ {
			fmt.Fprintf(w, "data: message %d with some payload data\n\n", i)
			flusher.Flush()
		}
	}))
	defer server.Close()
	
	client := NewClient(Config{
		Endpoint:   server.URL,
		BufferSize: 100,
	})
	
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		
		frames, _, err := client.Stream(StreamOptions{
			Context: ctx,
			Payload: struct{}{},
		})
		if err != nil {
			b.Fatal(err)
		}
		
		count := 0
		for range frames {
			count++
			if count >= 1000 {
				cancel()
				break
			}
		}
	}
}

func BenchmarkReadStream(b *testing.B) {
	data := bytes.Repeat([]byte("data: benchmark message with some test data\n\n"), 1000)
	
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		frames := make(chan Frame, 100)
		errors := make(chan error, 1)
		
		resp := &http.Response{
			Body: io.NopCloser(bytes.NewReader(data)),
		}
		
		client := NewClient(Config{})
		
		ctx, cancel := context.WithCancel(context.Background())
		go client.readStream(ctx, resp, frames, errors)
		
		count := 0
		for range frames {
			count++
			if count >= 1000 {
				cancel()
				break
			}
		}
	}
}