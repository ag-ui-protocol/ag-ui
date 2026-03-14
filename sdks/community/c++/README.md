# AG-UI C++ SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![C++17](https://img.shields.io/badge/C++-17-blue.svg)](https://en.cppreference.com/w/cpp/17)
[![CMake](https://img.shields.io/badge/CMake-3.10+-064F8C.svg)](https://cmake.org/)

A community C++ implementation of the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui), providing a complete SDK for AI Agent interaction with applications. This SDK implements all features, protocols, and specifications defined in the AG-UI protocol.

## Features

- **C++ Implementation** - Cross-platform support with high performance
- **HTTP Connectivity** - Built on libcurl for both standard and streaming HTTP requests
- **Stream Processing** - SSE (Server-Sent Events) parser for real-time data streaming
- **Event & State Management** - Complete implementation of all 26 AG-UI event types with state management
- **Middleware Support** - Flexible request/response pipeline with middleware architecture
- **Subscriber Pattern** - External subscriber support for event handling and processing
- **Synchronous API Design** - Intentionally synchronous for maximum threading model flexibility

## Architecture & Design Decisions

### Synchronous API Design

The `runAgent()` method uses a **synchronous blocking API**. This is an intentional design decision that provides maximum flexibility for different application architectures. 
Different applications have different threading requirements. We sugggest choose the threading model that best fits its architecture.

#### Implementation

The synchronous behavior is implemented using libcurl's blocking I/O. Events are processed as they arrive in the SSE stream, and callbacks are invoked synchronously during stream processing. This design gives you complete control over threading without imposing hidden thread creation or event loop requirements.

## Requirements

### Build Dependencies

- **CMake** (>= 3.10)
- **C++17 Compiler** (GCC 7+, Clang 5+, MSVC 2017+)
- **nlohmann_json** (>= 3.2.0) - JSON library
- **libcurl** - HTTP client library
- **pthread** - Threading library

### Test Dependencies (Optional)

- **Google Test** (>= 1.10.0) - Required only if building tests

### Installation

#### macOS
```bash
# Install build dependencies
brew install cmake nlohmann-json curl

# Install Google Test (for testing)
brew install googletest
```

#### Ubuntu/Debian
```bash
# Install build dependencies
sudo apt-get update
sudo apt-get install cmake g++ pkg-config
sudo apt-get install nlohmann-json3-dev libcurl4-openssl-dev

# Install Google Test (for testing)
sudo apt-get install libgtest-dev
```

## Quick Start

### Building the SDK

```bash
# Clone the repository
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui/sdks/community/c++

# Create build directory
mkdir build && cd build

# configure with tests enabled
cmake -DBUILD_TESTS=ON ..

# Build
make -j4
```

**Note**: When `BUILD_TESTS=ON` is specified, CMake will search for Google Test using `find_package(GTest REQUIRED)`. If Google Test is not installed, the configuration will fail with an error message. Install Google Test first (see [Test Dependencies](#test-dependencies-optional)) before enabling tests.

### Basic Usage

```cpp
#include "agent/http_agent.h"

using namespace agui;

int main() {
    // Create an HTTP Agent
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080/api/agent/run")
        .withAgentId(AgentId("my-agent"))
        .build();
    
    // Create a subscriber to handle events
    class MySubscriber : public IAgentSubscriber {
        AgentStateMutation onTextMessageContent(
            const TextMessageContentEvent& event,
            const std::string& buffer,
            const AgentSubscriberParams& params) override {
            std::cout << event.delta;
            return AgentStateMutation();
        }
    };
    
    auto subscriber = std::make_shared<MySubscriber>();
    agent->subscribe(subscriber);
    
    // Run the agent
    RunAgentParams params;
    agent->runAgent(
        params,
        [](const RunAgentResult& result) {
            std::cout << "Success!" << std::endl;
        },
        [](const std::string& error) {
            std::cerr << "Error: " << error << std::endl;
        }
    );
    
    return 0;
}
```

## Testing

The SDK includes comprehensive test suites built with **Google Test** framework to verify functionality and demonstrate usage patterns.

### Prerequisites for Testing

Before building and running tests, ensure Google Test is installed on your system:

#### macOS
```bash
brew install googletest
```

#### Ubuntu/Debian
```bash
sudo apt-get install libgtest-dev
```

The CMake configuration uses `find_package(GTest REQUIRED)` to locate the system-installed Google Test library. If Google Test is not found, CMake will report an error during configuration.

### Test Cases

**1. test_sse_parser.cpp** - SSE Parser robustness tests (30 tests)
**2. test_activity_events.cpp** - Activity event tests (15 tests)
**3. test_event_verifier.cpp** - Event sequence verification tests (27 tests)
**4. test_http_agent.cpp** - HttpAgent functionality tests
**5. test_middleware.cpp** - Middleware system tests
**6. test_sse_server.cpp** - Integration tests
**7. test_event_handler.cpp** - Event handler tests
**8. test_state_manager.cpp** - State manager tests
**9. test_apply_module.cpp** - Apply module tests

### Running Tests

#### 1. Start the Mock Server
**Important**: Always start the mock server before running integration tests
```bash
cd tests/mock_server
python3 mock_ag_server.py --host 127.0.0.1 --port 8080
```

Verify the server is running:

```bash
# Health check
curl http://localhost:8080/health

# View available scenarios
curl http://localhost:8080/scenarios
```

#### 2. Test the API with SSE streaming

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

```bash
cd build

# Run individual tests
./tests/test_sse_parser
./tests/test_http_agent
./tests/test_middleware
./tests/test_sse_server
./tests/test_event_verifier
./tests/test_activity_events
./tests/test_event_handler
./tests/test_state_manager
./tests/test_apply_module
```


## Logging

The C++ SDK uses a callback-based logging system. By default, logging is **disabled** to avoid polluting your application's output.

### Enable Logging

```cpp
#include "core/logger.h"

// Set log callback
agui::Logger::setCallback([](agui::LogLevel level, const std::string& message) {
    const char* levelStr = "";
    switch (level) {
        case agui::LogLevel::Debug:   levelStr = "DEBUG"; break;
        case agui::LogLevel::Info:    levelStr = "INFO"; break;
        case agui::LogLevel::Warning: levelStr = "WARN"; break;
        case agui::LogLevel::Error:   levelStr = "ERROR"; break;
    }
    std::cout << "[AGUI][" << levelStr << "] " << message << std::endl;
});

// Optional: Set minimum log level (default is Info)
agui::Logger::setMinLevel(agui::LogLevel::Info);  // Only Info, Warning, Error
agui::Logger::setMinLevel(agui::LogLevel::Debug); // All messages
```

### Disable Logging

```cpp
agui::Logger::setCallback(nullptr);
```

### Integration with Your Logging System

```cpp
// Example: Integration with spdlog
agui::Logger::setCallback([](agui::LogLevel level, const std::string& message) {
    switch (level) {
        case agui::LogLevel::Debug:   spdlog::debug(message); break;
        case agui::LogLevel::Info:    spdlog::info(message); break;
        case agui::LogLevel::Warning: spdlog::warn(message); break;
        case agui::LogLevel::Error:   spdlog::error(message); break;
    }
});

// Example: Integration with custom logger
agui::Logger::setCallback([&myLogger](agui::LogLevel level, const std::string& message) {
    myLogger.log(static_cast<int>(level), message);
});
```

### Log Levels

- **Debug**: Detailed debug information (thread IDs, request bodies, etc.)
- **Info**: General informational messages (agent created, middleware added, etc.)
- **Warning**: Warning messages (SSE parser errors, etc.)
- **Error**: Error messages (HTTP failures, validation errors, etc.)

## Project Structure

```
c++/
├── src/
│   ├── agent/          # Agent implementations
│   ├── core/           # Core types and utilities
│   ├── http/           # HTTP service layer
│   ├── middleware/     # Middleware system
│   ├── stream/         # SSE parser
│   └── apply/          # State application
├── tests/
│   ├── mock_server/    # Mock AG-UI server
│   ├── test_*.cpp      # Test suites
│   └── *.md            # Test documentation
├── CMakeLists.txt      # Build configuration
└── README.md           # This file
```

## Contributing

We welcome contributions to the AG-UI C++ SDK! Here's how you can help:

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Add tests** for new functionality
4. **Ensure all tests pass** (`ctest -V`)
5. **Commit your changes** (`git commit -m 'Add amazing feature'`)
6. **Push to the branch** (`git push origin feature/amazing-feature`)
7. **Open a Pull Request**

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contact

- **Issues**: [GitHub Issues](https://github.com/ag-ui-protocol/ag-ui/issues)

---

**Note**: This is a community-driven project. We appreciate your feedback and contributions!
