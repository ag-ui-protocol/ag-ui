import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';

/// Test configuration and shared helpers
class TestHelpers {
  /// Get base URL from environment or default
  static String get baseUrl {
    return Platform.environment['AGUI_BASE_URL'] ?? 
           'http://127.0.0.1:20203';
  }

  /// Check if integration tests should be skipped
  static bool get shouldSkipIntegration {
    return Platform.environment['AGUI_SKIP_INTEGRATION'] == '1';
  }

  /// Create a test AgUiClient with default configuration
  static AgUiClient createTestAgent({
    String? baseUrl,
    Duration? timeout,
  }) {
    return AgUiClient(
      config: AgUiClientConfig(
        baseUrl: baseUrl ?? TestHelpers.baseUrl,
      ),
    );
  }

  /// Create test run input with defaults
  static SimpleRunAgentInput createTestInput({
    String? threadId,
    String? runId,
    List<Message>? messages,
    List<Tool>? tools,
    List<Context>? context,
    dynamic state,
  }) {
    return SimpleRunAgentInput(
      threadId: threadId ?? 'test-thread-${DateTime.now().millisecondsSinceEpoch}',
      runId: runId ?? 'test-run-${DateTime.now().millisecondsSinceEpoch}',
      messages: messages ?? [],
      tools: tools ?? [],
      context: context ?? [],
      state: state ?? {},
    );
  }

  /// Helper to collect events into a list
  static Future<List<BaseEvent>> collectEvents(
    Stream<BaseEvent> eventStream, {
    Duration? timeout,
    bool expectRunFinished = true,
  }) async {
    final events = <BaseEvent>[];
    final completer = Completer<void>();
    StreamSubscription? subscription;

    subscription = eventStream.listen(
      (event) {
        events.add(event);
        if (expectRunFinished && event.eventType == EventType.runFinished) {
          completer.complete();
        }
      },
      onError: (error) {
        completer.completeError(error);
      },
      onDone: () {
        if (!completer.isCompleted) {
          completer.complete();
        }
      },
    );

    try {
      await completer.future.timeout(
        timeout ?? const Duration(seconds: 30),
      );
    } finally {
      await subscription.cancel();
    }

    return events;
  }

  /// Validate basic event sequence
  static void validateEventSequence(
    List<BaseEvent> events, {
    bool expectRunStarted = true,
    bool expectRunFinished = true,
    bool expectMessages = true,
  }) {
    expect(events, isNotEmpty, reason: 'Should have received events');

    if (expectRunStarted) {
      expect(
        events.first.eventType,
        equals(EventType.runStarted),
        reason: 'First event should be RUN_STARTED',
      );
    }

    if (expectRunFinished) {
      expect(
        events.last.eventType,
        equals(EventType.runFinished),
        reason: 'Last event should be RUN_FINISHED',
      );
    }

    if (expectMessages) {
      final hasMessages = events.any(
        (e) => e.eventType == EventType.messagesSnapshot ||
               e.eventType == EventType.textMessageStart ||
               e.eventType == EventType.textMessageContent ||
               e.eventType == EventType.textMessageEnd,
      );
      expect(hasMessages, isTrue, reason: 'Should have message events');
    }
  }

  /// Extract messages from events
  static List<Message> extractMessages(List<BaseEvent> events) {
    final messages = <Message>[];
    
    for (final event in events) {
      if (event is MessagesSnapshotEvent) {
        messages.clear();
        messages.addAll(event.messages);
      }
    }
    
    return messages;
  }

  /// Find tool calls in messages
  static List<ToolCall> findToolCalls(List<Message> messages) {
    final toolCalls = <ToolCall>[];
    
    for (final message in messages) {
      // Tool calls are stored in the message's toJson representation
      final json = message.toJson();
      if (json['tool_calls'] != null) {
        final calls = json['tool_calls'] as List;
        for (final call in calls) {
          toolCalls.add(ToolCall.fromJson(call as Map<String, dynamic>));
        }
      }
    }
    
    return toolCalls;
  }

  /// Save event transcript to file
  static Future<void> saveTranscript(
    List<BaseEvent> events,
    String filename,
  ) async {
    final artifactsDir = Directory('test/integration/artifacts');
    if (!await artifactsDir.exists()) {
      await artifactsDir.create(recursive: true);
    }

    final filepath = '${artifactsDir.path}/$filename';
    final file = File(filepath);
    
    // Convert events to JSONL format
    final jsonLines = events.map((event) {
      // Create a JSON representation of the event
      final json = {
        'type': event.eventType.value,
        'timestamp': DateTime.now().toIso8601String(),
        'data': _eventToJson(event),
      };
      return jsonEncode(json);
    }).join('\n');

    await file.writeAsString(jsonLines);
    print('Transcript saved to: $filepath');
  }

  /// Convert event to JSON for logging
  static Map<String, dynamic> _eventToJson(BaseEvent event) {
    final json = <String, dynamic>{
      'type': event.eventType.value,
    };

    if (event is RunStartedEvent) {
      json['threadId'] = event.threadId;
      json['runId'] = event.runId;
    } else if (event is RunFinishedEvent) {
      json['threadId'] = event.threadId;
      json['runId'] = event.runId;
    } else if (event is MessagesSnapshotEvent) {
      json['messages'] = event.messages.map(_messageToJson).toList();
    } else if (event is TextMessageChunkEvent) {
      json['messageId'] = event.messageId;
      // TextMessageChunkEvent stores content differently
      // Will need to check the actual implementation
    } else if (event is ToolCallStartEvent) {
      json['toolCallId'] = event.toolCallId;
    }

    return json;
  }

  /// Convert message to JSON for logging
  static Map<String, dynamic> _messageToJson(Message message) {
    return message.toJson();
  }

  /// Run test with optional skip check
  static void runIntegrationTest(
    String description,
    Future<void> Function() body, {
    bool skip = false,
  }) {
    test(
      description,
      body,
      skip: skip || shouldSkipIntegration,
    );
  }

  /// Create test group with optional skip
  static void integrationGroup(
    String description,
    void Function() body, {
    bool skip = false,
  }) {
    group(
      description,
      body,
      skip: skip || shouldSkipIntegration,
    );
  }
}