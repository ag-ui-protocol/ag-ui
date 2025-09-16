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
  // Initialize client with base URL
  final client = AgUiClient(
    config: AgUiClientConfig(
      baseUrl: 'http://localhost:8000',
      defaultHeaders: {'Authorization': 'Bearer YOUR_API_KEY'}, // Optional
    ),
  );

  // Create input for the agent
  final input = SimpleRunAgentInput(
    messages: [
      UserMessage(
        id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
        content: 'Hello, create a haiku about AI',
      ),
    ],
  );

  // Run agent and stream events
  await for (final event in client.runAgent('agentic_chat', input)) {
    switch (event.type) {
      case EventType.runStarted:
        print('Run started');
        break;
      case EventType.textMessageContent:
        final textEvent = event as TextMessageContentEvent;
        print('Assistant: ${textEvent.content}');
        break;
      case EventType.runFinished:
        print('Run complete');
        break;
      default:
        print('Event: ${event.type}');
    }
  }
}
```

## Usage Examples

### 1. Initialize Client

```dart
import 'package:ag_ui/ag_ui.dart';

// Basic initialization
final client = AgUiClient(
  config: AgUiClientConfig(
    baseUrl: 'http://localhost:8000',
  ),
);

// With authentication and custom headers
import 'dart:io';

final authenticatedClient = AgUiClient(
  config: AgUiClientConfig(
    baseUrl: Platform.environment['AGUI_BASE_URL'] ?? 'http://localhost:8000',
    defaultHeaders: {
      'Authorization': 'Bearer ${Platform.environment['AGUI_API_KEY']}',
      'X-Custom-Header': 'value',
    },
    requestTimeout: Duration(seconds: 30),
  ),
);

// With custom HTTP client for advanced networking
import 'package:http/http.dart' as http;

final customClient = AgUiClient(
  config: AgUiClientConfig(baseUrl: 'http://localhost:8000'),
  httpClient: http.Client()../* configure as needed */,
);
```

### 2. Send User Message and Stream Response

```dart
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';

Future<void> sendMessage(String userInput) async {
  final client = AgUiClient(
    config: AgUiClientConfig(baseUrl: 'http://localhost:8000'),
  );

  // Prepare input with user message
  final input = SimpleRunAgentInput(
    threadId: 'thread_${DateTime.now().millisecondsSinceEpoch}',
    messages: [
      UserMessage(
        id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
        content: userInput,
      ),
    ],
  );

  // Stream events from the agent
  final stream = client.runAgenticChat(input);
  
  await for (final event in stream) {
    switch (event.type) {
      case EventType.textMessageContent:
        final textEvent = event as TextMessageContentEvent;
        stdout.write(textEvent.text); // Stream tokens
        break;
      case EventType.textMessageEnd:
        stdout.writeln(); // New line after message
        break;
      case EventType.messagesSnapshot:
        final snapshot = event as MessagesSnapshotEvent;
        print('Total messages: ${snapshot.messages.length}');
        break;
      default:
        // Handle other event types as needed
        break;
    }
  }
}
```

### 3. Handle Tool Calls

```dart
import 'package:ag_ui/ag_ui.dart';
import 'dart:convert';

Future<void> handleToolCalls() async {
  final client = AgUiClient(
    config: AgUiClientConfig(baseUrl: 'http://localhost:8000'),
  );

  final input = SimpleRunAgentInput(
    messages: [
      UserMessage(
        id: 'msg_1',
        content: 'Generate a haiku',
      ),
    ],
  );

  List<ToolCall> pendingToolCalls = [];
  
  // First run - collect tool calls
  await for (final event in client.runToolBasedGenerativeUi(input)) {
    if (event is MessagesSnapshotEvent) {
      // Extract tool calls from assistant messages
      for (final message in event.messages) {
        if (message is AssistantMessage && message.toolCalls != null) {
          pendingToolCalls.addAll(message.toolCalls!);
        }
      }
    } else if (event.type == EventType.runFinished && pendingToolCalls.isNotEmpty) {
      // Process tool calls after run completes
      break;
    }
  }

  // Prepare tool results
  final toolResults = pendingToolCalls.map((toolCall) {
    // Process each tool call and generate result
    final result = processToolCall(toolCall);
    
    return ToolMessage(
      id: 'tool_result_${DateTime.now().millisecondsSinceEpoch}',
      toolCallId: toolCall.id,
      content: result,
    );
  }).toList();

  // Second run - send tool results
  final followUpInput = SimpleRunAgentInput(
    threadId: input.threadId,
    messages: [
      ...input.messages,
      ...toolResults,
    ],
  );

  await for (final event in client.runToolBasedGenerativeUi(followUpInput)) {
    if (event is TextMessageContentEvent) {
      print('Assistant: ${event.text}');
    }
  }
}

String processToolCall(ToolCall toolCall) {
  // Parse tool call arguments
  final args = json.decode(toolCall.function.arguments);
  
  // Process based on tool name
  switch (toolCall.function.name) {
    case 'generate_haiku':
      return 'Haiku generated successfully';
    case 'get_weather':
      final location = args['location'];
      return 'Weather for $location: Sunny, 72°F';
    default:
      return 'Tool processed';
  }
}
```

### 4. Manage Conversation State

```dart
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';

class ConversationManager {
  final AgUiClient client;
  final String threadId;
  final List<Message> messageHistory = [];
  Map<String, dynamic> state = {};

  ConversationManager({required this.client})
      : threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';

  Future<void> sendMessage(String content) async {
    // Add user message to history
    final userMessage = UserMessage(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      content: content,
    );
    messageHistory.add(userMessage);

    // Create input with full history
    final input = SimpleRunAgentInput(
      threadId: threadId,
      messages: messageHistory,
      state: state,
    );

    // Process events
    await for (final event in client.runSharedState(input)) {
      switch (event.type) {
        case EventType.stateSnapshot:
          final stateEvent = event as StateSnapshotEvent;
          state = stateEvent.snapshot;
          print('State updated: $state');
          break;
        case EventType.stateDelta:
          final deltaEvent = event as StateDeltaEvent;
          // Apply JSON Patch operations to state
          applyJsonPatch(state, deltaEvent.delta);
          break;
        case EventType.messagesSnapshot:
          final snapshot = event as MessagesSnapshotEvent;
          // Update message history from snapshot
          messageHistory.clear();
          messageHistory.addAll(snapshot.messages);
          break;
        case EventType.textMessageContent:
          final textEvent = event as TextMessageContentEvent;
          stdout.write(textEvent.text);
          break;
        default:
          break;
      }
    }
  }

  void applyJsonPatch(Map<String, dynamic> target, List<dynamic> operations) {
    // Apply RFC 6902 JSON Patch operations
    for (final op in operations) {
      switch (op['op']) {
        case 'add':
          // Implementation for add operation
          break;
        case 'replace':
          // Implementation for replace operation
          break;
        case 'remove':
          // Implementation for remove operation
          break;
      }
    }
  }
}
```

### 5. Error Handling and Cancellation

```dart
import 'dart:async';
import 'package:ag_ui/ag_ui.dart';

Future<void> robustAgentCall() async {
  final client = AgUiClient(
    config: AgUiClientConfig(
      baseUrl: 'http://localhost:8000',
      requestTimeout: Duration(seconds: 30),
    ),
  );

  // Create cancellation token
  final cancelToken = CancelToken();

  // Set up timeout
  Timer? timeoutTimer;
  timeoutTimer = Timer(Duration(seconds: 60), () {
    print('Request timed out, cancelling...');
    cancelToken.cancel();
  });

  try {
    final input = SimpleRunAgentInput(
      messages: [
        UserMessage(
          id: 'msg_1',
          content: 'Process this request',
        ),
      ],
    );

    final stream = client.runAgent(
      'agentic_chat',
      input,
      cancelToken: cancelToken,
    );

    await for (final event in stream) {
      // Process events
      print('Received: ${event.type}');
      
      // Cancel on specific condition
      if (shouldCancel(event)) {
        cancelToken.cancel();
        break;
      }
    }
  } on ConnectionException catch (e) {
    print('Connection error: ${e.message}');
    // Retry logic here
  } on ValidationError catch (e) {
    print('Validation error: ${e.message}');
  } on CancelledException {
    print('Request was cancelled');
  } catch (e) {
    print('Unexpected error: $e');
  } finally {
    timeoutTimer?.cancel();
    client.dispose(); // Clean up resources
  }
}

bool shouldCancel(BaseEvent event) {
  // Implement your cancellation logic
  return false;
}
```

### 6. Custom Event Processing

```dart
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';

class EventProcessor {
  final Map<EventType, Function(BaseEvent)> handlers = {};

  EventProcessor() {
    // Register event handlers
    handlers[EventType.runStarted] = (event) {
      final runEvent = event as RunStartedEvent;
      print('🚀 Run started');
    };

    handlers[EventType.textMessageContent] = (event) {
      final textEvent = event as TextMessageContentEvent;
      stdout.write(textEvent.content);
    };

    handlers[EventType.toolCallStart] = (event) {
      final toolEvent = event as ToolCallStartEvent;
      print('\n🔧 Tool call started');
    };

    handlers[EventType.toolCallResult] = (event) {
      final resultEvent = event as ToolCallResultEvent;
      print('✅ Tool result received');
    };

    handlers[EventType.runError] = (event) {
      final errorEvent = event as RunErrorEvent;
      print('❌ Error occurred');
    };

    handlers[EventType.runFinished] = (event) {
      print('\n✨ Run complete');
    };
  }

  Future<void> processStream(Stream<BaseEvent> eventStream) async {
    await for (final event in eventStream) {
      final handler = handlers[event.type];
      if (handler != null) {
        handler(event);
      } else {
        // Handle unknown event types
        print('Unknown event: ${event.type}');
      }
    }
  }
}

// Usage
void main() async {
  final client = AgUiClient(
    config: AgUiClientConfig(baseUrl: 'http://localhost:8000'),
  );

  final processor = EventProcessor();
  
  final input = SimpleRunAgentInput(
    messages: [UserMessage(id: 'msg_1', content: 'Hello')],
  );

  await processor.processStream(
    client.runAgent('agentic_chat', input),
  );
}
```

### 7. Using Environment Variables

```dart
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';

AgUiClient createClientFromEnv() {
  // Read configuration from environment
  final baseUrl = Platform.environment['AGUI_BASE_URL'] ?? 'http://localhost:8000';
  final apiKey = Platform.environment['AGUI_API_KEY'];
  final timeout = int.tryParse(Platform.environment['AGUI_TIMEOUT'] ?? '30') ?? 30;

  final headers = <String, String>{};
  if (apiKey != null && apiKey.isNotEmpty) {
    headers['Authorization'] = 'Bearer $apiKey';
  }

  return AgUiClient(
    config: AgUiClientConfig(
      baseUrl: baseUrl,
      defaultHeaders: headers,
      requestTimeout: Duration(seconds: timeout),
    ),
  );
}

// Usage with environment variables:
// AGUI_BASE_URL=https://api.example.com AGUI_API_KEY=sk-xxx dart run main.dart
```

### 8. Complete End-to-End Example

```dart
import 'dart:io';
import 'dart:convert';
import 'package:ag_ui/ag_ui.dart';

Future<void> main() async {
  // Initialize client
  final client = AgUiClient(
    config: AgUiClientConfig(
      baseUrl: Platform.environment['AGUI_BASE_URL'] ?? 'http://localhost:8000',
    ),
  );

  // Get user input
  stdout.write('Enter your message: ');
  final userInput = stdin.readLineSync() ?? '';

  if (userInput.isEmpty) {
    print('No input provided');
    return;
  }

  // Create conversation context
  final threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';
  final messages = <Message>[];

  // Add user message
  messages.add(UserMessage(
    id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
    content: userInput,
  ));

  // Track tool calls for processing
  final pendingToolCalls = <ToolCall>[];
  var runCount = 0;

  while (true) {
    runCount++;
    print('\n📍 Starting run #$runCount');

    final input = SimpleRunAgentInput(
      threadId: threadId,
      messages: messages,
    );

    var runComplete = false;
    var hasNewToolCalls = false;

    try {
      await for (final event in client.runToolBasedGenerativeUi(input)) {
        switch (event.type) {
          case EventType.runStarted:
            print('🚀 Run started');
            break;

          case EventType.textMessageContent:
            final textEvent = event as TextMessageContentEvent;
            stdout.write(textEvent.text);
            break;

          case EventType.messagesSnapshot:
            final snapshot = event as MessagesSnapshotEvent;
            // Update messages with latest snapshot
            messages.clear();
            messages.addAll(snapshot.messages);
            
            // Check for new tool calls
            for (final message in snapshot.messages) {
              if (message is AssistantMessage && message.toolCalls != null) {
                for (final toolCall in message.toolCalls!) {
                  if (!pendingToolCalls.any((tc) => tc.id == toolCall.id)) {
                    pendingToolCalls.add(toolCall);
                    hasNewToolCalls = true;
                    print('\n🔧 Tool call: ${toolCall.function.name}');
                  }
                }
              }
            }
            break;

          case EventType.runFinished:
            print('\n✅ Run #$runCount complete');
            runComplete = true;
            break;

          case EventType.runError:
            final errorEvent = event as RunErrorEvent;
            print('\n❌ Error occurred');
            break;

          default:
            // Handle other events as needed
            break;
        }
      }
    } catch (e) {
      print('\n❌ Error during run: $e');
      break;
    }

    // Process tool calls if any
    if (runComplete && hasNewToolCalls) {
      print('\n📝 Processing ${pendingToolCalls.length} tool calls...');
      
      for (final toolCall in pendingToolCalls) {
        stdout.write('Enter result for ${toolCall.function.name} (or press Enter for default): ');
        final userResult = stdin.readLineSync();
        
        final result = userResult?.isNotEmpty == true 
            ? userResult! 
            : 'Tool executed successfully';

        messages.add(ToolMessage(
          id: 'tool_result_${DateTime.now().millisecondsSinceEpoch}',
          toolCallId: toolCall.id,
          content: result,
        ));
      }

      pendingToolCalls.clear();
      continue; // Start new run with tool results
    }

    // No more tool calls, conversation complete
    break;
  }

  print('\n🎉 Conversation complete!');
  client.dispose();
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