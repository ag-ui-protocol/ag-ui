# Message Types Performance Benchmarks

This document describes the comprehensive performance benchmarks for the message types implementation.

## Running Benchmarks

### Run All Benchmarks
```bash
go test -run=^$ -bench=. -benchmem ./pkg/messages
go test -run=^$ -bench=. -benchmem ./pkg/messages/providers
```

### Run Specific Benchmark Categories

#### Message Creation
```bash
go test -run=^$ -bench=BenchmarkMessageCreation -benchmem ./pkg/messages
```

#### Validation Operations
```bash
go test -run=^$ -bench=BenchmarkValidation -benchmem ./pkg/messages
```

#### Serialization/Deserialization
```bash
go test -run=^$ -bench=BenchmarkSerialization -benchmem ./pkg/messages
```

#### Provider Conversions
```bash
go test -run=^$ -bench=BenchmarkProviderConversions -benchmem ./pkg/messages/providers
```

#### History Operations
```bash
go test -run=^$ -bench=BenchmarkHistory -benchmem ./pkg/messages
```

#### Streaming Operations
```bash
go test -run=^$ -bench=BenchmarkStreaming -benchmem ./pkg/messages
```

#### Memory Usage
```bash
go test -run=^$ -bench=BenchmarkMemoryUsage -benchmem ./pkg/messages
```

#### Concurrent Operations
```bash
go test -run=^$ -bench=BenchmarkConcurrent -benchmem ./pkg/messages
```

## Benchmark Categories

### 1. Message Creation Benchmarks
- Tests creation performance for all message types (User, Assistant, System, Tool, Developer)
- Measures with different content sizes (Small: 100B, Medium: 10KB, Large: 1MB)
- Reports allocations and memory usage

### 2. Validation Benchmarks
- **Individual Message Validation**: Tests validation speed for single messages
- **Sanitization**: Measures content sanitization performance
- **Combined Validation & Sanitization**: Tests the full validation pipeline
- **Message List Validation**: Tests validation of entire conversations

### 3. Serialization Benchmarks
- **To JSON**: Measures serialization performance
- **From JSON**: Measures deserialization performance
- Tests with different message and conversation sizes

### 4. Provider Conversion Benchmarks
- **OpenAI Format Conversion**: To/From OpenAI message format
- **Anthropic Format Conversion**: To/From Anthropic message format
- **Streaming State Management**: Tests streaming delta processing
- Tests with different conversation sizes (10, 100, 1000 messages)

### 5. History Operation Benchmarks
- **Add Operations**: Single message addition with indexing
- **Batch Add**: Adding multiple messages at once
- **Search**: Text search across message history
- **Get By Role**: Filtering messages by role
- **Compaction**: Memory management and cleanup operations

### 6. Streaming Benchmarks
- **Stream Builder**: Content and tool call delta processing
- **Stream Processor**: Event handling and callback performance
- **Buffered Streams**: Batch processing of stream events

### 7. Memory Usage Benchmarks
- **Large Conversations**: Memory consumption for 1K and 10K messages
- **History Memory Limits**: Testing memory-bounded history management
- Reports actual memory usage in MB

### 8. Concurrent Operation Benchmarks
- **Concurrent Reads**: Multiple goroutines reading from history
- **Concurrent Writes**: Multiple goroutines adding messages
- **Mixed Read/Write**: Realistic concurrent access patterns
- **Threaded History**: Multi-thread conversation management

### 9. Optimization Benchmarks
- **String Concatenation**: Compares + operator vs strings.Builder vs strings.Join
- **Message Storage**: Slice append vs pre-allocated slices
- **Validation Methods**: Regex vs byte-level validation

## Interpreting Results

### Key Metrics
- **ns/op**: Nanoseconds per operation (lower is better)
- **B/op**: Bytes allocated per operation (lower is better)
- **allocs/op**: Number of allocations per operation (lower is better)

### Performance Targets
- Message creation: < 500 ns/op
- Validation: < 5000 ns/op for medium messages
- Serialization: < 50000 ns/op for medium messages
- History add: < 2000 ns/op
- Concurrent operations should scale linearly with CPU cores

## Running with Different Parameters

### Adjust Benchmark Time
```bash
go test -run=^$ -bench=. -benchtime=10s ./pkg/messages
```

### Run with CPU Profiling
```bash
go test -run=^$ -bench=. -cpuprofile=cpu.prof ./pkg/messages
go tool pprof cpu.prof
```

### Run with Memory Profiling
```bash
go test -run=^$ -bench=. -memprofile=mem.prof ./pkg/messages
go tool pprof mem.prof
```

### Compare Results
```bash
# Run baseline
go test -run=^$ -bench=. -benchmem ./pkg/messages > baseline.txt

# Make changes, then run again
go test -run=^$ -bench=. -benchmem ./pkg/messages > new.txt

# Compare
benchcmp baseline.txt new.txt
```

## Benchmark Data Sizes

- **Small**: 100 bytes (typical chat message)
- **Medium**: 10KB (detailed response or code snippet)
- **Large**: 1MB (maximum supported message size)

- **Small Conversation**: 10 messages
- **Medium Conversation**: 100 messages
- **Large Conversation**: 1,000 messages
- **XLarge Conversation**: 10,000 messages

## Notes

- Benchmarks skip regular tests with `-run=^$`
- Use `-benchmem` to include memory allocation stats
- Some benchmarks report additional metrics using `b.ReportMetric()`
- Provider conversion benchmarks are in a separate package to avoid import cycles