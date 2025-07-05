package messages

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// StreamEvent represents an event in a message stream
type StreamEvent struct {
	Type      StreamEventType
	Message   Message
	Delta     *Delta
	Error     error
	Timestamp time.Time
}

// StreamEventType represents the type of stream event
type StreamEventType string

const (
	StreamEventStart    StreamEventType = "start"
	StreamEventDelta    StreamEventType = "delta"
	StreamEventComplete StreamEventType = "complete"
	StreamEventError    StreamEventType = "error"
)

// Delta represents incremental updates to a message
type Delta struct {
	Content       *string
	ToolCalls     []ToolCall
	ToolCallIndex int
}

// MessageStream represents a stream of message events
type MessageStream interface {
	// Next returns the next event in the stream
	Next(ctx context.Context) (*StreamEvent, error)

	// Close closes the stream
	Close() error
}

// StreamBuilder helps build streaming messages incrementally
type StreamBuilder struct {
	mu              sync.Mutex
	currentMessage  Message
	contentBuffer   strings.Builder
	toolCallBuffers map[int]*ToolCall
	completed       bool
}

// NewStreamBuilder creates a new stream builder
func NewStreamBuilder(role MessageRole) (*StreamBuilder, error) {
	if err := role.Validate(); err != nil {
		return nil, err
	}

	var msg Message
	switch role {
	case RoleAssistant:
		msg = &AssistantMessage{
			BaseMessage: BaseMessage{
				Role: role,
			},
		}
	case RoleUser:
		msg = &UserMessage{
			BaseMessage: BaseMessage{
				Role: role,
			},
		}
	default:
		return nil, fmt.Errorf("streaming not supported for role: %s", role)
	}

	// Ensure message has ID and metadata
	switch m := msg.(type) {
	case *AssistantMessage:
		m.BaseMessage.ensureID()
		m.BaseMessage.ensureMetadata()
	case *UserMessage:
		m.BaseMessage.ensureID()
		m.BaseMessage.ensureMetadata()
	default:
		return nil, fmt.Errorf("unsupported message type: %T", msg)
	}

	return &StreamBuilder{
		currentMessage:  msg,
		toolCallBuffers: make(map[int]*ToolCall),
	}, nil
}

// AddContent adds content to the message being built
func (sb *StreamBuilder) AddContent(delta string) error {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	if sb.completed {
		return fmt.Errorf("cannot add content to completed message")
	}

	sb.contentBuffer.WriteString(delta)

	// Update the message content
	content := sb.contentBuffer.String()
	switch msg := sb.currentMessage.(type) {
	case *AssistantMessage:
		msg.Content = &content
	case *UserMessage:
		msg.Content = &content
	default:
		return fmt.Errorf("unsupported message type for content: %T", msg)
	}

	return nil
}

// AddToolCall adds or updates a tool call
func (sb *StreamBuilder) AddToolCall(index int, delta ToolCall) error {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	if sb.completed {
		return fmt.Errorf("cannot add tool call to completed message")
	}

	// Only assistant messages support tool calls
	assistantMsg, ok := sb.currentMessage.(*AssistantMessage)
	if !ok {
		return fmt.Errorf("tool calls only supported for assistant messages")
	}

	// Get or create tool call buffer
	tc, exists := sb.toolCallBuffers[index]
	if !exists {
		tc = &ToolCall{}
		sb.toolCallBuffers[index] = tc
	}

	// Update tool call fields
	if delta.ID != "" {
		tc.ID = delta.ID
	}
	if delta.Type != "" {
		tc.Type = delta.Type
	}
	if delta.Function.Name != "" {
		tc.Function.Name = delta.Function.Name
	}
	if delta.Function.Arguments != "" {
		tc.Function.Arguments += delta.Function.Arguments
	}

	// Rebuild tool calls array
	assistantMsg.ToolCalls = make([]ToolCall, 0, len(sb.toolCallBuffers))
	keys := make([]int, 0, len(sb.toolCallBuffers))
	for k := range sb.toolCallBuffers {
		keys = append(keys, k)
	}
	sort.Ints(keys) // Ensure keys are sorted
	for _, i := range keys {
		if tc, exists := sb.toolCallBuffers[i]; exists {
			assistantMsg.ToolCalls = append(assistantMsg.ToolCalls, *tc)
		}
	}

	return nil
}

// GetMessage returns the current state of the message being built
func (sb *StreamBuilder) GetMessage() Message {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	return sb.currentMessage
}

// Complete marks the message as complete
func (sb *StreamBuilder) Complete() (Message, error) {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	if sb.completed {
		return nil, fmt.Errorf("message already completed")
	}

	sb.completed = true

	// Validate the completed message
	if err := sb.currentMessage.Validate(); err != nil {
		return nil, fmt.Errorf("completed message is invalid: %w", err)
	}

	return sb.currentMessage, nil
}

// StreamProcessor processes message streams with callbacks
type StreamProcessor struct {
	onStart    func(Message) error
	onDelta    func(Message, *Delta) error
	onComplete func(Message) error
	onError    func(error)
}

// NewStreamProcessor creates a new stream processor
func NewStreamProcessor() *StreamProcessor {
	return &StreamProcessor{}
}

// OnStart sets the callback for stream start events
func (sp *StreamProcessor) OnStart(fn func(Message) error) *StreamProcessor {
	sp.onStart = fn
	return sp
}

// OnDelta sets the callback for delta events
func (sp *StreamProcessor) OnDelta(fn func(Message, *Delta) error) *StreamProcessor {
	sp.onDelta = fn
	return sp
}

// OnComplete sets the callback for stream completion
func (sp *StreamProcessor) OnComplete(fn func(Message) error) *StreamProcessor {
	sp.onComplete = fn
	return sp
}

// OnError sets the callback for errors
func (sp *StreamProcessor) OnError(fn func(error)) *StreamProcessor {
	sp.onError = fn
	return sp
}

// Process processes a message stream
func (sp *StreamProcessor) Process(ctx context.Context, stream MessageStream) error {
	defer func() {
		_ = stream.Close() // Ignore close error on cleanup
	}()

	for {
		event, err := stream.Next(ctx)
		if err != nil {
			if sp.onError != nil {
				sp.onError(err)
			}
			return err
		}

		if event == nil {
			break
		}

		switch event.Type {
		case StreamEventStart:
			if sp.onStart != nil {
				if err := sp.onStart(event.Message); err != nil {
					return err
				}
			}

		case StreamEventDelta:
			if sp.onDelta != nil {
				if err := sp.onDelta(event.Message, event.Delta); err != nil {
					return err
				}
			}

		case StreamEventComplete:
			if sp.onComplete != nil {
				if err := sp.onComplete(event.Message); err != nil {
					return err
				}
			}

		case StreamEventError:
			if sp.onError != nil {
				sp.onError(event.Error)
			}
			return event.Error
		}
	}

	return nil
}

// BufferedStream buffers stream events for batch processing
type BufferedStream struct {
	stream    MessageStream
	buffer    []*StreamEvent
	bufferMu  sync.Mutex
	batchSize int
	flushChan chan []*StreamEvent
	closeChan chan struct{}
	wg        sync.WaitGroup
}

// NewBufferedStream creates a new buffered stream
func NewBufferedStream(stream MessageStream, batchSize int) *BufferedStream {
	bs := &BufferedStream{
		stream:    stream,
		buffer:    make([]*StreamEvent, 0, batchSize),
		batchSize: batchSize,
		flushChan: make(chan []*StreamEvent, 10),
		closeChan: make(chan struct{}),
	}

	// Start background goroutine to read from stream
	bs.wg.Add(1)
	go bs.readLoop()

	return bs
}

// readLoop reads from the underlying stream and buffers events
func (bs *BufferedStream) readLoop() {
	defer bs.wg.Done()
	ctx := context.Background()

	for {
		select {
		case <-bs.closeChan:
			bs.flush()
			return
		default:
			event, err := bs.stream.Next(ctx)
			if err != nil {
				// Send error event
				bs.addEvent(&StreamEvent{
					Type:      StreamEventError,
					Error:     err,
					Timestamp: time.Now(),
				})
				bs.flush()
				return
			}

			if event == nil {
				bs.flush()
				return
			}

			bs.addEvent(event)
		}
	}
}

// addEvent adds an event to the buffer
func (bs *BufferedStream) addEvent(event *StreamEvent) {
	bs.bufferMu.Lock()
	defer bs.bufferMu.Unlock()

	bs.buffer = append(bs.buffer, event)

	if len(bs.buffer) >= bs.batchSize {
		bs.flushLocked()
	}
}

// flush flushes the current buffer
func (bs *BufferedStream) flush() {
	bs.bufferMu.Lock()
	defer bs.bufferMu.Unlock()
	bs.flushLocked()
}

// flushLocked flushes the buffer (must be called with lock held)
func (bs *BufferedStream) flushLocked() {
	if len(bs.buffer) == 0 {
		return
	}

	batch := make([]*StreamEvent, len(bs.buffer))
	copy(batch, bs.buffer)
	bs.buffer = bs.buffer[:0]

	select {
	case bs.flushChan <- batch:
	case <-bs.closeChan:
		// Stream is closing, discard batch
	}
}

// NextBatch returns the next batch of events
func (bs *BufferedStream) NextBatch(ctx context.Context) ([]*StreamEvent, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case batch, ok := <-bs.flushChan:
		if !ok {
			return nil, nil
		}
		return batch, nil
	}
}

// Close closes the buffered stream
func (bs *BufferedStream) Close() error {
	close(bs.closeChan)
	bs.wg.Wait()
	close(bs.flushChan)
	return bs.stream.Close()
}

// StreamMerger merges multiple message streams into one
type StreamMerger struct {
	streams []MessageStream
	events  chan *StreamEvent
	wg      sync.WaitGroup
	closed  bool
	mu      sync.Mutex
}

// NewStreamMerger creates a new stream merger
func NewStreamMerger(streams ...MessageStream) *StreamMerger {
	sm := &StreamMerger{
		streams: streams,
		events:  make(chan *StreamEvent, len(streams)*10),
	}

	// Start goroutines for each stream
	for _, stream := range streams {
		sm.wg.Add(1)
		go sm.readStream(stream)
	}

	// Start goroutine to close channel when all streams are done
	go func() {
		sm.wg.Wait()
		close(sm.events)
	}()

	return sm
}

// readStream reads from a single stream
func (sm *StreamMerger) readStream(stream MessageStream) {
	defer sm.wg.Done()
	ctx := context.Background()

	for {
		event, err := stream.Next(ctx)
		if err != nil {
			sm.events <- &StreamEvent{
				Type:      StreamEventError,
				Error:     err,
				Timestamp: time.Now(),
			}
			return
		}

		if event == nil {
			return
		}

		sm.events <- event
	}
}

// Next returns the next event from any stream
func (sm *StreamMerger) Next(ctx context.Context) (*StreamEvent, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case event, ok := <-sm.events:
		if !ok {
			return nil, nil
		}
		return event, nil
	}
}

// Close closes all streams
func (sm *StreamMerger) Close() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.closed {
		return nil
	}
	sm.closed = true

	var errs []error
	for _, stream := range sm.streams {
		if err := stream.Close(); err != nil {
			errs = append(errs, err)
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("errors closing streams: %v", errs)
	}

	return nil
}
