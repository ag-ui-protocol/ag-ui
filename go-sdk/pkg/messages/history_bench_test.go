package messages

import (
	"testing"
	"time"
)

// BenchmarkHistoryAdd benchmarks adding messages to history
func BenchmarkHistoryAdd(b *testing.B) {
	h := NewHistory(HistoryOptions{
		MaxMessages:      10000,
		CompactThreshold: 5000,
		MaxAge:           24 * time.Hour,
	})

	// Pre-populate with some messages
	for i := 0; i < 1000; i++ {
		msg := NewUserMessage("Initial message")
		h.Add(msg)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		msg := NewUserMessage("Benchmark message")
		h.Add(msg)
	}
}

// BenchmarkHistoryCompaction benchmarks the compaction process
func BenchmarkHistoryCompaction(b *testing.B) {
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		h := NewHistory(HistoryOptions{
			MaxMessages:      1000,
			CompactThreshold: 1000,
			MaxAge:           1 * time.Hour,
		})

		// Fill to capacity
		for j := 0; j < 1000; j++ {
			msg := NewUserMessage("Message")
			h.Add(msg)
		}

		b.StartTimer()
		// This should trigger compaction
		msg := NewUserMessage("Trigger compaction")
		h.Add(msg)
	}
}

// BenchmarkHistoryWithHighThroughput simulates high message throughput
func BenchmarkHistoryWithHighThroughput(b *testing.B) {
	h := NewHistory(HistoryOptions{
		MaxMessages:      5000,
		CompactThreshold: 2500,
		MaxAge:           1 * time.Hour,
		MaxMemoryBytes:   50 * 1024 * 1024, // 50MB
	})

	messages := make([]Message, 100)
	for i := range messages {
		messages[i] = NewUserMessage("High throughput message with some content to make it realistic")
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Simulate batch operations
		h.AddBatch(messages[:10])
		
		// Simulate some reads
		h.GetLast(5)
		h.Size()
	}
}

// BenchmarkHistoryAgeBasedPruning benchmarks age-based pruning efficiency
func BenchmarkHistoryAgeBasedPruning(b *testing.B) {
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		h := NewHistory(HistoryOptions{
			MaxMessages:      10000,
			CompactThreshold: 5000,
			MaxAge:           100 * time.Millisecond,
		})

		// Add old messages
		for j := 0; j < 1000; j++ {
			msg := NewUserMessage("Old message")
			h.Add(msg)
		}

		// Wait for messages to age
		time.Sleep(150 * time.Millisecond)

		b.StartTimer()
		// Add new messages that should trigger age-based compaction
		for j := 0; j < 100; j++ {
			msg := NewUserMessage("New message")
			h.Add(msg)
		}
	}
}