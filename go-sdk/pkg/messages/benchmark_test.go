package messages

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

)

// Benchmark constants
const (
	smallMessageSize  = 100       // 100 bytes
	mediumMessageSize = 10000     // 10KB
	largeMessageSize  = 1000000   // 1MB
	
	smallConvSize   = 10
	mediumConvSize  = 100
	largeConvSize   = 1000
	xlargeConvSize  = 10000
)

// Helper functions to generate test data
func generateContent(size int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .\n"
	b := make([]byte, size)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

func generateToolCall(index int) ToolCall {
	return ToolCall{
		ID:   fmt.Sprintf("call_%d", index),
		Type: "function",
		Function: Function{
			Name:      fmt.Sprintf("function_%d", index),
			Arguments: `{"arg1": "value1", "arg2": 42}`,
		},
	}
}

func generateMessages(count int, contentSize int) MessageList {
	messages := make(MessageList, 0, count)
	
	for i := 0; i < count; i++ {
		switch i % 5 {
		case 0:
			messages = append(messages, NewUserMessage(generateContent(contentSize)))
		case 1:
			messages = append(messages, NewAssistantMessage(generateContent(contentSize)))
		case 2:
			messages = append(messages, NewSystemMessage(generateContent(contentSize)))
		case 3:
			// Assistant with tool calls
			toolCalls := []ToolCall{generateToolCall(i), generateToolCall(i+1)}
			msg := NewAssistantMessageWithTools(toolCalls)
			content := generateContent(contentSize)
			msg.Content = &content
			messages = append(messages, msg)
		case 4:
			messages = append(messages, NewToolMessage(generateContent(contentSize), fmt.Sprintf("call_%d", i-1)))
		}
	}
	
	return messages
}

// Benchmark: Message Creation
func BenchmarkMessageCreation(b *testing.B) {
	sizes := []struct {
		name string
		size int
	}{
		{"Small", smallMessageSize},
		{"Medium", mediumMessageSize},
		{"Large", largeMessageSize},
	}
	
	for _, size := range sizes {
		b.Run(size.name, func(b *testing.B) {
			content := generateContent(size.size)
			
			b.Run("UserMessage", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewUserMessage(content)
				}
			})
			
			b.Run("AssistantMessage", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewAssistantMessage(content)
				}
			})
			
			b.Run("AssistantMessageWithTools", func(b *testing.B) {
				toolCalls := []ToolCall{generateToolCall(1), generateToolCall(2)}
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewAssistantMessageWithTools(toolCalls)
				}
			})
			
			b.Run("SystemMessage", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewSystemMessage(content)
				}
			})
			
			b.Run("ToolMessage", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewToolMessage(content, "call_123")
				}
			})
			
			b.Run("DeveloperMessage", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = NewDeveloperMessage(content)
				}
			})
		})
	}
}

// Benchmark: Validation Operations
func BenchmarkValidation(b *testing.B) {
	validator := NewValidator(DefaultValidationOptions())
	sanitizer := NewSanitizer(DefaultSanitizationOptions())
	
	sizes := []struct {
		name string
		size int
	}{
		{"Small", smallMessageSize},
		{"Medium", mediumMessageSize},
		{"Large", largeMessageSize},
	}
	
	for _, size := range sizes {
		messages := generateMessages(10, size.size)
		
		b.Run(fmt.Sprintf("Validate_%s", size.name), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for _, msg := range messages {
					_ = validator.ValidateMessage(msg)
				}
			}
		})
		
		b.Run(fmt.Sprintf("Sanitize_%s", size.name), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for _, msg := range messages {
					_ = sanitizer.SanitizeMessage(msg)
				}
			}
		})
		
		b.Run(fmt.Sprintf("ValidateAndSanitize_%s", size.name), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for _, msg := range messages {
					_ = ValidateAndSanitize(msg, DefaultValidationOptions(), DefaultSanitizationOptions())
				}
			}
		})
	}
	
	// Benchmark validation of message lists
	b.Run("ValidateMessageList", func(b *testing.B) {
		lists := []struct {
			name string
			size int
		}{
			{"Small", smallConvSize},
			{"Medium", mediumConvSize},
			{"Large", largeConvSize},
		}
		
		for _, list := range lists {
			messages := generateMessages(list.size, mediumMessageSize)
			b.Run(list.name, func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = validator.ValidateMessageList(messages)
				}
			})
		}
	})
}

// Benchmark: Serialization/Deserialization
func BenchmarkSerialization(b *testing.B) {
	sizes := []struct {
		name string
		size int
	}{
		{"Small", smallMessageSize},
		{"Medium", mediumMessageSize},
		{"Large", largeMessageSize},
	}
	
	for _, size := range sizes {
		msg := NewAssistantMessage(generateContent(size.size))
		
		b.Run(fmt.Sprintf("ToJSON_%s", size.name), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = msg.ToJSON()
			}
		})
		
		jsonData, _ := msg.ToJSON()
		
		b.Run(fmt.Sprintf("FromJSON_%s", size.name), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				var decoded AssistantMessage
				_ = json.Unmarshal(jsonData, &decoded)
			}
		})
	}
	
	// Benchmark message list serialization
	b.Run("MessageList", func(b *testing.B) {
		lists := []struct {
			name string
			size int
		}{
			{"Small", smallConvSize},
			{"Medium", mediumConvSize},
			{"Large", largeConvSize},
		}
		
		for _, list := range lists {
			messages := generateMessages(list.size, mediumMessageSize)
			
			b.Run(fmt.Sprintf("ToJSON_%s", list.name), func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_, _ = messages.ToJSON()
				}
			})
		}
	})
}

// Benchmark: Provider Conversions
// NOTE: Provider conversion benchmarks are in the providers package to avoid import cycles
// See: pkg/messages/providers/benchmark_test.go for provider-specific benchmarks

// Benchmark: History Operations
func BenchmarkHistory(b *testing.B) {
	b.Run("Add", func(b *testing.B) {
		sizes := []struct {
			name        string
			historySize int
			msgSize     int
		}{
			{"Small_SmallMsg", 100, smallMessageSize},
			{"Medium_MediumMsg", 1000, mediumMessageSize},
			{"Large_LargeMsg", 10000, largeMessageSize},
		}
		
		for _, size := range sizes {
			b.Run(size.name, func(b *testing.B) {
				history := NewHistory(HistoryOptions{
					MaxMessages:    size.historySize * 2,
					EnableIndexing: true,
				})
				
				// Pre-populate history
				for i := 0; i < size.historySize; i++ {
					msg := NewUserMessage(generateContent(size.msgSize))
					_ = history.Add(msg)
				}
				
				b.ResetTimer()
				b.ReportAllocs()
				
				for i := 0; i < b.N; i++ {
					msg := NewUserMessage(generateContent(size.msgSize))
					_ = history.Add(msg)
				}
			})
		}
	})
	
	b.Run("AddBatch", func(b *testing.B) {
		batchSizes := []int{10, 100, 1000}
		
		for _, batchSize := range batchSizes {
			b.Run(fmt.Sprintf("Batch_%d", batchSize), func(b *testing.B) {
				history := NewHistory()
				messages := generateMessages(batchSize, mediumMessageSize)
				
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = history.AddBatch(messages)
					history.Clear() // Reset for next iteration
				}
			})
		}
	})
	
	b.Run("Search", func(b *testing.B) {
		historySizes := []int{100, 1000, 10000}
		
		for _, histSize := range historySizes {
			history := NewHistory(HistoryOptions{EnableIndexing: true})
			
			// Populate history
			for i := 0; i < histSize; i++ {
				msg := NewUserMessage(fmt.Sprintf("Message %d with searchable content", i))
				_ = history.Add(msg)
			}
			
			b.Run(fmt.Sprintf("History_%d", histSize), func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_ = history.Search(SearchOptions{
						Query:      "searchable",
						MaxResults: 10,
					})
				}
			})
		}
	})
	
	b.Run("GetByRole", func(b *testing.B) {
		history := NewHistory()
		messages := generateMessages(1000, mediumMessageSize)
		_ = history.AddBatch(messages)
		
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = history.GetByRole(RoleUser)
		}
	})
	
	b.Run("Compaction", func(b *testing.B) {
		history := NewHistory(HistoryOptions{
			MaxMessages:      1000,
			CompactThreshold: 500,
			EnableIndexing:   true,
		})
		
		// Pre-populate to trigger compaction
		for i := 0; i < 2000; i++ {
			msg := NewUserMessage(generateContent(mediumMessageSize))
			_ = history.Add(msg)
		}
		
		b.ResetTimer()
		b.ReportAllocs()
		
		for i := 0; i < b.N; i++ {
			// Force compaction by adding messages beyond threshold
			for j := 0; j < 100; j++ {
				msg := NewUserMessage(generateContent(mediumMessageSize))
				_ = history.Add(msg)
			}
		}
	})
}

// Benchmark: Streaming Operations
func BenchmarkStreaming(b *testing.B) {
	b.Run("StreamBuilder", func(b *testing.B) {
		b.Run("AddContent", func(b *testing.B) {
			builder, _ := NewStreamBuilder(RoleAssistant)
			content := generateContent(100)
			
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_ = builder.AddContent(content)
			}
		})
		
		b.Run("AddToolCall", func(b *testing.B) {
			builder, _ := NewStreamBuilder(RoleAssistant)
			toolCall := generateToolCall(1)
			
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_ = builder.AddToolCall(i%10, toolCall)
			}
		})
		
		b.Run("Complete", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				builder, _ := NewStreamBuilder(RoleAssistant)
				_ = builder.AddContent(generateContent(mediumMessageSize))
				b.StartTimer()
				
				_, _ = builder.Complete()
			}
		})
	})
	
	b.Run("StreamProcessor", func(b *testing.B) {
		// Create a mock stream
		stream := &mockMessageStream{
			events: generateStreamEvents(100),
		}
		
		processor := NewStreamProcessor().
			OnDelta(func(msg Message, delta *Delta) error {
				return nil
			}).
			OnComplete(func(msg Message) error {
				return nil
			})
		
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			b.StopTimer()
			stream.reset()
			b.StartTimer()
			
			_ = processor.Process(context.Background(), stream)
		}
	})
}

// Benchmark: Memory Usage for Large Conversations
func BenchmarkMemoryUsage(b *testing.B) {
	b.Run("LargeConversation", func(b *testing.B) {
		convSizes := []struct {
			name string
			size int
		}{
			{"1K_Messages", 1000},
			{"10K_Messages", 10000},
		}
		
		for _, convSize := range convSizes {
			b.Run(convSize.name, func(b *testing.B) {
				b.ReportAllocs()
				
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				startMem := m.Alloc
				
				conversation := NewConversation(ConversationOptions{
					MaxMessages: convSize.size * 2,
				})
				
				for i := 0; i < convSize.size; i++ {
					msg := NewUserMessage(generateContent(mediumMessageSize))
					_ = conversation.AddMessage(msg)
				}
				
				runtime.ReadMemStats(&m)
				endMem := m.Alloc
				
				b.ReportMetric(float64(endMem-startMem)/1024/1024, "MB")
			})
		}
	})
	
	b.Run("HistoryMemoryLimit", func(b *testing.B) {
		history := NewHistory(HistoryOptions{
			MaxMemoryBytes: 10 * 1024 * 1024, // 10MB limit
			EnableIndexing: true,
		})
		
		messageCount := 0
		totalSize := int64(0)
		
		b.ReportAllocs()
		
		// Keep adding messages until we hit the memory limit
		for totalSize < 10*1024*1024 {
			msg := NewUserMessage(generateContent(mediumMessageSize))
			if err := history.Add(msg); err != nil {
				break
			}
			messageCount++
			totalSize = history.CurrentMemoryBytes()
		}
		
		b.ReportMetric(float64(messageCount), "messages")
		b.ReportMetric(float64(totalSize)/1024/1024, "MB")
	})
}

// Benchmark: Concurrent Operations
func BenchmarkConcurrent(b *testing.B) {
	b.Run("History", func(b *testing.B) {
		history := NewHistory(HistoryOptions{
			MaxMessages:    10000,
			EnableIndexing: true,
		})
		
		// Pre-populate
		for i := 0; i < 1000; i++ {
			msg := NewUserMessage(generateContent(mediumMessageSize))
			_ = history.Add(msg)
		}
		
		b.Run("ConcurrentReads", func(b *testing.B) {
			b.ReportAllocs()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					_ = history.GetLast(10)
					_ = history.Size()
					_ = history.GetByRole(RoleUser)
				}
			})
		})
		
		b.Run("ConcurrentWrites", func(b *testing.B) {
			b.ReportAllocs()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					msg := NewUserMessage(generateContent(smallMessageSize))
					_ = history.Add(msg)
				}
			})
		})
		
		b.Run("MixedReadWrite", func(b *testing.B) {
			b.ReportAllocs()
			
			var wg sync.WaitGroup
			
			// Start readers
			for i := 0; i < 4; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for j := 0; j < b.N/4; j++ {
						_ = history.GetLast(10)
						_ = history.Search(SearchOptions{Query: "content"})
					}
				}()
			}
			
			// Start writers
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for j := 0; j < b.N/2; j++ {
						msg := NewUserMessage(generateContent(smallMessageSize))
						_ = history.Add(msg)
					}
				}()
			}
			
			wg.Wait()
		})
	})
	
	b.Run("ThreadedHistory", func(b *testing.B) {
		threadedHistory := NewThreadedHistory()
		
		b.ReportAllocs()
		b.RunParallel(func(pb *testing.PB) {
			threadID := fmt.Sprintf("thread_%d", rand.Intn(10))
			for pb.Next() {
				thread := threadedHistory.GetThread(threadID)
				msg := NewUserMessage(generateContent(smallMessageSize))
				_ = thread.Add(msg)
			}
		})
	})
	
	b.Run("Validation", func(b *testing.B) {
		validator := NewValidator(DefaultValidationOptions())
		messages := generateMessages(100, mediumMessageSize)
		
		b.ReportAllocs()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				idx := rand.Intn(len(messages))
				_ = validator.ValidateMessage(messages[idx])
			}
		})
	})
}

// Benchmark: Visitor Pattern Performance
func BenchmarkVisitorPattern(b *testing.B) {
	messages := generateMessages(1000, mediumMessageSize)
	
	visitor := &benchmarkVisitor{
		userCount:      0,
		assistantCount: 0,
		systemCount:    0,
		toolCount:      0,
		developerCount: 0,
	}
	
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		visitor.reset()
		for _, msg := range messages {
			if visitable, ok := msg.(Visitable); ok {
				_ = visitable.Accept(visitor)
			}
		}
	}
}

// Helper types for benchmarks

type mockMessageStream struct {
	events []*StreamEvent
	index  int
	mu     sync.Mutex
}

func (m *mockMessageStream) Next(ctx context.Context) (*StreamEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	if m.index >= len(m.events) {
		return nil, nil
	}
	
	event := m.events[m.index]
	m.index++
	return event, nil
}

func (m *mockMessageStream) Close() error {
	return nil
}

func (m *mockMessageStream) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.index = 0
}

func generateStreamEvents(count int) []*StreamEvent {
	events := make([]*StreamEvent, 0, count*3) // start, deltas, complete
	
	msg := NewAssistantMessage("")
	events = append(events, &StreamEvent{
		Type:      StreamEventStart,
		Message:   msg,
		Timestamp: time.Now(),
	})
	
	// Generate content deltas
	content := generateContent(mediumMessageSize)
	chunkSize := len(content) / count
	
	for i := 0; i < count; i++ {
		start := i * chunkSize
		end := start + chunkSize
		if end > len(content) {
			end = len(content)
		}
		
		delta := content[start:end]
		events = append(events, &StreamEvent{
			Type:    StreamEventDelta,
			Message: msg,
			Delta: &Delta{
				Content: &delta,
			},
			Timestamp: time.Now(),
		})
	}
	
	events = append(events, &StreamEvent{
		Type:      StreamEventComplete,
		Message:   msg,
		Timestamp: time.Now(),
	})
	
	return events
}

type benchmarkVisitor struct {
	userCount      int
	assistantCount int
	systemCount    int
	toolCount      int
	developerCount int
}

func (v *benchmarkVisitor) reset() {
	v.userCount = 0
	v.assistantCount = 0
	v.systemCount = 0
	v.toolCount = 0
	v.developerCount = 0
}

func (v *benchmarkVisitor) VisitUser(msg *UserMessage) error {
	v.userCount++
	return nil
}

func (v *benchmarkVisitor) VisitAssistant(msg *AssistantMessage) error {
	v.assistantCount++
	return nil
}

func (v *benchmarkVisitor) VisitSystem(msg *SystemMessage) error {
	v.systemCount++
	return nil
}

func (v *benchmarkVisitor) VisitTool(msg *ToolMessage) error {
	v.toolCount++
	return nil
}

func (v *benchmarkVisitor) VisitDeveloper(msg *DeveloperMessage) error {
	v.developerCount++
	return nil
}

// Benchmark: Comparative operations (before/after optimizations)
func BenchmarkOptimizations(b *testing.B) {
	// These benchmarks compare different implementation approaches
	
	b.Run("StringConcatenation", func(b *testing.B) {
		parts := make([]string, 100)
		for i := range parts {
			parts[i] = generateContent(100)
		}
		
		b.Run("PlusOperator", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				result := ""
				for _, part := range parts {
					result += part
				}
				_ = result
			}
		})
		
		b.Run("StringBuilder", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				var builder strings.Builder
				for _, part := range parts {
					builder.WriteString(part)
				}
				_ = builder.String()
			}
		})
		
		b.Run("StringsJoin", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_ = strings.Join(parts, "")
			}
		})
	})
	
	b.Run("MessageStorage", func(b *testing.B) {
		messages := generateMessages(1000, mediumMessageSize)
		
		b.Run("SliceAppend", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				list := make([]Message, 0)
				for _, msg := range messages {
					list = append(list, msg)
				}
			}
		})
		
		b.Run("PreallocatedSlice", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				list := make([]Message, 0, len(messages))
				for _, msg := range messages {
					list = append(list, msg)
				}
			}
		})
	})
	
	b.Run("Validation", func(b *testing.B) {
		content := generateContent(largeMessageSize)
		
		b.Run("RegexValidation", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				// Simulate regex-based validation
				_ = scriptPattern.MatchString(content)
				_ = htmlPattern.MatchString(content)
			}
		})
		
		b.Run("ByteValidation", func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				// Simulate byte-level validation
				bytes := []byte(content)
				_ = len(bytes)
			}
		})
	})
}