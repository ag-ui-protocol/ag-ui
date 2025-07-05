package messages

import (
	"sync"
	"testing"
	"time"
)

func TestHistory(t *testing.T) {
	t.Run("Add and retrieve messages", func(t *testing.T) {
		h := NewHistory()

		msg1 := NewUserMessage("First message")
		msg2 := NewAssistantMessage("Second message")

		// Add messages
		if err := h.Add(msg1); err != nil {
			t.Errorf("Failed to add first message: %v", err)
		}
		if err := h.Add(msg2); err != nil {
			t.Errorf("Failed to add second message: %v", err)
		}

		// Check size
		if size := h.Size(); size != 2 {
			t.Errorf("Expected size 2, got %d", size)
		}

		// Retrieve by ID
		retrieved, err := h.Get(msg1.GetID())
		if err != nil {
			t.Errorf("Failed to get message: %v", err)
		}
		if retrieved.GetID() != msg1.GetID() {
			t.Error("Retrieved wrong message")
		}

		// Get all messages
		all := h.GetAll()
		if len(all) != 2 {
			t.Errorf("Expected 2 messages, got %d", len(all))
		}
	})

	t.Run("Prevent duplicate messages", func(t *testing.T) {
		h := NewHistory()

		msg := NewUserMessage("Test message")
		if err := h.Add(msg); err != nil {
			t.Errorf("Failed to add message: %v", err)
		}

		// Try to add same message again
		if err := h.Add(msg); err == nil {
			t.Error("Expected error when adding duplicate message")
		}
	})

	t.Run("Add batch of messages", func(t *testing.T) {
		h := NewHistory()

		messages := []Message{
			NewSystemMessage("System prompt"),
			NewUserMessage("User message"),
			NewAssistantMessage("Assistant response"),
		}

		if err := h.AddBatch(messages); err != nil {
			t.Errorf("Failed to add batch: %v", err)
		}

		if size := h.Size(); size != 3 {
			t.Errorf("Expected size 3, got %d", size)
		}
	})

	t.Run("Get messages by range", func(t *testing.T) {
		h := NewHistory()

		// Add 5 messages
		for i := 0; i < 5; i++ {
			msg := NewUserMessage("Message " + string(rune('A'+i)))
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Get range [1, 4)
		rangeMessages, err := h.GetRange(1, 4)
		if err != nil {
			t.Errorf("Failed to get range: %v", err)
		}

		if len(rangeMessages) != 3 {
			t.Errorf("Expected 3 messages in range, got %d", len(rangeMessages))
		}

		// Verify correct messages
		if content := rangeMessages[0].GetContent(); content == nil || *content != "Message B" {
			t.Errorf("Expected 'Message B', got %v", content)
		}
	})

	t.Run("Get last N messages", func(t *testing.T) {
		h := NewHistory()

		// Add 5 messages
		for i := 0; i < 5; i++ {
			msg := NewUserMessage("Message " + string(rune('A'+i)))
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		last2 := h.GetLast(2)
		if len(last2) != 2 {
			t.Errorf("Expected 2 messages, got %d", len(last2))
		}

		// Verify we got the last messages
		if content := last2[1].GetContent(); content == nil || *content != "Message E" {
			t.Errorf("Expected 'Message E', got %v", content)
		}

		// Test edge cases
		last10 := h.GetLast(10)
		if len(last10) != 5 {
			t.Errorf("Expected 5 messages (all), got %d", len(last10))
		}

		last0 := h.GetLast(0)
		if len(last0) != 0 {
			t.Errorf("Expected 0 messages, got %d", len(last0))
		}
	})

	t.Run("Get messages by role", func(t *testing.T) {
		h := NewHistory()

		messages := []Message{
			NewSystemMessage("System"),
			NewUserMessage("User 1"),
			NewAssistantMessage("Assistant 1"),
			NewUserMessage("User 2"),
			NewAssistantMessage("Assistant 2"),
		}

		for _, msg := range messages {
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		userMessages := h.GetByRole(RoleUser)
		if len(userMessages) != 2 {
			t.Errorf("Expected 2 user messages, got %d", len(userMessages))
		}

		assistantMessages := h.GetByRole(RoleAssistant)
		if len(assistantMessages) != 2 {
			t.Errorf("Expected 2 assistant messages, got %d", len(assistantMessages))
		}

		systemMessages := h.GetByRole(RoleSystem)
		if len(systemMessages) != 1 {
			t.Errorf("Expected 1 system message, got %d", len(systemMessages))
		}
	})

	t.Run("Get messages after timestamp", func(t *testing.T) {
		h := NewHistory()

		// Add first message
		msg1 := NewUserMessage("Old message")
		if err := h.Add(msg1); err != nil {
			t.Fatalf("Failed to add message: %v", err)
		}

		// Wait a bit
		time.Sleep(10 * time.Millisecond)
		cutoff := time.Now()
		time.Sleep(10 * time.Millisecond)

		// Add newer messages
		msg2 := NewUserMessage("New message 1")
		msg3 := NewAssistantMessage("New message 2")
		if err := h.Add(msg2); err != nil {
			t.Fatalf("Failed to add message: %v", err)
		}
		if err := h.Add(msg3); err != nil {
			t.Fatalf("Failed to add message: %v", err)
		}

		// Get messages after cutoff
		recent := h.GetAfter(cutoff)
		if len(recent) != 2 {
			t.Errorf("Expected 2 recent messages, got %d", len(recent))
		}
	})

	t.Run("History compaction", func(t *testing.T) {
		h := NewHistory(HistoryOptions{
			MaxMessages:      5,
			CompactThreshold: 5,
		})

		// Add more than MaxMessages
		for i := 0; i < 8; i++ {
			msg := NewUserMessage("Message " + string(rune('0'+i)))
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Should have been compacted to MaxMessages
		if size := h.Size(); size != 5 {
			t.Errorf("Expected size 5 after compaction, got %d", size)
		}

		// Check that oldest messages were removed
		all := h.GetAll()
		if content := all[0].GetContent(); content == nil || *content != "Message 3" {
			t.Errorf("Expected oldest message to be 'Message 3', got %v", content)
		}

		// Check compaction count (may be multiple due to threshold being met multiple times)
		if count := h.CompactionCount(); count < 1 {
			t.Errorf("Expected at least 1 compaction, got %d", count)
		}
	})

	t.Run("History with age limit", func(t *testing.T) {
		h := NewHistory(HistoryOptions{
			MaxAge:           100 * time.Millisecond,
			CompactThreshold: 3,
		})

		// Add old message
		oldMsg := NewUserMessage("Old message")
		if err := h.Add(oldMsg); err != nil {
			t.Fatalf("Failed to add message: %v", err)
		}

		// Wait for message to age
		time.Sleep(150 * time.Millisecond)

		// Add new messages to trigger compaction
		for i := 0; i < 3; i++ {
			msg := NewUserMessage("New message " + string(rune('0'+i)))
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Old message should have been removed
		if size := h.Size(); size != 3 {
			t.Errorf("Expected size 3 after age-based compaction, got %d", size)
		}

		// Verify old message is gone
		_, err := h.Get(oldMsg.GetID())
		if err == nil {
			t.Error("Expected error when getting aged-out message")
		}
	})

	t.Run("Clear history", func(t *testing.T) {
		h := NewHistory()

		// Add messages
		for i := 0; i < 3; i++ {
			msg := NewUserMessage("Message " + string(rune('0'+i)))
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Clear
		h.Clear()

		if size := h.Size(); size != 0 {
			t.Errorf("Expected size 0 after clear, got %d", size)
		}

		// Total messages should still reflect historical count
		if total := h.TotalMessages(); total != 3 {
			t.Errorf("Expected total messages 3, got %d", total)
		}
	})

	t.Run("History snapshot", func(t *testing.T) {
		h := NewHistory()

		// Add messages
		messages := []Message{
			NewUserMessage("Message 1"),
			NewAssistantMessage("Message 2"),
		}

		for _, msg := range messages {
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Create snapshot
		snapshot := h.Snapshot()

		if len(snapshot.Messages) != 2 {
			t.Errorf("Expected 2 messages in snapshot, got %d", len(snapshot.Messages))
		}

		if snapshot.TotalMessages != 2 {
			t.Errorf("Expected total messages 2, got %d", snapshot.TotalMessages)
		}

		// Test JSON serialization
		data, err := snapshot.ToJSON()
		if err != nil {
			t.Errorf("Failed to serialize snapshot: %v", err)
		}

		if len(data) == 0 {
			t.Error("Expected non-empty JSON data")
		}
	})

	t.Run("Search messages", func(t *testing.T) {
		h := NewHistory()

		// Add various messages
		messages := []Message{
			NewSystemMessage("You are a weather assistant."),
			NewUserMessage("What's the weather in NYC?"),
			NewAssistantMessage("The weather in NYC is sunny and 72°F."),
			NewUserMessage("How about San Francisco?"),
			NewAssistantMessage("San Francisco has foggy weather at 65°F."),
		}

		for _, msg := range messages {
			if err := h.Add(msg); err != nil {
				t.Fatalf("Failed to add message: %v", err)
			}
		}

		// Search for "weather"
		results := h.Search(SearchOptions{
			Query: "weather",
		})

		if len(results) != 4 {
			t.Errorf("Expected 4 messages containing 'weather', got %d", len(results))
		}

		// Search by role
		userResults := h.Search(SearchOptions{
			Role: RoleUser,
		})

		if len(userResults) != 2 {
			t.Errorf("Expected 2 user messages, got %d", len(userResults))
		}

		// Search with query and role
		weatherUserResults := h.Search(SearchOptions{
			Query: "weather",
			Role:  RoleUser,
		})

		if len(weatherUserResults) != 1 {
			t.Errorf("Expected 1 user message about weather, got %d", len(weatherUserResults))
		}

		// Search with max results
		limitedResults := h.Search(SearchOptions{
			Query:      "weather",
			MaxResults: 2,
		})

		if len(limitedResults) != 2 {
			t.Errorf("Expected 2 results with limit, got %d", len(limitedResults))
		}
	})

	t.Run("Thread safety", func(t *testing.T) {
		h := NewHistory()
		var wg sync.WaitGroup

		// Concurrent writes
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				msg := NewUserMessage("Concurrent message " + string(rune('0'+idx)))
				if err := h.Add(msg); err != nil {
					t.Errorf("Failed to add message: %v", err)
				}
			}(i)
		}

		// Concurrent reads
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_ = h.GetAll()
				_ = h.Size()
				_ = h.GetLast(5)
			}()
		}

		wg.Wait()

		// Verify all messages were added
		if size := h.Size(); size != 10 {
			t.Errorf("Expected 10 messages after concurrent operations, got %d", size)
		}
	})
}

func TestThreadedHistory(t *testing.T) {
	t.Run("Create and manage threads", func(t *testing.T) {
		th := NewThreadedHistory()

		// Get/create thread 1
		thread1 := th.GetThread("thread1")
		_ = thread1.Add(NewUserMessage("Thread 1 message")) // Ignore error in test

		// Get/create thread 2
		thread2 := th.GetThread("thread2")
		_ = thread2.Add(NewUserMessage("Thread 2 message")) // Ignore error in test

		// Verify threads are separate
		if thread1.Size() != 1 {
			t.Errorf("Expected thread1 size 1, got %d", thread1.Size())
		}
		if thread2.Size() != 1 {
			t.Errorf("Expected thread2 size 1, got %d", thread2.Size())
		}

		// Get existing thread
		thread1Again := th.GetThread("thread1")
		if thread1Again.Size() != 1 {
			t.Error("Expected to get same thread instance")
		}

		// List threads
		threads := th.ListThreads()
		if len(threads) != 2 {
			t.Errorf("Expected 2 threads, got %d", len(threads))
		}

		// Delete thread
		th.DeleteThread("thread1")
		threads = th.ListThreads()
		if len(threads) != 1 {
			t.Errorf("Expected 1 thread after deletion, got %d", len(threads))
		}
	})

	t.Run("Thread options inheritance", func(t *testing.T) {
		opts := HistoryOptions{
			MaxMessages: 10,
			MaxAge:      1 * time.Hour,
		}
		th := NewThreadedHistory(opts)

		thread := th.GetThread("test")

		// Add messages up to limit
		for i := 0; i < 15; i++ {
			_ = thread.Add(NewUserMessage("Message " + string(rune('0'+i)))) // Ignore error in test
		}

		// Should be limited by options
		if thread.Size() != 10 {
			t.Errorf("Expected thread size 10 (from options), got %d", thread.Size())
		}
	})
}
