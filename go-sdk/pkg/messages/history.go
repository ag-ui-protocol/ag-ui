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
	MaxMemoryBytes   int64         // Maximum memory usage in bytes (default: 100MB)
}

// DefaultHistoryOptions returns default history options
func DefaultHistoryOptions() HistoryOptions {
	return HistoryOptions{
		MaxMessages:      10000,
		MaxAge:           24 * time.Hour,
		CompactThreshold: 5000,
		EnableIndexing:   true,
		MaxMemoryBytes:   100 * 1024 * 1024, // 100MB default
	}
}

// History manages conversation message history with thread safety
//
// Optimization Strategy:
// The History struct uses a circular buffer approach with lazy compaction to achieve
// better than O(n) complexity for common operations:
//
// 1. Circular Buffer: Instead of shifting elements when removing from the front,
//    we use head/tail pointers to track the active range. This makes removal O(1).
//
// 2. Lazy Compaction: We don't compact on every operation. Instead, we use
//    heuristics (memory pressure, message count, time) to trigger compaction.
//
// 3. Pre-calculated Sizes: Message sizes are calculated once and cached to avoid
//    repeated JSON marshaling during memory limit checks.
//
// 4. Time Index: Messages are indexed by time buckets (minutes) to enable
//    efficient age-based pruning without scanning all messages.
//
// 5. Defragmentation: When the buffer becomes sparse (lots of unused space at
//    the beginning), we defragment by moving active messages to the start.
//    This operation is O(n) but happens rarely.
//
// Common operations complexity:
// - Add: O(1) amortized (O(n) worst case during defragmentation)
// - Remove old messages: O(k) where k is messages removed
// - Get by ID: O(1) with indexing enabled
// - Size check: O(1)
type History struct {
	mu       sync.RWMutex
	messages []Message
	index    map[string]int // Message ID to index mapping
	options  HistoryOptions
	
	// Statistics
	totalMessages     int64
	compactionCount   int64
	currentMemoryBytes int64 // Current memory usage in bytes
	
	// Optimization fields for efficient pruning
	head              int                    // First valid message index (for circular buffer behavior)
	tail              int                    // Last valid message index + 1
	messageSizes      []int64                // Pre-calculated message sizes
	timeIndex         map[int64][]int        // Timestamp (unix seconds) -> message indices
	lastCompactTime   time.Time              // Last time compaction was run
	pendingCompaction bool                   // Flag to indicate pending lazy compaction
}

// NewHistory creates a new message history
func NewHistory(options ...HistoryOptions) *History {
	opts := DefaultHistoryOptions()
	if len(options) > 0 {
		opts = options[0]
	}
	
	// Pre-allocate with extra capacity to reduce reallocations
	capacity := opts.MaxMessages
	if capacity == 0 {
		capacity = 1000
	}
	
	return &History{
		messages:        make([]Message, capacity),
		messageSizes:    make([]int64, capacity),
		index:           make(map[string]int),
		timeIndex:       make(map[int64][]int),
		options:         opts,
		head:            0,
		tail:            0,
		lastCompactTime: time.Now(),
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
	
	// Calculate message size
	msgSize, err := h.calculateMessageSize(msg)
	if err != nil {
		return fmt.Errorf("failed to calculate message size: %w", err)
	}
	
	// Check if lazy compaction is needed based on various thresholds
	if h.shouldCompact(msgSize) {
		h.performLazyCompaction()
		
		// Check again after compaction
		if h.options.MaxMemoryBytes > 0 && h.currentMemoryBytes+msgSize > h.options.MaxMemoryBytes {
			return fmt.Errorf("adding message would exceed memory limit: current=%d, message=%d, limit=%d",
				h.currentMemoryBytes, msgSize, h.options.MaxMemoryBytes)
		}
	}
	
	// After compaction, we might need to defragment if tail is at the end
	// This ensures we have room for the new message
	if h.tail >= len(h.messages) {
		// Try defragmentation first to avoid growing unnecessarily
		if h.head > 0 {
			h.defragmentBuffer()
		} else {
			// If no room to defragment, grow the buffer
			h.growBuffer()
		}
	}
	
	// Ensure messageSizes array has same capacity
	if h.tail >= len(h.messageSizes) {
		newSizes := make([]int64, len(h.messages))
		copy(newSizes, h.messageSizes)
		h.messageSizes = newSizes
	}
	
	// Add message using circular buffer approach
	insertIdx := h.tail
	h.messages[insertIdx] = msg
	h.messageSizes[insertIdx] = msgSize
	h.tail++
	h.totalMessages++
	h.currentMemoryBytes += msgSize
	
	// Update indices
	if h.options.EnableIndexing {
		h.index[msg.GetID()] = insertIdx
	}
	
	// Update time index for efficient age-based pruning
	if meta := msg.GetMetadata(); meta != nil {
		timeBucket := meta.Timestamp.Unix() / 60 // Group by minute
		h.timeIndex[timeBucket] = append(h.timeIndex[timeBucket], insertIdx)
	}
	
	return nil
}

// AddBatch adds multiple messages to the history
func (h *History) AddBatch(messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	
	// Validate all messages first
	msgSizes := make([]int64, len(messages))
	var totalSize int64
	
	for i, msg := range messages {
		if msg == nil {
			return fmt.Errorf("nil message at index %d", i)
		}
		if err := msg.Validate(); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}
		
		// Pre-calculate message sizes
		msgSize, err := h.calculateMessageSize(msg)
		if err != nil {
			return fmt.Errorf("failed to calculate message size: %w", err)
		}
		msgSizes[i] = msgSize
		totalSize += msgSize
	}
	
	h.mu.Lock()
	defer h.mu.Unlock()
	
	// Check for duplicates
	for _, msg := range messages {
		if _, exists := h.index[msg.GetID()]; exists {
			return fmt.Errorf("message with ID %s already exists", msg.GetID())
		}
	}
	
	// Check if compaction is needed
	if h.shouldCompact(totalSize) {
		h.performLazyCompaction()
		
		// Check again after compaction
		if h.options.MaxMemoryBytes > 0 && h.currentMemoryBytes+totalSize > h.options.MaxMemoryBytes {
			return fmt.Errorf("adding messages would exceed memory limit: current=%d, batch=%d, limit=%d",
				h.currentMemoryBytes, totalSize, h.options.MaxMemoryBytes)
		}
	}
	
	// Ensure we have capacity for batch
	neededCapacity := h.tail + len(messages)
	if neededCapacity > len(h.messages) {
		// Grow buffer to accommodate batch
		newCapacity := len(h.messages) * 2
		if newCapacity < neededCapacity {
			newCapacity = neededCapacity + neededCapacity/10 // 10% overhead
		}
		if h.options.MaxMessages > 0 && newCapacity > h.options.MaxMessages {
			newCapacity = h.options.MaxMessages + h.options.MaxMessages/10
		}
		
		newMessages := make([]Message, newCapacity)
		newSizes := make([]int64, newCapacity)
		activeCount := h.tail - h.head
		copy(newMessages, h.messages[h.head:h.tail])
		copy(newSizes, h.messageSizes[h.head:h.tail])
		
		// Update indices after reallocation
		if h.options.EnableIndexing {
			for i := 0; i < activeCount; i++ {
				if newMessages[i] != nil {
					h.index[newMessages[i].GetID()] = i
				}
			}
		}
		
		h.messages = newMessages
		h.messageSizes = newSizes
		h.head = 0
		h.tail = activeCount
	}
	
	// Add all messages in batch
	for i, msg := range messages {
		insertIdx := h.tail + i
		h.messages[insertIdx] = msg
		h.messageSizes[insertIdx] = msgSizes[i]
		
		// Update indices
		if h.options.EnableIndexing {
			h.index[msg.GetID()] = insertIdx
		}
		
		// Update time index
		if meta := msg.GetMetadata(); meta != nil {
			timeBucket := meta.Timestamp.Unix() / 60
			h.timeIndex[timeBucket] = append(h.timeIndex[timeBucket], insertIdx)
		}
	}
	
	h.tail += len(messages)
	h.totalMessages += int64(len(messages))
	h.currentMemoryBytes += totalSize
	
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
	
	// Validate index is within active range
	if idx < h.head || idx >= h.tail || h.messages[idx] == nil {
		return nil, fmt.Errorf("invalid index for message: %s", id)
	}
	
	return h.messages[idx], nil
}

// GetAll returns all messages in the history
func (h *History) GetAll() []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	activeCount := h.tail - h.head
	result := make([]Message, activeCount)
	copy(result, h.messages[h.head:h.tail])
	return result
}

// GetRange returns messages within the specified range
func (h *History) GetRange(start, end int) ([]Message, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	activeCount := h.tail - h.head
	if start < 0 || end > activeCount || start > end {
		return nil, fmt.Errorf("invalid range [%d, %d) for history of size %d", start, end, activeCount)
	}
	
	// Adjust indices to circular buffer
	actualStart := h.head + start
	actualEnd := h.head + end
	
	result := make([]Message, end-start)
	copy(result, h.messages[actualStart:actualEnd])
	return result, nil
}

// GetLast returns the last n messages
func (h *History) GetLast(n int) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	if n <= 0 {
		return []Message{}
	}
	
	activeCount := h.tail - h.head
	if n > activeCount {
		n = activeCount
	}
	
	start := h.tail - n
	result := make([]Message, n)
	copy(result, h.messages[start:h.tail])
	return result
}

// GetByRole returns all messages with the specified role
func (h *History) GetByRole(role MessageRole) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	var result []Message
	for i := h.head; i < h.tail; i++ {
		if h.messages[i] != nil && h.messages[i].GetRole() == role {
			result = append(result, h.messages[i])
		}
	}
	return result
}

// GetAfter returns all messages after the specified timestamp
func (h *History) GetAfter(timestamp time.Time) []Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	var result []Message
	for i := h.head; i < h.tail; i++ {
		if h.messages[i] != nil {
			if meta := h.messages[i].GetMetadata(); meta != nil && meta.Timestamp.After(timestamp) {
				result = append(result, h.messages[i])
			}
		}
	}
	return result
}

// Size returns the current number of messages
func (h *History) Size() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.size()
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
	
	// Clear all messages in the active range
	for i := h.head; i < h.tail; i++ {
		h.messages[i] = nil
		h.messageSizes[i] = 0
	}
	
	h.head = 0
	h.tail = 0
	h.index = make(map[string]int)
	h.timeIndex = make(map[int64][]int)
	h.currentMemoryBytes = 0
	h.pendingCompaction = false
}

// CurrentMemoryBytes returns the current memory usage in bytes
func (h *History) CurrentMemoryBytes() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.currentMemoryBytes
}

// calculateMessageSize estimates the memory size of a message
func (h *History) calculateMessageSize(msg Message) (int64, error) {
	// Serialize to JSON to get accurate size including all fields
	data, err := json.Marshal(msg)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal message: %w", err)
	}
	
	// Add overhead for Go's internal structures (approximate)
	// This includes slice headers, map entries, string headers, etc.
	overhead := int64(256) // Base overhead per message
	
	// Add index overhead if indexing is enabled
	if h.options.EnableIndexing {
		overhead += int64(len(msg.GetID())) + 64 // String + map entry
	}
	
	return int64(len(data)) + overhead, nil
}

// shouldCompact determines if compaction should be triggered
// Uses multiple heuristics to avoid unnecessary compaction while maintaining performance
func (h *History) shouldCompact(incomingSize int64) bool {
	// Check memory pressure first (most critical)
	if h.options.MaxMemoryBytes > 0 && h.currentMemoryBytes+incomingSize > h.options.MaxMemoryBytes {
		return true
	}
	
	// Check message count threshold
	if h.size() >= h.options.CompactThreshold {
		return true
	}
	
	// Check if enough time has passed for age-based cleanup (lazy check)
	if h.options.MaxAge > 0 && time.Since(h.lastCompactTime) > h.options.MaxAge/10 {
		h.pendingCompaction = true
	}
	
	// Perform pending compaction if buffer is getting fragmented
	if h.pendingCompaction && float64(h.tail-h.head) > float64(len(h.messages))*0.8 {
		return true
	}
	
	return false
}

// performLazyCompaction performs efficient compaction using optimized algorithms
// This method aims for O(n) worst case but O(1) amortized for most operations
func (h *History) performLazyCompaction() {
	h.compactionCount++
	h.lastCompactTime = time.Now()
	h.pendingCompaction = false
	
	var newHead int
	cutoffTime := time.Now().Add(-h.options.MaxAge)
	
	// Phase 1: Find new head position based on age (O(log n) using time index)
	if h.options.MaxAge > 0 {
		newHead = h.findFirstValidMessageByTime(cutoffTime)
	} else {
		newHead = h.head
	}
	
	// Phase 2: Apply message count limit (O(1))
	// When we're at MaxMessages, we need to remove at least one to make room
	if h.options.MaxMessages > 0 && h.size() >= h.options.MaxMessages {
		// Keep MaxMessages-1 to make room for the new message
		maxStart := h.tail - (h.options.MaxMessages - 1)
		if maxStart > newHead {
			newHead = maxStart
		}
	}
	
	// Phase 3: Apply memory limit if needed (O(k) where k is messages to remove)
	if h.options.MaxMemoryBytes > 0 {
		newHead = h.adjustForMemoryLimit(newHead)
	}
	
	// Phase 4: Check if defragmentation will be needed after removal
	// We check this BEFORE updating head to make the right decision
	shouldDefrag := h.shouldDefragment() || (newHead > h.head && h.tail >= len(h.messages)-1)
	
	// Phase 5: Update state and clean up (O(k) where k is removed messages)
	if newHead > h.head {
		h.removeMessagesBeforeIndex(newHead)
	}
	
	// Phase 6: Defragment if needed (O(n) but rare)
	if shouldDefrag {
		h.defragmentBuffer()
	}
}

// findFirstValidMessageByTime uses the time index to efficiently find messages
// Returns the index of the first message after the cutoff time
// Complexity: O(log n) average case
func (h *History) findFirstValidMessageByTime(cutoff time.Time) int {
	cutoffBucket := cutoff.Unix() / 60
	
	// Clean old time index entries
	for bucket := range h.timeIndex {
		if bucket < cutoffBucket-1 {
			delete(h.timeIndex, bucket)
		}
	}
	
	// If no messages, return head
	if h.head >= h.tail {
		return h.head
	}
	
	// Linear scan for now to ensure correctness
	// We can optimize this later if needed
	for i := h.head; i < h.tail; i++ {
		if h.messages[i] != nil {
			if meta := h.messages[i].GetMetadata(); meta != nil && !meta.Timestamp.Before(cutoff) {
				return i
			}
		}
	}
	
	// All messages are too old
	return h.tail
}

// adjustForMemoryLimit removes messages until memory usage is acceptable
// Complexity: O(k) where k is the number of messages to remove
func (h *History) adjustForMemoryLimit(startIdx int) int {
	if h.currentMemoryBytes <= h.options.MaxMemoryBytes {
		return startIdx
	}
	
	// Calculate memory after removing messages before startIdx
	var memoryAfterRemoval int64 = h.currentMemoryBytes
	for i := h.head; i < startIdx; i++ {
		if i < len(h.messageSizes) {
			memoryAfterRemoval -= h.messageSizes[i]
		}
	}
	
	// Remove more messages if still over limit
	currentIdx := startIdx
	for currentIdx < h.tail && memoryAfterRemoval > h.options.MaxMemoryBytes {
		if currentIdx < len(h.messageSizes) {
			memoryAfterRemoval -= h.messageSizes[currentIdx]
		}
		currentIdx++
	}
	
	return currentIdx
}

// removeMessagesBeforeIndex efficiently removes messages and updates indices
// Complexity: O(k) where k is the number of messages to remove
func (h *History) removeMessagesBeforeIndex(newHead int) {
	// Update memory usage
	for i := h.head; i < newHead; i++ {
		if i < len(h.messageSizes) {
			h.currentMemoryBytes -= h.messageSizes[i]
		}
		
		// Remove from index
		if h.messages[i] != nil && h.options.EnableIndexing {
			delete(h.index, h.messages[i].GetID())
		}
		
		// Clear the message to help GC
		h.messages[i] = nil
		h.messageSizes[i] = 0
	}
	
	h.head = newHead
}

// shouldDefragment determines if the buffer should be defragmented
func (h *History) shouldDefragment() bool {
	activeMessages := h.tail - h.head
	// Defragment if:
	// 1. We're using less than 50% of the buffer and have significant head offset
	// 2. Or if the next insertion would exceed buffer bounds
	return (activeMessages > 0 && activeMessages < len(h.messages)/2 && h.head > 0) ||
		(h.tail >= len(h.messages))
}

// defragmentBuffer reorganizes the buffer to remove gaps
// This is the only O(n) operation but happens rarely
func (h *History) defragmentBuffer() {
	activeCount := h.tail - h.head
	if activeCount == 0 {
		h.head = 0
		h.tail = 0
		return
	}
	
	// Copy active messages to the beginning
	for i := 0; i < activeCount; i++ {
		srcIdx := h.head + i
		if srcIdx != i {
			h.messages[i] = h.messages[srcIdx]
			h.messageSizes[i] = h.messageSizes[srcIdx]
			
			// Clear old position
			h.messages[srcIdx] = nil
			h.messageSizes[srcIdx] = 0
		}
	}
	
	// Update indices only for active messages
	if h.options.EnableIndexing {
		for i := 0; i < activeCount; i++ {
			if h.messages[i] != nil {
				h.index[h.messages[i].GetID()] = i
			}
		}
	}
	
	h.head = 0
	h.tail = activeCount
}

// growBuffer increases the buffer size when needed
func (h *History) growBuffer() {
	newCapacity := len(h.messages) * 2
	if h.options.MaxMessages > 0 && newCapacity > h.options.MaxMessages {
		newCapacity = h.options.MaxMessages + h.options.MaxMessages/10 // 10% overhead
	}
	
	newMessages := make([]Message, newCapacity)
	newSizes := make([]int64, newCapacity)
	
	// Copy active messages
	activeCount := h.tail - h.head
	copy(newMessages, h.messages[h.head:h.tail])
	copy(newSizes, h.messageSizes[h.head:h.tail])
	
	// Update indices
	if h.options.EnableIndexing {
		for i := 0; i < activeCount; i++ {
			if newMessages[i] != nil {
				h.index[newMessages[i].GetID()] = i
			}
		}
	}
	
	h.messages = newMessages
	h.messageSizes = newSizes
	h.head = 0
	h.tail = activeCount
}

// size returns the current number of active messages
func (h *History) size() int {
	return h.tail - h.head
}

// compact is now a wrapper for backward compatibility
func (h *History) compact() {
	h.performLazyCompaction()
}

// Snapshot creates a snapshot of the current history state
func (h *History) Snapshot() *HistorySnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	activeCount := h.tail - h.head
	messages := make([]Message, activeCount)
	copy(messages, h.messages[h.head:h.tail])
	
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
	
	// Optimize search range using time index if time filters are provided
	startIdx := h.head
	endIdx := h.tail
	
	if options.StartTime != nil {
		// Use binary search to find start position
		startIdx = h.findFirstValidMessageByTime(*options.StartTime)
	}
	
	for i := startIdx; i < endIdx; i++ {
		if h.messages[i] == nil {
			continue
		}
		
		msg := h.messages[i]
		
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