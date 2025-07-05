package providers

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"testing"

	"github.com/ag-ui/go-sdk/pkg/messages"
)

const (
	smallConvSize  = 10
	mediumConvSize = 100
	largeConvSize  = 1000

	smallMessageSize  = 100     // 100 bytes
	mediumMessageSize = 10000   // 10KB
	largeMessageSize  = 1000000 // 1MB
)

// Helper to generate content
func generateContent(size int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .\n"
	b := make([]byte, size)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

// Helper to generate tool calls
func generateToolCall(index int) messages.ToolCall {
	return messages.ToolCall{
		ID:   fmt.Sprintf("call_%d", index),
		Type: "function",
		Function: messages.Function{
			Name:      fmt.Sprintf("function_%d", index),
			Arguments: `{"arg1": "value1", "arg2": 42}`,
		},
	}
}

// Helper to generate messages
func generateMessages(count int, contentSize int) messages.MessageList {
	msgs := make(messages.MessageList, 0, count)

	for i := 0; i < count; i++ {
		switch i % 5 {
		case 0:
			msgs = append(msgs, messages.NewUserMessage(generateContent(contentSize)))
		case 1:
			msgs = append(msgs, messages.NewAssistantMessage(generateContent(contentSize)))
		case 2:
			msgs = append(msgs, messages.NewSystemMessage(generateContent(contentSize)))
		case 3:
			// Assistant with tool calls
			toolCalls := []messages.ToolCall{generateToolCall(i), generateToolCall(i + 1)}
			msg := messages.NewAssistantMessageWithTools(toolCalls)
			content := generateContent(contentSize)
			msg.Content = &content
			msgs = append(msgs, msg)
		case 4:
			msgs = append(msgs, messages.NewToolMessage(generateContent(contentSize), fmt.Sprintf("call_%d", i-1)))
		}
	}

	return msgs
}

// Benchmark: Provider Conversions
func BenchmarkProviderConversions(b *testing.B) {
	openAIConverter := NewOpenAIConverter()
	anthropicConverter := NewAnthropicConverter()

	convSizes := []struct {
		name string
		size int
	}{
		{"Small", smallConvSize},
		{"Medium", mediumConvSize},
		{"Large", largeConvSize},
	}

	for _, convSize := range convSizes {
		msgs := generateMessages(convSize.size, mediumMessageSize)

		b.Run(fmt.Sprintf("OpenAI_%s", convSize.name), func(b *testing.B) {
			b.Run("ToProvider", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_, _ = openAIConverter.ToProviderFormat(msgs)
				}
			})

			// Convert once for the reverse benchmark
			providerFormat, _ := openAIConverter.ToProviderFormat(msgs)
			jsonData, _ := json.Marshal(providerFormat)

			b.Run("FromProvider", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_, _ = openAIConverter.FromProviderFormat(jsonData)
				}
			})
		})

		b.Run(fmt.Sprintf("Anthropic_%s", convSize.name), func(b *testing.B) {
			b.Run("ToProvider", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_, _ = anthropicConverter.ToProviderFormat(msgs)
				}
			})

			// Convert once for the reverse benchmark
			providerFormat, _ := anthropicConverter.ToProviderFormat(msgs)
			jsonData, _ := json.Marshal(providerFormat)

			b.Run("FromProvider", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					_, _ = anthropicConverter.FromProviderFormat(jsonData)
				}
			})
		})
	}
}

// Benchmark: Streaming State Management
func BenchmarkStreamingState(b *testing.B) {
	b.Run("OpenAI", func(b *testing.B) {
		converter := NewOpenAIConverter()

		b.Run("ProcessDelta", func(b *testing.B) {
			state := NewStreamingState()
			delta := OpenAIStreamDelta{
				Content: benchStringPtr("Hello "),
			}

			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = converter.ProcessDelta(state, delta)
			}
		})

		b.Run("ProcessDeltaWithTools", func(b *testing.B) {
			state := NewStreamingState()
			delta := OpenAIStreamDelta{
				ToolCalls: []OpenAIToolCallDelta{
					{
						Index: 0,
						ID:    benchStringPtr("call_123"),
						Type:  benchStringPtr("function"),
						Function: &OpenAIFunctionCallDelta{
							Name:      benchStringPtr("test_function"),
							Arguments: benchStringPtr(`{"arg": "value"}`),
						},
					},
				},
			}

			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = converter.ProcessDelta(state, delta)
			}
		})
	})

	// NOTE: Anthropic streaming is handled differently and doesn't have
	// direct ProcessDelta methods like OpenAI
}

// Benchmark: Message Validation in Converters
func BenchmarkConverterValidation(b *testing.B) {
	validationOpts := ConversionValidationOptions{
		AllowStandaloneToolMessages: false,
	}

	messageSets := []struct {
		name string
		msgs messages.MessageList
	}{
		{
			"Valid_Small",
			generateMessages(10, smallMessageSize),
		},
		{
			"Valid_Medium",
			generateMessages(100, mediumMessageSize),
		},
		{
			"Valid_Large",
			generateMessages(1000, largeMessageSize),
		},
	}

	for _, set := range messageSets {
		b.Run(set.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_ = ValidateMessages(set.msgs, validationOpts)
			}
		})
	}
}

// Benchmark: Registry Operations
func BenchmarkRegistry(b *testing.B) {
	// Create a new registry for benchmarking
	registry := NewRegistry()

	// Register some converters
	_ = registry.Register(NewOpenAIConverter())
	_ = registry.Register(NewAnthropicConverter())

	b.Run("Get", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, _ = registry.Get("openai")
		}
	})

	b.Run("ListProviders", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = registry.ListProviders()
		}
	})
}

// Benchmark: Base Converter Operations
func BenchmarkBaseConverter(b *testing.B) {
	conv := NewBaseConverter()
	msgs := generateMessages(100, mediumMessageSize)

	b.Run("PreprocessMessages", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = conv.PreprocessMessages(msgs)
		}
	})

	// Add more base converter benchmarks here if needed
}

// Helper function
func benchStringPtr(s string) *string {
	return &s
}
