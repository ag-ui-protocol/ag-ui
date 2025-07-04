package messages

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// HistoryOptions configures the message history behavior
type HistoryOptions struct {
	MaxMessages      int           // Maximum number of messages to store
	MaxAge           time.Duration // Maximum age of messages to keep
	CompactThreshold int           // Number of messages before compaction
	EnableIndexing   bool          // Enable message indexing for search
}

// DefaultHistoryOptions returns default history options
func DefaultHistoryOptions() HistoryOptions {
	return HistoryOptions{
		MaxMessages:      10000,
		MaxAge:           24 * time.Hour,
		CompactThreshold: 5000,
		EnableIndexing:   true,
	}
}

// History manages conversation message history with thread safety
type History struct {
	mu       sync.RWMutex
	messages []Message
	index    map[string]int // Message ID to index mapping
	options  HistoryOptions
	
	// Statistics
	totalMessages   int64
	compactionCount int64
}

// NewHistory creates a new message history
func NewHistory(options ...HistoryOptions) *History {
	opts := DefaultHistoryOptions()
	if len(options) > 0 {
		opts = options[0]
	}
	
	return &History{
		messages: make([]Message, 0, opts.MaxMessages),
		index:    make(map[string]int),
		options:  opts,
	}
}

// Add adds a message to the history
func (h *History) Add(msg Message) error {
	if msg == nil {
		return fmt.Errorf("cannot add nil message")
	}
	
	if err := msg.Validate(); err != nil {
		return fmt.Errorf("invalid message: %w", err)
	}
	
	h.mu.Lock()
	defer h.mu.Unlock()
	
	// Check if message already exists
	if _, exists := h.index[msg.GetID()]; exists {
		return fmt.Errorf("message with ID %s already exists", msg.GetID())
	}
	
	// Add message
	h.messages = append(h.messages, msg)
	h.totalMessages++
	
	// Update index
	if h.options.EnableIndexing {
		h.index[msg.GetID()] = len(h.messages) - 1
	}
	
	// Check if compaction is needed
	if len(h.messages) >= h.options.CompactThreshold {
		h.compact()
	}
	
	return nil
}

// AddBatch adds multiple messages to the history
func (h *History) AddBatch(messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	
	// Validate all messages first
	for i, msg := range messages {
		if msg == nil {
			return fmt.Errorf("nil message at index %d", i)
		}
		if err := msg.Validate(); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}
	}
	
	h.mu.Lock()
	defer h.mu.Unlock()
	
	// Check for duplicates
	for _, msg := range messages {
		if _, exists := h.index[msg.GetID()]; exists {
			return fmt.Errorf("message with ID %s already exists", msg.GetID())
		}
	}
	
	// Add all messages
	startIdx := len(h.messages)
	h.messages = append(h.messages, messages...)
	h.totalMessages += int64(len(messages))
	
	// Update index
	if h.options.EnableIndexing {
		for i, msg := range messages {
			h.index[msg.GetID()] = startIdx + i
		}
	}
	
	// Check if compaction is needed
	if len(h.messages) >= h.options.CompactThreshold {
		h.compact()
	}
	
	return nil
}

// Get retrieves a message by ID
func (h *History) Get(id string) (Message, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	idx, exists := h.index[id]
	if !exists {
		return nil, fmt.Errorf("message not found: %s", id)
	}
	
	if idx < 0 || idx >= len(h.messages) {
		return nil, fmt.Errorf("invalid index for message: %s", id)
	}
	
	return h.messages[idx], nil
}

// GetAll returns all messages in the history
func (h *History) GetAll() []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	result := make([]Message, len(h.messages))
	copy(result, h.messages)
	return result
}

// GetRange returns messages within the specified range
func (h *History) GetRange(start, end int) ([]Message, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	if start < 0 || end > len(h.messages) || start > end {
		return nil, fmt.Errorf("invalid range [%d, %d) for history of size %d", start, end, len(h.messages))
	}
	
	result := make([]Message, end-start)
	copy(result, h.messages[start:end])
	return result, nil
}

// GetLast returns the last n messages
func (h *History) GetLast(n int) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	if n <= 0 {
		return []Message{}
	}
	
	start := len(h.messages) - n
	if start < 0 {
		start = 0
	}
	
	result := make([]Message, len(h.messages)-start)
	copy(result, h.messages[start:])
	return result
}

// GetByRole returns all messages with the specified role
func (h *History) GetByRole(role MessageRole) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	var result []Message
	for _, msg := range h.messages {
		if msg.GetRole() == role {
			result = append(result, msg)
		}
	}
	return result
}

// GetAfter returns all messages after the specified timestamp
func (h *History) GetAfter(timestamp time.Time) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	var result []Message
	for _, msg := range h.messages {
		if meta := msg.GetMetadata(); meta != nil && meta.Timestamp.After(timestamp) {
			result = append(result, msg)
		}
	}
	return result
}

// Size returns the current number of messages
func (h *History) Size() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.messages)
}

// TotalMessages returns the total number of messages ever added
func (h *History) TotalMessages() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.totalMessages
}

// CompactionCount returns the number of times compaction has run
func (h *History) CompactionCount() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.compactionCount
}

// Clear removes all messages from the history
func (h *History) Clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	
	h.messages = h.messages[:0]
	h.index = make(map[string]int)
}

// compact removes old messages based on configured limits
func (h *History) compact() {
	h.compactionCount++
	
	// First, remove messages older than MaxAge
	if h.options.MaxAge > 0 {
		cutoff := time.Now().Add(-h.options.MaxAge)
		newMessages := make([]Message, 0, len(h.messages))
		
		for _, msg := range h.messages {
			if meta := msg.GetMetadata(); meta != nil && meta.Timestamp.After(cutoff) {
				newMessages = append(newMessages, msg)
			}
		}
		
		h.messages = newMessages
	}
	
	// Then, apply MaxMessages limit
	if h.options.MaxMessages > 0 && len(h.messages) > h.options.MaxMessages {
		// Keep the most recent messages
		start := len(h.messages) - h.options.MaxMessages
		h.messages = h.messages[start:]
	}
	
	// Rebuild index
	if h.options.EnableIndexing {
		h.index = make(map[string]int)
		for i, msg := range h.messages {
			h.index[msg.GetID()] = i
		}
	}
}

// Snapshot creates a snapshot of the current history state
func (h *History) Snapshot() *HistorySnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	messages := make([]Message, len(h.messages))
	copy(messages, h.messages)
	
	return &HistorySnapshot{
		Messages:        messages,
		TotalMessages:   h.totalMessages,
		CompactionCount: h.compactionCount,
		Timestamp:       time.Now(),
	}
}

// HistorySnapshot represents a point-in-time snapshot of the history
type HistorySnapshot struct {
	Messages        []Message `json:"messages"`
	TotalMessages   int64     `json:"totalMessages"`
	CompactionCount int64     `json:"compactionCount"`
	Timestamp       time.Time `json:"timestamp"`
}

// ToJSON serializes the snapshot to JSON
func (s *HistorySnapshot) ToJSON() ([]byte, error) {
	return json.Marshal(s)
}

// Search provides basic search functionality over message history
type SearchOptions struct {
	Query      string      // Text to search for
	Role       MessageRole // Filter by role (empty for all)
	StartTime  *time.Time  // Filter by start time
	EndTime    *time.Time  // Filter by end time
	MaxResults int         // Maximum results to return
}

// Search searches for messages matching the given criteria
func (h *History) Search(options SearchOptions) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	var results []Message
	
	for _, msg := range h.messages {
		// Check role filter
		if options.Role != "" && msg.GetRole() != options.Role {
			continue
		}
		
		// Check time filters
		if meta := msg.GetMetadata(); meta != nil {
			if options.StartTime != nil && meta.Timestamp.Before(*options.StartTime) {
				continue
			}
			if options.EndTime != nil && meta.Timestamp.After(*options.EndTime) {
				continue
			}
		}
		
		// Check text search
		if options.Query != "" {
			content := msg.GetContent()
			if content == nil || !containsIgnoreCase(*content, options.Query) {
				continue
			}
		}
		
		results = append(results, msg)
		
		// Check max results
		if options.MaxResults > 0 && len(results) >= options.MaxResults {
			break
		}
	}
	
	return results
}

// containsIgnoreCase performs case-insensitive string search
func containsIgnoreCase(s, substr string) bool {
	if len(substr) == 0 {
		return true
	}
	if len(s) < len(substr) {
		return false
	}
	
	// Simple case-insensitive search
	// In production, consider using strings.ToLower or a more efficient algorithm
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			if toLower(s[i+j]) != toLower(substr[j]) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// toLower converts a single character to lowercase
func toLower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

// ThreadedHistory manages multiple conversation threads
type ThreadedHistory struct {
	mu      sync.RWMutex
	threads map[string]*History
	options HistoryOptions
}

// NewThreadedHistory creates a new threaded history manager
func NewThreadedHistory(options ...HistoryOptions) *ThreadedHistory {
	opts := DefaultHistoryOptions()
	if len(options) > 0 {
		opts = options[0]
	}
	
	return &ThreadedHistory{
		threads: make(map[string]*History),
		options: opts,
	}
}

// GetThread retrieves or creates a thread
func (th *ThreadedHistory) GetThread(threadID string) *History {
	th.mu.Lock()
	defer th.mu.Unlock()
	
	if thread, exists := th.threads[threadID]; exists {
		return thread
	}
	
	thread := NewHistory(th.options)
	th.threads[threadID] = thread
	return thread
}

// DeleteThread removes a thread
func (th *ThreadedHistory) DeleteThread(threadID string) {
	th.mu.Lock()
	defer th.mu.Unlock()
	delete(th.threads, threadID)
}

// ListThreads returns all thread IDs
func (th *ThreadedHistory) ListThreads() []string {
	th.mu.RLock()
	defer th.mu.RUnlock()
	
	threads := make([]string, 0, len(th.threads))
	for id := range th.threads {
		threads = append(threads, id)
	}
	return threads
}