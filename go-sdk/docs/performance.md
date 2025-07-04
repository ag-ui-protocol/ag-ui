# AG-UI Tools System Performance Guide

## Performance Overview

The AG-UI Tools System is designed for high-performance tool execution with minimal overhead. This document provides performance characteristics, optimization guidelines, and tuning recommendations.

## Benchmark Results

### Registry Performance (Apple M4 Max)

| Operation | Performance | Memory Impact | Use Case |
|-----------|-------------|---------------|----------|
| `Registry.Get()` | 126.2 ns/op | High (cloning) | When modification needed |
| `Registry.GetReadOnly()` | 53.63 ns/op | Low (no cloning) | Read-only access |
| **Improvement** | **57% faster** | **50-80% less memory** | **Recommended default** |

### Execution Engine Performance

| Metric | Value | Notes |
|--------|-------|-------|
| Execution Overhead | 1-10ms | Baseline per execution |
| Max Concurrent | 100 (configurable) | Default limit |
| Throughput | 100-1000+ exec/sec | Depends on tool complexity |
| Memory Per Execution | ~50KB + tool data | Baseline memory usage |

### Concurrency Test Results

| Test Scenario | Configuration | Results |
|---------------|---------------|---------|
| High Load | 200 concurrent, 50 max | ✅ All executions complete |
| Mixed Success/Failure | 100 concurrent, 80% success | ✅ Correct metrics tracking |
| Timeout Handling | 50 concurrent, 100ms timeout | ✅ Proper timeout behavior |
| Memory Stress | 100 concurrent, 1MB per exec | ✅ Memory under 50MB growth |
| Goroutine Safety | 100 concurrent executions | ✅ No goroutine leaks |

## Memory Optimization

### Read-Only Access Pattern

**Before Optimization:**
```go
// Creates full clone every time (expensive)
tool, err := registry.Get(toolID)
schema := tool.Schema  // Access cloned data
```

**After Optimization:**
```go
// Returns read-only view (efficient)
toolView, err := registry.GetReadOnly(toolID)
schema := toolView.GetSchema()  // Access original data safely
```

**Results:**
- 57% performance improvement
- 50-80% memory reduction
- Zero functionality compromise

### Memory Usage Patterns

| Access Pattern | Memory Impact | When to Use |
|----------------|---------------|-------------|
| Clone (`Get()`) | High - full deep copy | Tool modification needed |
| Read-Only (`GetReadOnly()`) | Low - pointer reference | Read-only access (recommended) |
| Streaming | Variable - buffered chunks | Large data processing |

## Performance Tuning

### Execution Engine Configuration

```go
engine := NewExecutionEngine(registry,
    WithMaxConcurrent(100),        // Adjust based on CPU cores
    WithDefaultTimeout(30*time.Second), // Balance responsiveness vs reliability
    WithRateLimiter(rateLimiter),  // Prevent resource exhaustion
)
```

#### Tuning Guidelines

| Setting | Recommendation | Reasoning |
|---------|----------------|-----------|
| `MaxConcurrent` | 2-4x CPU cores | Balance concurrency vs resource usage |
| `DefaultTimeout` | 30-60 seconds | Allow complex operations, prevent hangs |
| `RateLimit` | Service-dependent | Match external service limits |

### Tool-Specific Optimization

```go
// Configure per-tool timeouts
tool.Capabilities = &ToolCapabilities{
    Timeout: 5 * time.Second,  // Fast operations
    Streaming: true,           // Large data transfers
    Retryable: true,          // Transient failures
}
```

### Schema Validation Performance

| Schema Complexity | Validation Time | Memory Usage | Recommendation |
|-------------------|-----------------|--------------|----------------|
| Simple (1-5 fields) | < 1ms | < 1KB | ✅ Optimal |
| Medium (5-20 fields) | 1-5ms | 1-10KB | ✅ Good |
| Complex (20+ fields) | 5-20ms | 10-100KB | ⚠️ Consider caching |
| Deep Nesting (5+ levels) | 10-50ms | 50-500KB | ⚠️ Optimize schema |

## Monitoring and Metrics

### Key Performance Indicators

```go
metrics := engine.GetMetrics()

// System-wide metrics
fmt.Printf("Total executions: %d\n", metrics.totalExecutions)
fmt.Printf("Success rate: %.2f%%\n", 
    float64(metrics.successCount)/float64(metrics.totalExecutions)*100)
fmt.Printf("Average duration: %v\n", 
    metrics.totalDuration/time.Duration(metrics.totalExecutions))

// Per-tool metrics
for toolID, toolMetrics := range metrics.toolMetrics {
    fmt.Printf("Tool %s: %d executions, avg %v\n", 
        toolID, toolMetrics.Executions, toolMetrics.AverageDuration)
}
```

### Performance Alerts

Set up monitoring for:
- Execution time > 95th percentile
- Error rate > 5%
- Memory usage growth > 100MB/hour
- Concurrency saturation (max concurrent reached)

### Resource Monitoring

```go
// Monitor goroutine usage
initialGoroutines := runtime.NumGoroutine()
// ... after operations
finalGoroutines := runtime.NumGoroutine()
if finalGoroutines-initialGoroutines > 10 {
    log.Warn("Potential goroutine leak detected")
}

// Monitor memory usage
var m runtime.MemStats
runtime.ReadMemStats(&m)
if m.Alloc > 100*1024*1024 { // 100MB
    log.Warn("High memory usage detected")
}
```

## Performance Best Practices

### 1. Use Read-Only Access by Default

```go
// ✅ Recommended: Memory efficient
toolView, err := registry.GetReadOnly(toolID)
executor := toolView.GetExecutor()

// ❌ Avoid unless modification needed
tool, err := registry.Get(toolID)
```

### 2. Implement Streaming for Large Data

```go
// ✅ For large responses
type StreamingTool struct{}

func (t *StreamingTool) ExecuteStream(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error) {
    ch := make(chan *ToolStreamChunk)
    go func() {
        defer close(ch)
        // Stream large data in chunks
        for chunk := range largeDataSource {
            ch <- &ToolStreamChunk{Type: "data", Data: chunk}
        }
    }()
    return ch, nil
}
```

### 3. Configure Appropriate Timeouts

```go
// ✅ Tool-specific timeouts
quickTool.Capabilities.Timeout = 5 * time.Second     // Fast operations
complexTool.Capabilities.Timeout = 2 * time.Minute  // Complex processing
```

### 4. Use Efficient Schema Design

```go
// ✅ Efficient schema
schema := &ToolSchema{
    Type: "object",
    Properties: map[string]*Property{
        "query": {Type: "string", MaxLength: ptr(1000)},  // Limit size
        "limit": {Type: "integer", Minimum: ptr(1.0), Maximum: ptr(100.0)}, // Bounds
    },
    Required: []string{"query"}, // Only required fields
}

// ❌ Avoid over-complex schemas
// Deep nesting, unlimited sizes, overly complex validation
```

### 5. Implement Proper Error Handling

```go
// ✅ Fast-fail for invalid inputs
func (t *Tool) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
    // Validate critical parameters early
    if query, ok := params["query"].(string); !ok || query == "" {
        return &ToolExecutionResult{
            Success: false,
            Error:   "query parameter is required",
        }, nil
    }
    
    // Implement with timeout context
    select {
    case result := <-processQuery(query):
        return result, nil
    case <-ctx.Done():
        return &ToolExecutionResult{
            Success: false,
            Error:   "execution timeout",
        }, nil
    }
}
```

## Load Testing and Benchmarking

### Running Performance Tests

```bash
# Run benchmarks
go test -bench=. ./pkg/tools -benchtime=10s

# Memory profiling
go test -bench=BenchmarkRegistry_GetReadOnly -memprofile=mem.prof ./pkg/tools

# CPU profiling  
go test -bench=BenchmarkExecutionEngine_ConcurrentExecute -cpuprofile=cpu.prof ./pkg/tools

# Stress testing (skip in short mode)
go test -v ./pkg/tools -run="TestExecutionEngine_StressTest"
```

### Custom Benchmarks

```go
func BenchmarkYourTool(b *testing.B) {
    registry := NewRegistry()
    tool := &YourTool{}
    registry.Register(tool)
    engine := NewExecutionEngine(registry)
    
    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            engine.Execute(context.Background(), "your-tool", params)
        }
    })
}
```

## Troubleshooting Performance Issues

### Common Issues and Solutions

| Issue | Symptoms | Solution |
|-------|----------|----------|
| High Memory Usage | Continuous memory growth | Use `GetReadOnly()`, implement streaming |
| Slow Tool Execution | High latency, timeouts | Optimize tool logic, increase timeouts |
| Concurrency Saturation | Queued executions | Increase `MaxConcurrent`, optimize tools |
| Goroutine Leaks | Growing goroutine count | Fix context cancellation, defer cleanup |

### Performance Debugging

```go
// Add timing to your tools
func (t *Tool) Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error) {
    start := time.Now()
    defer func() {
        duration := time.Since(start)
        if duration > 1*time.Second {
            log.Warnf("Slow tool execution: %s took %v", t.ID, duration)
        }
    }()
    
    // Your tool logic here
    return result, nil
}
```

---

This performance guide provides the foundation for building high-performance tool systems with the AG-UI framework. Regular monitoring and optimization following these guidelines will ensure optimal system performance.