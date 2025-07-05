# Goroutine Leak Detection System

This document describes the comprehensive goroutine leak detection system implemented for the tool system.

## Overview

The goroutine leak detection system provides:
- Automated leak detection in tests
- Real-time goroutine monitoring
- Resource tracking and reporting
- Test helpers for streaming operations
- Best practices and patterns

## Components

### 1. GoroutineLeakDetector

The main leak detection component that snapshots goroutine state and verifies no leaks occur.

```go
detector := NewGoroutineLeakDetector(t)
defer detector.Check()

// Your test code here
```

Features:
- Configurable tolerance for acceptable goroutine growth
- Pattern exclusion for system goroutines
- Detailed leak reporting with stack traces

### 2. StreamingTestHelper

Manages streaming contexts and ensures proper cleanup.

```go
VerifyStreamingNoLeaks(t, func(helper *StreamingTestHelper) {
    ctx := context.Background()
    sc := helper.CreateStreamingContext(ctx)
    
    // Use streaming context
    // Helper automatically cleans up
})
```

### 3. GoroutineMonitor

Provides real-time monitoring of goroutine counts.

```go
monitor := NewGoroutineMonitor()
monitor.SetAlertThreshold(50)
monitor.Start()
defer monitor.Stop()

// Monitor will track goroutine counts
// and alert if threshold exceeded
```

### 4. ResourceTracker

Tracks resource usage during operations.

```go
tracker := NewResourceTracker()

// Track operations
tracker.RecordOperation()
tracker.RecordError()

// Get report
report := tracker.Report()
```

### 5. StreamingResourceGuard

Ensures streaming resources are properly managed.

```go
guard := NewStreamingResourceGuard(ctx)
defer guard.Cleanup()

guard.RegisterStream()
// ... do work ...
guard.CompleteStream()
```

## Usage Patterns

### Basic Leak Detection

```go
func TestMyFunction(t *testing.T) {
    VerifyNoLeaks(t, func() {
        // Your test code
    })
}
```

### Streaming Operations

```go
func TestStreaming(t *testing.T) {
    VerifyStreamingNoLeaks(t, func(helper *StreamingTestHelper) {
        ctx := context.Background()
        sc := helper.CreateStreamingContext(ctx)
        
        // Send data
        sc.Send("data")
        
        // Always consume
        for range sc.Channel() {
            // Process
        }
    })
}
```

### Context Cancellation

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

// Use context in streaming operations
// Cancel will stop goroutines
```

## Best Practices

1. **Always Close Streaming Contexts**
   ```go
   sc := NewStreamingContext(ctx)
   defer sc.Close()
   ```

2. **Always Consume Channels**
   ```go
   chunks, _ := helper.StreamJSON(ctx, data, chunkSize)
   for range chunks {
       // Even if not processing, drain the channel
   }
   ```

3. **Use Context Cancellation**
   ```go
   ctx, cancel := context.WithTimeout(context.Background(), timeout)
   defer cancel()
   ```

4. **Buffer Channels Appropriately**
   - Updated StreamJSON and StreamReader to use buffered channels
   - Prevents goroutine blocking on send

5. **Handle Errors Properly**
   ```go
   if err := sc.Send(data); err != nil {
       return // Exit gracefully on error
   }
   ```

## Implementation Changes

### Streaming.go Updates

1. **Buffered Channels**: StreamJSON and StreamReader now use buffered channels to prevent blocking
2. **Context Checks**: Added context cancellation checks before operations
3. **Cleanup Methods**: Added Close() method to StreamingResultBuilder
4. **Error Handling**: Improved error propagation and context handling

### Test Updates

1. **Leak Detection**: All streaming tests now use VerifyNoLeaks
2. **Proper Cleanup**: Added defer Close() statements
3. **Channel Draining**: Ensure all channels are consumed
4. **Context Management**: Proper context cancellation

## Testing

Run the leak detection tests:
```bash
go test -v -run ".*Leak.*" ./pkg/tools/
```

Run with race detection:
```bash
go test -race -v ./pkg/tools/
```

## Monitoring in Production

The monitoring components can be used in production:

```go
monitor := NewGoroutineMonitor()
monitor.SetAlertCallback(func(sample GoroutineSample) {
    log.Printf("High goroutine count: %d", sample.Count)
})
monitor.Start()
```

## Troubleshooting

### Common Issues

1. **Channel Not Consumed**: Always drain channels even if data isn't needed
2. **Context Not Cancelled**: Always use defer cancel() with contexts
3. **StreamingContext Not Closed**: Always defer sc.Close()
4. **Goroutines in Loops**: Check for proper exit conditions

### Debugging Tips

1. Use `runtime.Stack()` to get goroutine stacks
2. Use the monitor's Report() method for summaries
3. Set lower alert thresholds during testing
4. Use the leak detector's exclusion patterns for system goroutines