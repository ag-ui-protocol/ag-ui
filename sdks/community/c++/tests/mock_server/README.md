# AG-UI Mock Server

Local Mock server for testing C++ SDK, supports HTTP streaming data delivery and all 23 AG-UI protocol event types.

## Features

**Complete AG-UI Protocol Support**
- 100% coverage of 23 event types
- SSE (Server-Sent Events) streaming response
- State management (snapshot and delta updates)
- Tool call simulation
- Thinking process simulation

**Predefined Test Scenarios**
- `simple_text`: Simple text message
- `with_thinking`: With thinking process
- `with_tool_call`: With tool call
- `with_state`: With state management
- `error`: Error scenario
- `all_events`: All event types demonstration

**Easy to Use**
- Zero dependencies (only requires Python 3.6+)
- Command-line startup
- RESTful API
- CORS support

## Quick Start

### 1. Start Server

```bash
# Use default port 8080
python3 tests/mock_server/mock_ag_server.py

# Specify port
python3 tests/mock_server/mock_ag_server.py --port 9090

# Specify host and port
python3 tests/mock_server/mock_ag_server.py --host 127.0.0.1 --port 8080
```

### 2. Verify Server Running

```bash
# Health check
curl http://localhost:8080/health

# View available scenarios
curl http://localhost:8080/scenarios
```

### 3. Test Agent API

```bash
# Simple text scenario
curl -X POST http://localhost:8080/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"scenario": "simple_text"}'

# With thinking process
curl -X POST http://localhost:8080/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"scenario": "with_thinking"}'

# Custom delay (milliseconds)
curl -X POST http://localhost:8080/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"scenario": "simple_text", "delay_ms": 500}'
```

## API Documentation

### GET /health

Health check endpoint

**Response Example:**
```json
{
  "status": "ok",
  "server": "AG-UI Mock Server",
  "version": "1.0.0"
}
```

### GET /scenarios

Get list of available test scenarios

**Response Example:**
```json
{
  "scenarios": [
    "simple_text",
    "with_thinking",
    "with_tool_call",
    "with_state",
    "error",
    "all_events"
  ],
  "description": {
    "simple_text": "Simple text message",
    "with_thinking": "With thinking process",
    "with_tool_call": "With tool call",
    "with_state": "With state management",
    "error": "Error scenario",
    "all_events": "All event types"
  }
}
```

### POST /api/agent/run

Run Agent and return SSE streaming response

**Request Parameters:**
```json
{
  "scenario": "simple_text",  // Scenario name (optional, default: simple_text)
  "delay_ms": 100             // Delay between events in milliseconds (optional, default: 100)
}
```

**Response Format:** SSE (Server-Sent Events)

**Response Example:**
```
data: {"type":"RUN_STARTED","run_id":"run_001"}

data: {"type":"TEXT_MESSAGE_START","message_id":"msg_001","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","message_id":"msg_001","delta":"Hello, "}

data: {"type":"TEXT_MESSAGE_CONTENT","message_id":"msg_001","delta":"world!"}

data: {"type":"TEXT_MESSAGE_END","message_id":"msg_001"}

data: {"type":"RUN_FINISHED","run_id":"run_001"}

```

## Test Scenarios Explained

### 1. simple_text - Simple Text Message

Most basic text message flow.

**Event Sequence:**
1. RUN_STARTED
2. TEXT_MESSAGE_START
3. TEXT_MESSAGE_CONTENT (multiple times)
4. TEXT_MESSAGE_END
5. RUN_FINISHED

**Use Cases:**
- Basic functionality testing
- Quick connection verification
- Performance benchmarking

### 2. with_thinking - With Thinking Process

Simulates AI thinking process.

**Event Sequence:**
1. RUN_STARTED
2. THINKING_START
3. THINKING_TEXT_MESSAGE_START
4. THINKING_TEXT_MESSAGE_CONTENT
5. THINKING_TEXT_MESSAGE_END
6. THINKING_END
7. TEXT_MESSAGE_START
8. TEXT_MESSAGE_CONTENT
9. TEXT_MESSAGE_END
10. RUN_FINISHED

**Use Cases:**
- Test thinking event handling
- Verify event filtering
- UI display testing

### 3. with_tool_call - With Tool Call

Simulates tool call flow.

**Event Sequence:**
1. RUN_STARTED
2. TEXT_MESSAGE_START/CONTENT/END
3. TOOL_CALL_START
4. TOOL_CALL_ARGS (multiple times)
5. TOOL_CALL_END
6. TOOL_CALL_RESULT
7. TEXT_MESSAGE_START/CONTENT/END
8. RUN_FINISHED

**Use Cases:**
- Test tool call handling
- Verify argument concatenation
- Tool result processing

### 4. with_state - With State Management

Simulates state update flow.

**Event Sequence:**
1. RUN_STARTED
2. STATE_SNAPSHOT
3. TEXT_MESSAGE_START/CONTENT/END
4. STATE_DELTA
5. TEXT_MESSAGE_START/CONTENT/END
6. STATE_DELTA
7. RUN_FINISHED

**Use Cases:**
- Test state management
- Verify delta updates
- State synchronization testing

### 5. error - Error Scenario

Simulates error situations.

**Event Sequence:**
1. RUN_STARTED
2. TEXT_MESSAGE_START/CONTENT
3. RUN_ERROR

**Use Cases:**
- Error handling testing
- Exception recovery verification
- Error logging testing

### 6. all_events - All Event Types

Complete demonstration of all 23 event types.

**Use Cases:**
- Complete functionality testing
- Protocol compatibility verification
- Integration testing

## C++ SDK Integration Examples

### Basic Usage

```cpp
#include "agent/http_agent.h"

using namespace agui;

int main() {
    // Create Agent
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("test_agent"))
        .build();
    
    // Create subscriber
    class MySubscriber : public IAgentSubscriber {
        AgentStateMutation onTextMessageContent(
            const TextMessageContentEvent& event) override {
            std::cout << event.delta;
            return AgentStateMutation();
        }
    };
    
    auto subscriber = std::make_shared<MySubscriber>();
    agent->subscribe(subscriber);
    
    // Run Agent
    RunAgentParams params;
    params.input.message = "Hello";
    params.input.scenario = "simple_text";  // Specify scenario
    
    agent->runAgent(
        params,
        [](const RunAgentResult& result) {
            std::cout << "\nSuccess!" << std::endl;
        },
        [](const AgentError& error) {
            std::cerr << "Error: " << error.message << std::endl;
        }
    );
    
    return 0;
}
```

### Testing Different Scenarios

```cpp
// Test thinking process
params.input.scenario = "with_thinking";
agent->runAgent(params, onSuccess, onError);

// Test tool call
params.input.scenario = "with_tool_call";
agent->runAgent(params, onSuccess, onError);

// Test state management
params.input.scenario = "with_state";
agent->runAgent(params, onSuccess, onError);

// Test error handling
params.input.scenario = "error";
agent->runAgent(params, onSuccess, onError);
```

### Custom Delay

```cpp
// Fast test (50ms delay)
params.input.delay_ms = 50;

// Slow test (500ms delay)
params.input.delay_ms = 500;

// No delay (stress test)
params.input.delay_ms = 0;
```

## Automated Testing Integration

### Using in Test Scripts

```bash
#!/bin/bash

# Start Mock server
python3 tests/mock_server/mock_ag_server.py --port 8080 &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Run tests
./build/test_http_agent
./build/test_integration

# Stop server
kill $SERVER_PID
```

### Docker Integration

```dockerfile
# Dockerfile
FROM python:3.9-slim

WORKDIR /app
COPY tests/mock_server/mock_ag_server.py .

EXPOSE 8080

CMD ["python3", "mock_ag_server.py", "--host", "0.0.0.0", "--port", "8080"]
```

```bash
# Build image
docker build -t ag-ui-mock-server .

# Run container
docker run -d -p 8080:8080 ag-ui-mock-server

# Stop container
docker stop <container_id>
```

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  mock-server:
    build: .
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 3
```

```bash
# Start
docker-compose up -d

# Stop
docker-compose down
```

## CI/CD Integration

### GitHub Actions

```yaml
name: C++ SDK Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v2
      
      - name: Set up Python
        uses: actions/setup-python@v2
        with:
          python-version: '3.9'
      
      - name: Start Mock Server
        run: |
          python3 tests/mock_server/mock_ag_server.py &
          sleep 2
      
      - name: Build and Test
        run: |
          mkdir build && cd build
          cmake -DBUILD_TESTS=ON ..
          make
          ./test_http_agent
          ./test_integration
```

## Troubleshooting

### Issue 1: Port Already in Use

**Error Message:**
```
OSError: [Errno 48] Address already in use
```

**Solution:**
```bash
# Find process using the port
lsof -i :8080

# Kill the process
kill -9 <PID>

# Or use a different port
python3 mock_ag_server.py --port 9090
```

### Issue 2: Connection Refused

**Error Message:**
```
Connection refused
```

**Solution:**
1. Confirm server is started
2. Check firewall settings
3. Verify port number is correct
4. Test connection with `curl`

### Issue 3: SSE Stream Interrupted

**Possible Causes:**
- Network timeout
- Client disconnected
- Server crashed

**Solution:**
1. Increase timeout duration
2. Add reconnection logic
3. Check server logs

## Performance Testing

### Benchmarking

```bash
# Using Apache Bench
ab -n 1000 -c 10 -p request.json -T application/json \
  http://localhost:8080/api/agent/run

# Using wrk
wrk -t4 -c100 -d30s --latency \
  -s post.lua http://localhost:8080/api/agent/run
```

### Stress Testing

```bash
# No delay high concurrency
curl -X POST http://localhost:8080/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"scenario": "simple_text", "delay_ms": 0}'
```

## Extension Development

### Adding Custom Scenarios

Edit `mock_ag_server.py`, add to `SCENARIOS` dictionary:

```python
SCENARIOS = {
    # ... existing scenarios ...
    
    "my_custom_scenario": [
        AGUIEvent.run_started("run_custom"),
        AGUIEvent.text_message_start("msg_custom", "assistant"),
        AGUIEvent.text_message_content("msg_custom", "Custom content"),
        AGUIEvent.text_message_end("msg_custom"),
        AGUIEvent.run_finished("run_custom")
    ]
}
```

### Adding New Event Types

Add static method in `AGUIEvent` class:

```python
@staticmethod
def my_custom_event(param1, param2):
    return {
        "type": "MY_CUSTOM_EVENT",
        "param1": param1,
        "param2": param2
    }
```

## Best Practices

1. **Use Mock Server During Development**
   - Fast iteration
   - No real service needed
   - Controllable test environment

2. **Use Real Service for Integration Testing**
   - Verify protocol compatibility
   - End-to-end testing
   - Production environment simulation

3. **Use No-Delay Mode for Performance Testing**
   - `delay_ms: 0`
   - Stress testing
   - Performance benchmarking

4. **Use Error Scenario for Error Testing**
   - Exception handling
   - Error recovery
   - Log verification

## Summary

AG-UI Mock Server provides:

**Complete Protocol Support** - 23 event types
**Flexible Test Scenarios** - 6 predefined scenarios
**Easy Integration** - Zero dependencies, command-line startup
**Production-Grade Features** - SSE streaming response, CORS support
**Developer Friendly** - Detailed documentation, example code

Using Mock Server enables:
- Accelerated development iteration
- Improved test coverage
- Reduced testing costs
- Enhanced code quality

**Get Started:**
```bash
python3 tests/mock_server/mock_ag_server.py
```

**Get Help:**
```bash
python3 tests/mock_server/mock_ag_server.py --help
