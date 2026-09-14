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

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestRunAgentInput returns a minimal RunAgentInput payload for streaming tests.
func newTestRunAgentInput() types.RunAgentInput {
	return types.RunAgentInput{
		ThreadID:       "thread-1",
		RunID:          "run-1",
		State:          map[string]any{},
		Messages:       []types.Message{},
		Tools:          []types.Tool{},
		Context:        []types.Context{},
		ForwardedProps: map[string]any{},
	}
}

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
			Payload: newTestRunAgentInput(),
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
			Payload: newTestRunAgentInput(),
		})
		require.NoError(t, err)

		select {
		case frame := <-frames:
			assert.Equal(t, "line1\nline2\nline3", string(frame.Data))
		case <-time.After(1 * time.Second):
			require.FailNow(t, "timeout waiting for frame")
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
					Payload: newTestRunAgentInput(),
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
			Payload: newTestRunAgentInput(),
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
					Payload: newTestRunAgentInput(),
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
			Payload: newTestRunAgentInput(),
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
				require.FailNow(t, "test took too long")
			}
		}
	})

	t.Run("invalid payload marshaling", func(t *testing.T) {
		client := NewClient(Config{
			Endpoint: "http://localhost",
		})

		input := newTestRunAgentInput()
		input.State = make(chan int)

		_, _, err := client.Stream(StreamOptions{
			Payload: input,
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to marshal payload")
	})

	t.Run("invalid endpoint", func(t *testing.T) {
		client := NewClient(Config{
			Endpoint: "http://[::1]:namedport", // Invalid URL
		})

		_, _, err := client.Stream(StreamOptions{
			Payload: newTestRunAgentInput(),
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
			Payload: newTestRunAgentInput(),
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
			Payload: newTestRunAgentInput(),
		})
		require.NoError(t, err)

		// Should receive initial message
		select {
		case frame := <-frames:
			assert.Equal(t, "initial", string(frame.Data))
		case <-time.After(1 * time.Second):
			require.FailNow(t, "timeout waiting for initial frame")
		}

		// Should eventually get an error or channel closure due to read timeout
		select {
		case <-frames:
			// Channel closed
		case err := <-errors:
			assert.NotNil(t, err)
		case <-time.After(2 * time.Second):
			require.FailNow(t, "timeout waiting for error or closure")
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
			Payload: newTestRunAgentInput(),
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
			require.FailNow(t, "timeout waiting for frame")
		}

		// Channels should be closed after EOF
		select {
		case _, ok := <-frames:
			assert.False(t, ok, "frames channel should be closed")
		case <-time.After(1 * time.Second):
			require.FailNow(t, "frames channel not closed")
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
			require.FailNow(t, "timeout waiting for frame")
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
			require.FailNow(t, "timeout waiting for frame")
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
			require.FailNow(t, "timeout waiting for frame")
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
			require.FailNow(t, "timeout waiting for error")
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
			Payload: newTestRunAgentInput(),
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

// holdingReader serves data and then blocks instead of reporting EOF, the way a
// server that keeps a connection open but stops sending does. Nothing about the
// stream tells the reader to stop, so a reader that only stops at EOF never
// stops here.
type holdingReader struct {
	data    []byte
	pos     int
	release chan struct{}
}

func newHoldingReader(t *testing.T, data []byte) *holdingReader {
	t.Helper()
	r := &holdingReader{data: data, release: make(chan struct{})}
	t.Cleanup(func() { close(r.release) })
	return r
}

func (r *holdingReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		<-r.release
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

// collectReadStream runs readStream over body and reports the frames it
// dispatched and the error it ended with. It fails the test if readStream never
// returns, which is what an unbounded accumulator looks like from the outside.
func collectReadStream(t *testing.T, client *Client, body io.Reader) ([]Frame, error) {
	t.Helper()

	resp := &http.Response{Body: io.NopCloser(body)}
	frames := make(chan Frame, 16)
	errCh := make(chan error, 1)

	go client.readStream(context.Background(), resp, frames, errCh)

	var collected []Frame
	deadline := time.After(10 * time.Second)
loop:
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				break loop
			}
			collected = append(collected, frame)
		case <-deadline:
			require.FailNow(t, "readStream never returned; the reader is still accumulating")
		}
	}

	var err error
	select {
	case err = <-errCh:
	default:
	}
	return collected, err
}

// dataLines returns count `data:` lines of payload bytes each, with no blank
// line, so they accumulate into one frame that is never dispatched.
func dataLines(count, payload int) []byte {
	var b bytes.Buffer
	for i := 0; i < count; i++ {
		b.WriteString("data: ")
		b.Write(bytes.Repeat([]byte("x"), payload))
		b.WriteByte('\n')
	}
	return b.Bytes()
}

func TestReadStreamBounds(t *testing.T) {
	const cap = 4096

	newCappedClient := func() *Client {
		return NewClient(Config{MaxFrameBytes: cap, BufferSize: 16})
	}

	t.Run("refuses a line that never ends", func(t *testing.T) {
		// No delimiter anywhere. bufio.Reader.ReadBytes grows its buffer until it
		// finds one, so before the per-line limit this read never returned.
		body := newHoldingReader(t, append([]byte("data: "), bytes.Repeat([]byte("x"), 8*cap)...))

		frames, err := collectReadStream(t, newCappedClient(), body)

		require.Error(t, err)
		assert.Contains(t, err.Error(), "exceeded")
		assert.Empty(t, frames, "an unterminated line must not be dispatched")
	})

	t.Run("refuses a frame accumulated across many lines", func(t *testing.T) {
		// Every line is well under the per-line limit, so only a cap on the
		// accumulated frame stops this one.
		body := newHoldingReader(t, dataLines(200, 100))

		frames, err := collectReadStream(t, newCappedClient(), body)

		require.Error(t, err)
		assert.Contains(t, err.Error(), "exceeded")
		assert.Empty(t, frames, "a frame over the cap must not be dispatched")
	})

	t.Run("dispatches nothing after an overflow", func(t *testing.T) {
		/*
		 * There is no offset after a refused frame that is known to be a frame
		 * boundary. Resetting the buffer and carrying on reads the tail of the
		 * refused frame as a frame of its own, which lets a sender put anything it
		 * likes past the cap and have it dispatched.
		 */
		var body bytes.Buffer
		body.WriteString("data: good\n\n")
		body.Write(dataLines(200, 100))
		body.WriteString("\n")
		body.WriteString("data: forged\n\n")

		frames, err := collectReadStream(t, newCappedClient(), newHoldingReader(t, body.Bytes()))

		require.Error(t, err)
		require.Len(t, frames, 1, "only the frame that completed before the overflow may be dispatched")
		assert.Equal(t, "good", string(frames[0].Data))
	})

	t.Run("still dispatches a frame at the cap", func(t *testing.T) {
		// The boundary is inclusive: a frame whose data is exactly MaxFrameBytes
		// long is legitimate and has to get through.
		payload := bytes.Repeat([]byte("y"), cap)
		body := append(append([]byte("data: "), payload...), '\n', '\n')

		frames, err := collectReadStream(t, newCappedClient(), bytes.NewReader(body))

		assert.NoError(t, err)
		require.Len(t, frames, 1)
		assert.Equal(t, payload, frames[0].Data)
	})

	t.Run("defaults to the cap the Dart SDK uses", func(t *testing.T) {
		// kSseDefaultMaxDataCodeUnits in sdks/community/dart/lib/src/internal/
		// sse_constants.dart. Kept equal so the community SDKs bound an
		// unterminated stream at the same point.
		assert.Equal(t, 8*1024*1024, DefaultMaxFrameBytes)
		assert.Equal(t, DefaultMaxFrameBytes, NewClient(Config{}).config.MaxFrameBytes)
		// A negative cap would otherwise reach the reader and refuse every frame.
		assert.Equal(t, DefaultMaxFrameBytes, NewClient(Config{MaxFrameBytes: -1}).config.MaxFrameBytes)
	})
}
