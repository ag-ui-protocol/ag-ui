package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/event"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/client/internal/message"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/client/sse"
	"github.com/sirupsen/logrus"
)

func DefaultEndpoint() string {
	return "http://localhost:8000/agentic"
}

func Chat(ctx context.Context, inputMsg string, endpoint string, send func(msg *message.Message)) error {
	logger := logrus.New()
	logger.SetLevel(logrus.FatalLevel)
	sseConfig := sse.Config{
		Endpoint:       endpoint,
		ConnectTimeout: 30 * time.Second,
		ReadTimeout:    5 * time.Minute,
		BufferSize:     100,
		Logger:         logger,
		AuthHeader:     "Authorization",
		AuthScheme:     "Bearer",
	}

	client := sse.NewClient(sseConfig)
	defer func() {
		client.Close()
	}()

	sessionID := "test-session-1755371887"
	runID := "run-1755744865857245000"

	payload := map[string]interface{}{
		"threadId": sessionID,
		"runId":    runID,
		"state":    map[string]interface{}{},
		"messages": []map[string]interface{}{
			{
				"id":      "msg-1",
				"role":    "user",
				"content": inputMsg,
			},
		},
		"tools":          []interface{}{},
		"context":        []interface{}{},
		"forwardedProps": map[string]interface{}{},
	}

	// Start the SSE stream
	var err error
	frames, errorCh, err := client.Stream(sse.StreamOptions{
		Context: ctx,
		Payload: payload,
	})

	if err != nil {
		return errors.New("Failed to establish SSE connection")
	}

	// Parse SSE events
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				return nil
			}

			rawEvent, err := event.Parse(frame.Data)
			if err != nil {
				return fmt.Errorf("failed to process SSE event %w", err)
			}
			currMsg := message.NewMessage(rawEvent)
			if currMsg == nil {
				return fmt.Errorf("failed to parse message %w", err)
			}
			send(currMsg)

		case err, ok := <-errorCh:
			if !ok {
				break
			}
			if err != nil {
				break
			}

		case <-ctx.Done():
			break
		}
	}
}
