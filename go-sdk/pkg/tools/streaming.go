package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// StreamingContext provides context and utilities for streaming tool execution.
type StreamingContext struct {
	ctx    context.Context
	chunks chan *ToolStreamChunk
	index  int
	mu     sync.Mutex
	closed bool
}

// NewStreamingContext creates a new streaming context.
func NewStreamingContext(ctx context.Context) *StreamingContext {
	return &StreamingContext{
		ctx:    ctx,
		chunks: make(chan *ToolStreamChunk, 100), // Buffered channel
		index:  0,
	}
}

// Send sends a data chunk to the stream.
func (sc *StreamingContext) Send(data interface{}) error {
	return sc.sendChunk("data", data)
}

// SendError sends an error chunk to the stream.
func (sc *StreamingContext) SendError(err error) error {
	return sc.sendChunk("error", err.Error())
}

// SendMetadata sends metadata to the stream.
func (sc *StreamingContext) SendMetadata(metadata map[string]interface{}) error {
	return sc.sendChunk("metadata", metadata)
}

// Complete sends a completion signal to the stream.
func (sc *StreamingContext) Complete() error {
	return sc.sendChunk("complete", nil)
}

// Channel returns the read-only channel for consuming chunks.
func (sc *StreamingContext) Channel() <-chan *ToolStreamChunk {
	return sc.chunks
}

// Close closes the streaming context and its channel.
func (sc *StreamingContext) Close() error {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	if !sc.closed {
		close(sc.chunks)
		sc.closed = true
	}
	return nil
}

// sendChunk sends a chunk to the stream.
func (sc *StreamingContext) sendChunk(chunkType string, data interface{}) error {
	var chunk *ToolStreamChunk

	sc.mu.Lock()
	if sc.closed {
		sc.mu.Unlock()
		return fmt.Errorf("streaming context is closed")
	}

	chunk = &ToolStreamChunk{
		Type:  chunkType,
		Data:  data,
		Index: sc.index,
	}
	sc.index++
	sc.mu.Unlock()

	select {
	case sc.chunks <- chunk:
		return nil
	case <-sc.ctx.Done():
		return sc.ctx.Err()
	}
}

// StreamingToolHelper provides utilities for implementing streaming tools.
type StreamingToolHelper struct {
}

// NewStreamingToolHelper creates a new streaming tool helper.
func NewStreamingToolHelper() *StreamingToolHelper {
	return &StreamingToolHelper{}
}

// StreamJSON streams a large JSON object in chunks.
func (h *StreamingToolHelper) StreamJSON(ctx context.Context, data interface{}, chunkSize int) (<-chan *ToolStreamChunk, error) {
	// Validate chunkSize
	if chunkSize <= 0 {
		return nil, fmt.Errorf("chunkSize must be positive, got %d", chunkSize)
	}

	// Marshal the data to JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	// Create output channel
	out := make(chan *ToolStreamChunk)

	go func() {
		defer close(out)

		index := 0
		for i := 0; i < len(jsonData); i += chunkSize {
			end := i + chunkSize
			if end > len(jsonData) {
				end = len(jsonData)
			}

			chunk := &ToolStreamChunk{
				Type:  "data",
				Data:  string(jsonData[i:end]),
				Index: index,
			}
			index++

			select {
			case out <- chunk:
			case <-ctx.Done():
				return
			}
		}

		// Send completion chunk
		out <- &ToolStreamChunk{
			Type:  "complete",
			Index: index,
		}
	}()

	return out, nil
}

// StreamReader streams data from an io.Reader.
func (h *StreamingToolHelper) StreamReader(ctx context.Context, reader io.Reader, chunkSize int) (<-chan *ToolStreamChunk, error) {
	// Validate chunkSize
	if chunkSize <= 0 {
		return nil, fmt.Errorf("chunkSize must be positive, got %d", chunkSize)
	}

	out := make(chan *ToolStreamChunk)

	go func() {
		defer close(out)

		buffer := make([]byte, chunkSize)
		index := 0

		for {
			n, err := reader.Read(buffer)
			if n > 0 {
				chunk := &ToolStreamChunk{
					Type:  "data",
					Data:  string(buffer[:n]),
					Index: index,
				}
				index++

				select {
				case out <- chunk:
				case <-ctx.Done():
					return
				}
			}

			if err == io.EOF {
				// Send completion chunk
				out <- &ToolStreamChunk{
					Type:  "complete",
					Index: index,
				}
				return
			}

			if err != nil {
				// Send error chunk
				out <- &ToolStreamChunk{
					Type:  "error",
					Data:  err.Error(),
					Index: index,
				}
				return
			}
		}
	}()

	return out, nil
}

// StreamAccumulator accumulates streaming chunks back into complete data.
type StreamAccumulator struct {
	mu      sync.Mutex
	chunks  []string
	metadata map[string]interface{}
	hasError bool
	errorMsg string
	complete bool
}

// NewStreamAccumulator creates a new stream accumulator.
func NewStreamAccumulator() *StreamAccumulator {
	return &StreamAccumulator{
		chunks:   []string{},
		metadata: make(map[string]interface{}),
	}
}

// AddChunk adds a chunk to the accumulator.
func (sa *StreamAccumulator) AddChunk(chunk *ToolStreamChunk) error {
	sa.mu.Lock()
	defer sa.mu.Unlock()

	if sa.complete {
		return fmt.Errorf("cannot add chunk after stream is complete")
	}

	switch chunk.Type {
	case "data":
		if str, ok := chunk.Data.(string); ok {
			sa.chunks = append(sa.chunks, str)
		} else {
			return fmt.Errorf("data chunk must contain string data")
		}

	case "metadata":
		if meta, ok := chunk.Data.(map[string]interface{}); ok {
			for k, v := range meta {
				sa.metadata[k] = v
			}
		}

	case "error":
		sa.hasError = true
		if errStr, ok := chunk.Data.(string); ok {
			sa.errorMsg = errStr
		}

	case "complete":
		sa.complete = true
	}

	return nil
}

// GetResult returns the accumulated result.
func (sa *StreamAccumulator) GetResult() (string, map[string]interface{}, error) {
	sa.mu.Lock()
	defer sa.mu.Unlock()

	if sa.hasError {
		return "", sa.metadata, fmt.Errorf("stream error: %s", sa.errorMsg)
	}

	if !sa.complete {
		return "", sa.metadata, fmt.Errorf("stream is not complete")
	}

	result := ""
	for _, chunk := range sa.chunks {
		result += chunk
	}

	return result, sa.metadata, nil
}

// IsComplete returns whether the stream is complete.
func (sa *StreamAccumulator) IsComplete() bool {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	return sa.complete
}

// HasError returns whether the stream encountered an error.
func (sa *StreamAccumulator) HasError() bool {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	return sa.hasError
}

// StreamingParameterParser helps parse streaming tool parameters.
type StreamingParameterParser struct {
	buffer     string
	complete   bool
	validator  *SchemaValidator
}

// NewStreamingParameterParser creates a new streaming parameter parser.
func NewStreamingParameterParser(schema *ToolSchema) *StreamingParameterParser {
	return &StreamingParameterParser{
		validator: NewSchemaValidator(schema),
	}
}

// AddChunk adds a parameter chunk to the parser.
func (spp *StreamingParameterParser) AddChunk(chunk string) {
	spp.buffer += chunk
}

// TryParse attempts to parse the accumulated parameters.
func (spp *StreamingParameterParser) TryParse() (map[string]interface{}, error) {
	var params map[string]interface{}
	if err := json.Unmarshal([]byte(spp.buffer), &params); err != nil {
		return nil, err
	}

	// Validate if we have a validator
	if spp.validator != nil {
		if err := spp.validator.Validate(params); err != nil {
			return nil, err
		}
	}

	spp.complete = true
	return params, nil
}

// IsComplete returns whether parsing is complete.
func (spp *StreamingParameterParser) IsComplete() bool {
	return spp.complete
}

// StreamingResultBuilder helps build streaming results.
type StreamingResultBuilder struct {
	ctx      context.Context
	streamCtx *StreamingContext
}

// NewStreamingResultBuilder creates a new streaming result builder.
func NewStreamingResultBuilder(ctx context.Context) *StreamingResultBuilder {
	return &StreamingResultBuilder{
		ctx:       ctx,
		streamCtx: NewStreamingContext(ctx),
	}
}

// SendProgress sends progress updates.
func (srb *StreamingResultBuilder) SendProgress(current, total int, message string) error {
	return srb.streamCtx.SendMetadata(map[string]interface{}{
		"progress": map[string]interface{}{
			"current": current,
			"total":   total,
			"message": message,
		},
	})
}

// SendPartialResult sends a partial result.
func (srb *StreamingResultBuilder) SendPartialResult(data interface{}) error {
	return srb.streamCtx.Send(data)
}

// Complete completes the streaming result.
func (srb *StreamingResultBuilder) Complete(finalData interface{}) error {
	if finalData != nil {
		if err := srb.streamCtx.Send(finalData); err != nil {
			return err
		}
	}
	return srb.streamCtx.Complete()
}

// Error sends an error and closes the stream.
func (srb *StreamingResultBuilder) Error(err error) error {
	if err := srb.streamCtx.SendError(err); err != nil {
		return err
	}
	return srb.streamCtx.Close()
}

// Channel returns the streaming channel.
func (srb *StreamingResultBuilder) Channel() <-chan *ToolStreamChunk {
	return srb.streamCtx.Channel()
}