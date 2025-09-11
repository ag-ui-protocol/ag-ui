# AG-UI Dart SDK

The official Dart SDK for the AG-UI protocol, standardizing agent-user interactions.

## Installation

This package is distributed via GitHub only (not published to pub.dev). To use it in your Dart or Flutter project, add it as a Git dependency in your `pubspec.yaml` file.

### Using the latest version (unpinned)

```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/ag-ui-protocol/ag-ui.git
      path: sdks/community/dart
```

### Using a specific tag (recommended for production)

```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/ag-ui-protocol/ag-ui.git
      path: sdks/community/dart
      ref: v0.1.0  # Replace with desired version tag
```

### Updating to a newer version

To update to the latest version or a newer tag:

1. Update the `ref` field in your `pubspec.yaml` to the desired tag (or remove it for latest)
2. Run `dart pub get` or `flutter pub get` to fetch the updated package

### Available versions

Check the [GitHub Releases](https://github.com/ag-ui-protocol/ag-ui/releases) page for available version tags.

For more information about Git dependencies in Dart, see the [official documentation](https://dart.dev/tools/pub/dependencies#git-packages).

## Quick Start

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

## Features

- Event-driven communication between agents and UIs
- Support for multiple transport protocols (SSE, WebSockets, HTTP)
- Tool-based generative UI capabilities
- Human-in-the-loop interactions
- State management with snapshots and deltas

## Documentation

For full documentation, visit [https://docs.ag-ui.com](https://docs.ag-ui.com)

## Example

See the [example](example/) directory for a complete demonstration of AG-UI features.

## License

See the main repository for license information.