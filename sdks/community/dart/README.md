# AG-UI Dart SDK

A strongly-typed Dart implementation of the AG-UI protocol for standardizing agent-user interactions through event-based communication.

## Features

### ✅ Implemented
- **Core Protocol Support**: Full implementation of AG-UI event types and message structures
- **HTTP Client**: Production-ready client with SSE streaming support
- **Event Streaming**: Real-time event processing with backpressure handling
- **Tool Interactions**: Support for tool calls and results with generative UI
- **State Management**: Handle state snapshots and deltas (JSON Patch RFC 6902)
- **Message History**: Track conversation context across multiple runs
- **Type Safety**: Strongly-typed models for all protocol entities
- **Error Handling**: Comprehensive error types with validation

### 🚧 Planned
- WebSocket transport support
- Binary protocol encoding/decoding
- Advanced retry strategies
- Event caching and offline support

## Requirements

- Dart SDK >=3.3.0
- HTTP connectivity to AG-UI compatible servers

## Installation

This SDK is distributed via GitHub. Add it to your `pubspec.yaml` using Git dependencies:

### Option 1: Pin to a specific release tag (recommended for production)
```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/mattsp1290/ag-ui.git
      ref: v0.1.0  # Replace with desired version tag
      path: sdks/community/dart
```

### Option 2: Use a branch (for development)
```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/mattsp1290/ag-ui.git
      ref: main  # or any branch name
      path: sdks/community/dart
```

Then run:
```bash
dart pub get
```

## Quickstart

### Basic Usage

```dart
import 'package:ag_ui/ag_ui.dart';

void main() async {
  // Create a client
  final client = AgUiClient(
    config: AgUiConfig(
      baseUrl: 'http://localhost:20203',
      defaultTimeout: Duration(seconds: 30),
    ),
  );

  // Prepare input
  final input = RunAgentInput(
    threadId: 'thread_123',
    runId: 'run_456',
    messages: [
      UserMessage(
        id: 'msg_1',
        content: 'Hello, agent!',
      ),
    ],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  );

  // Stream events from the agent
  await for (final event in client.streamEvents('/chat', input)) {
    switch (event.eventType) {
      case EventType.textMessageStarted:
        final textEvent = event as TextMessageStartedEvent;
        print('Agent started typing: ${textEvent.messageId}');
        break;
      
      case EventType.textMessageChunk:
        final chunkEvent = event as TextMessageChunkEvent;
        print('Received chunk: ${chunkEvent.content}');
        break;
      
      case EventType.messagesSnapshot:
        final snapshot = event as MessagesSnapshotEvent;
        print('Messages: ${snapshot.messages.length}');
        break;
      
      case EventType.runFinished:
        print('Run completed!');
        break;
      
      default:
        print('Event: ${event.eventType}');
    }
  }
}
```

### Handling Tool Calls

```dart
import 'package:ag_ui/ag_ui.dart';
import 'dart:convert';

Future<void> handleToolCalls() async {
  final client = AgUiClient(
    config: AgUiConfig(baseUrl: 'http://localhost:20203'),
  );

  final messages = <Message>[];
  
  // Initial user message
  messages.add(UserMessage(
    id: 'msg_1',
    content: 'What\'s the weather in San Francisco?',
  ));

  final input = RunAgentInput(
    threadId: 'thread_${DateTime.now().millisecondsSinceEpoch}',
    runId: 'run_${DateTime.now().millisecondsSinceEpoch}',
    messages: messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  );

  await for (final event in client.streamEvents('/agent', input)) {
    if (event is MessagesSnapshotEvent) {
      // Check for tool calls in assistant messages
      for (final message in event.messages) {
        if (message is AssistantMessage && message.toolCalls != null) {
          for (final toolCall in message.toolCalls!) {
            print('Tool called: ${toolCall.function.name}');
            print('Arguments: ${toolCall.function.arguments}');
            
            // Provide tool result
            final toolResult = ToolMessage(
              id: 'tool_msg_${DateTime.now().millisecondsSinceEpoch}',
              content: json.encode({'temperature': 72, 'condition': 'sunny'}),
              toolCallId: toolCall.id,
            );
            
            messages.add(toolResult);
            
            // Continue conversation with tool result
            final continuedInput = RunAgentInput(
              threadId: input.threadId,
              runId: 'run_${DateTime.now().millisecondsSinceEpoch}',
              messages: messages,
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
            );
            
            // Stream the continuation
            await for (final nextEvent in client.streamEvents('/agent', continuedInput)) {
              // Handle continuation events...
              if (nextEvent is RunFinishedEvent) break;
            }
          }
        }
      }
    }
  }
}
```

### Environment Variables

Configure the client using environment variables:

```bash
export AGUI_BASE_URL=http://your-server:20203
export AGUI_API_KEY=your-api-key-here

dart run your_app.dart
```

```dart
// Client will automatically use environment variables
final client = AgUiClient.fromEnvironment();
```

## API Overview

### Core Types

#### `AgUiClient`
Main client for interacting with AG-UI servers:
- `streamEvents(endpoint, input)` - Stream events from an endpoint
- `sendRequest(endpoint, input)` - Send one-shot requests
- Configuration via `AgUiConfig`

#### `RunAgentInput`
Input structure for agent runs:
```dart
RunAgentInput(
  threadId: String,        // Conversation thread ID
  runId: String,          // Unique run identifier
  messages: List<Message>, // Conversation history
  state: Map<String, dynamic>, // Application state
  tools: List<Tool>,      // Available tools
  context: List<dynamic>, // Additional context
  forwardedProps: Map<String, dynamic>, // Pass-through properties
)
```

#### Message Types
- `UserMessage` - User input messages
- `AssistantMessage` - Agent responses with optional tool calls
- `SystemMessage` - System-level messages
- `ToolMessage` - Tool execution results

#### Event Types
- Lifecycle: `RUN_STARTED`, `RUN_FINISHED`
- Messages: `TEXT_MESSAGE_STARTED`, `TEXT_MESSAGE_CHUNK`, `TEXT_MESSAGE_FINISHED`
- State: `STATE_SNAPSHOT`, `STATE_DELTA`
- Tools: `TOOL_CALL_STARTED`, `TOOL_CALL_FINISHED`, `TOOL_RESULT`
- UI: `GENERATIVE_UI_ELEMENT_*`

### Error Handling

```dart
try {
  await for (final event in client.streamEvents('/agent', input)) {
    // Process events
  }
} on ValidationError catch (e) {
  print('Invalid input: ${e.message}');
} on NetworkError catch (e) {
  print('Network issue: ${e.message}');
} on ServerError catch (e) {
  print('Server error: ${e.statusCode} - ${e.message}');
} catch (e) {
  print('Unexpected error: $e');
}
```

## Example Application

A complete example application is available at [`sdks/community/dart/example/`](example/) demonstrating:

- Interactive CLI for testing AG-UI servers
- Tool-based generative UI flows
- Message streaming and event handling
- Automatic tool response generation

Run the example:
```bash
cd sdks/community/dart/example
dart pub get
dart run ag_ui_example --help
```

## Integration Testing

The SDK includes comprehensive integration tests that validate compatibility with AG-UI servers. To run tests locally:

```bash
cd sdks/community/dart

# Run unit tests
dart test

# Run integration tests (requires local server)
cd test/integration
./helpers/start_server.sh  # Start test server
dart test simple_qa_test.dart
./helpers/stop_server.sh   # Stop test server
```

For Docker-based testing:
```bash
dart test simple_qa_docker_test.dart  # Automatically manages container
```

## Troubleshooting

### Connection Timeouts
Adjust timeout in client configuration:
```dart
final client = AgUiClient(
  config: AgUiConfig(
    baseUrl: 'http://localhost:20203',
    defaultTimeout: Duration(seconds: 60), // Increase timeout
  ),
);
```

### SSL/TLS Issues
For self-signed certificates in development:
```dart
final client = AgUiClient(
  config: AgUiConfig(
    baseUrl: 'https://localhost:20203',
    validateCertificates: false, // Development only!
  ),
);
```

### Debug Logging
Enable debug output:
```bash
export DEBUG=true
dart run your_app.dart
```

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Resources

- [AG-UI Protocol Specification](https://github.com/mattsp1290/ag-ui/blob/main/docs/specification.md)
- [AG-UI Documentation](https://docs.ag-ui.com)
- [TypeScript SDK Reference](../../typescript-sdk/)
- [Python SDK Reference](../../python-sdk/)
- [AG-UI Dojo](../../typescript-sdk/apps/dojo/) - Interactive protocol demonstration

## License

This SDK is part of the AG-UI Protocol project. See the [main repository](https://github.com/mattsp1290/ag-ui) for license information.

## Versioning

This SDK follows semantic versioning. Version history will be tracked in future releases.

## Support

For issues, questions, or feature requests:
- Open an issue on [GitHub](https://github.com/mattsp1290/ag-ui/issues)
- Check existing [discussions](https://github.com/mattsp1290/ag-ui/discussions)
- Review the [protocol specification](https://github.com/mattsp1290/ag-ui/blob/main/docs/specification.md) for protocol details