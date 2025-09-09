import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:args/args.dart';
import 'package:http/http.dart' as http;

/// Tool Based Generative UI CLI Example
///
/// Demonstrates connecting to an AG-UI server, sending messages,
/// streaming events, and handling tool calls.
void main(List<String> arguments) async {
  final parser = ArgParser()
    ..addOption(
      'url',
      abbr: 'u',
      defaultsTo: Platform.environment['AG_UI_BASE_URL'] ?? 'http://127.0.0.1:20203',
      help: 'Base URL of the AG-UI server',
    )
    ..addOption(
      'api-key',
      abbr: 'k',
      defaultsTo: Platform.environment['AG_UI_API_KEY'],
      help: 'API key for authentication',
    )
    ..addOption(
      'message',
      abbr: 'm',
      help: 'Message to send (if not provided, will read from stdin)',
    )
    ..addFlag(
      'json',
      abbr: 'j',
      negatable: false,
      help: 'Output structured JSON logs',
    )
    ..addFlag(
      'dry-run',
      abbr: 'd',
      negatable: false,
      help: 'Print planned requests without executing',
    )
    ..addFlag(
      'auto-tool',
      abbr: 'a',
      negatable: false,
      help: 'Automatically provide tool results (non-interactive)',
    )
    ..addFlag(
      'help',
      abbr: 'h',
      negatable: false,
      help: 'Show help message',
    );

  ArgResults args;
  try {
    args = parser.parse(arguments);
  } catch (e) {
    // ignore: avoid_print
    print('Error: $e');
    // ignore: avoid_print
    print('');
    _printUsage(parser);
    exit(1);
  }

  if (args['help'] as bool) {
    _printUsage(parser);
    exit(0);
  }

  final cli = ToolBasedGenerativeUICLI(
    baseUrl: args['url'] as String,
    apiKey: args['api-key'] as String?,
    jsonOutput: args['json'] as bool,
    dryRun: args['dry-run'] as bool,
    autoTool: args['auto-tool'] as bool,
  );

  // Get message from args or stdin
  String? message = args['message'] as String?;
  if (message == null) {
    // ignore: avoid_print
    print('Enter your message (press Enter when done):');
    message = stdin.readLineSync();
    if (message == null || message.isEmpty) {
      // ignore: avoid_print
      print('No message provided');
      exit(1);
    }
  }

  try {
    await cli.run(message);
  } catch (e) {
    if (args['json'] as bool) {
      // ignore: avoid_print
      print(json.encode({'error': e.toString()}));
    } else {
      // ignore: avoid_print
      print('Error: $e');
    }
    exit(1);
  }
}

void _printUsage(ArgParser parser) {
  // ignore: avoid_print
  print('Tool Based Generative UI CLI Example');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Usage: dart run ag_ui_example [options]');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Options:');
  // ignore: avoid_print
  print(parser.usage);
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('Examples:');
  // ignore: avoid_print
  print('  # Interactive mode with default server');
  // ignore: avoid_print
  print('  dart run ag_ui_example');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # Send a specific message');
  // ignore: avoid_print
  print('  dart run ag_ui_example -m "Create a haiku about AI"');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # Auto-respond to tool calls');
  // ignore: avoid_print
  print('  dart run ag_ui_example -a -m "Create a haiku"');
  // ignore: avoid_print
  print('');
  // ignore: avoid_print
  print('  # JSON output for debugging');
  // ignore: avoid_print
  print('  dart run ag_ui_example -j -m "Test message"');
}

/// Main CLI implementation
class ToolBasedGenerativeUICLI {
  final String baseUrl;
  final String? apiKey;
  final bool jsonOutput;
  final bool dryRun;
  final bool autoTool;

  late final EventDecoder decoder;

  ToolBasedGenerativeUICLI({
    required this.baseUrl,
    this.apiKey,
    this.jsonOutput = false,
    this.dryRun = false,
    this.autoTool = false,
  }) {
    decoder = EventDecoder();
  }

  Future<void> run(String message) async {
    _log('info', 'Starting Tool Based Generative UI flow');
    _log('debug', 'Base URL: $baseUrl');

    // Generate IDs
    final threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';
    final runId = 'run_${DateTime.now().millisecondsSinceEpoch}';

    // Create initial message
    final userMessage = UserMessage(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      content: message,
    );

    final input = RunAgentInput(
      threadId: threadId,
      runId: runId,
      messages: [userMessage],
      tools: [],
      context: [],
    );

    if (dryRun) {
      _log('info', 'DRY RUN - Would send request:');
      _log('info', 'POST $baseUrl/tool-based-generative-ui');
      _log('info', 'Body: ${json.encode(input.toJson())}');
      return;
    }

    // Start the run
    _log('info', 'Starting run with thread_id: $threadId, run_id: $runId');
    _log('info', 'User message: $message');

    try {
      // Send initial request and stream events
      await _streamRun(input);
    } catch (e) {
      _log('error', 'Failed to complete run: $e');
      rethrow;
    }
  }

  Future<void> _streamRun(RunAgentInput input) async {
    final url = Uri.parse('$baseUrl/tool-based-generative-ui');
    
    // Prepare request
    final request = http.Request('POST', url)
      ..headers['Content-Type'] = 'application/json'
      ..headers['Accept'] = 'text/event-stream'
      ..body = json.encode(input.toJson());

    if (apiKey != null) {
      request.headers['Authorization'] = 'Bearer $apiKey';
    }

    _log('debug', 'Sending request to ${url.toString()}');

    // Send request and get streaming response
    final httpClient = http.Client();
    try {
      final streamedResponse = await httpClient.send(request);

      if (streamedResponse.statusCode != 200) {
        final body = await streamedResponse.stream.bytesToString();
        throw Exception('Server returned ${streamedResponse.statusCode}: $body');
      }

      // Process SSE stream
      final sseClient = SseClient();
      final sseStream = sseClient.parseStream(
        streamedResponse.stream,
        headers: streamedResponse.headers,
      );

      final allMessages = List<Message>.from(input.messages);
      final pendingToolCalls = <ToolCall>[];

      await for (final sseMessage in sseStream) {
        if (sseMessage.data == null || sseMessage.data!.isEmpty) {
          continue;
        }

        try {
          final event = decoder.decode(sseMessage.data!);
          await _handleEvent(event, allMessages, pendingToolCalls, input);
        } catch (e) {
          _log('error', 'Failed to decode event: $e');
          _log('debug', 'Raw data: ${sseMessage.data}');
        }
      }
    } finally {
      httpClient.close();
    }
  }

  Future<void> _handleEvent(
    BaseEvent event,
    List<Message> allMessages,
    List<ToolCall> pendingToolCalls,
    RunAgentInput originalInput,
  ) async {
    _log('event', event.type.toString().split('.').last);

    switch (event.type) {
      case EventType.runStarted:
        final runStarted = event as RunStartedEvent;
        _log('info', 'Run started: ${runStarted.runId}');
        break;

      case EventType.messagesSnapshot:
        final snapshot = event as MessagesSnapshotEvent;
        allMessages.clear();
        allMessages.addAll(snapshot.messages);
        
        // Check for new tool calls
        for (final message in snapshot.messages) {
          if (message is AssistantMessage && message.toolCalls != null && message.toolCalls!.isNotEmpty) {
            for (final toolCall in message.toolCalls!) {
              // Check if we've already processed this tool call
              if (!pendingToolCalls.any((tc) => tc.id == toolCall.id)) {
                pendingToolCalls.add(toolCall);
                await _handleToolCall(toolCall, allMessages, originalInput);
              }
            }
          }
        }
        
        // Display latest assistant message
        final latestAssistant = snapshot.messages
            .whereType<AssistantMessage>()
            .lastOrNull;
        if (latestAssistant != null) {
          if (latestAssistant.content != null) {
            _log('assistant', latestAssistant.content!);
          }
        }
        break;

      case EventType.runFinished:
        final runFinished = event as RunFinishedEvent;
        _log('info', 'Run finished: ${runFinished.runId}');
        break;

      default:
        _log('debug', 'Unhandled event type: ${event.type}');
    }
  }

  Future<void> _handleToolCall(
    ToolCall toolCall,
    List<Message> allMessages,
    RunAgentInput originalInput,
  ) async {
    _log('info', 'Tool call: ${toolCall.function.name}');
    _log('debug', 'Arguments: ${toolCall.function.arguments}');

    String toolResult;
    if (autoTool) {
      // Auto-generate tool result
      toolResult = _generateAutoToolResult(toolCall);
      _log('info', 'Auto-generated tool result: $toolResult');
    } else {
      // Prompt user for tool result
      // ignore: avoid_print
      print('\nTool "${toolCall.function.name}" was called with:');
      // ignore: avoid_print
      print(toolCall.function.arguments);
      // ignore: avoid_print
      print('Enter tool result (or press Enter for default):');
      final userInput = stdin.readLineSync();
      toolResult = userInput?.isNotEmpty == true ? userInput! : 'thanks';
    }

    // Add tool result message
    final toolMessage = ToolMessage(
      id: 'msg_tool_${DateTime.now().millisecondsSinceEpoch}',
      content: toolResult,
      toolCallId: toolCall.id,
    );
    allMessages.add(toolMessage);

    // Send updated messages to continue the run
    final updatedInput = RunAgentInput(
      threadId: originalInput.threadId,
      runId: originalInput.runId,
      messages: allMessages,
      tools: originalInput.tools,
      context: originalInput.context,
    );

    if (!dryRun) {
      _log('info', 'Sending tool result to server...');
      await _streamRun(updatedInput);
    }
  }

  String _generateAutoToolResult(ToolCall toolCall) {
    // Generate deterministic tool results based on function name
    switch (toolCall.function.name) {
      case 'generate_haiku':
        return 'thanks';
      case 'get_weather':
        return json.encode({'temperature': 72, 'condition': 'sunny'});
      case 'calculate':
        return json.encode({'result': 42});
      default:
        return 'Tool executed successfully';
    }
  }

  void _log(String level, String message) {
    if (jsonOutput) {
      // ignore: avoid_print
      print(json.encode({
        'timestamp': DateTime.now().toIso8601String(),
        'level': level,
        'message': message,
      }));
    } else {
      final prefix = level == 'error'
          ? '❌'
          : level == 'info'
              ? '📍'
              : level == 'event'
                  ? '📨'
                  : level == 'assistant'
                      ? '🤖'
                      : level == 'debug'
                          ? '🔍'
                          : '  ';
      if (level != 'debug' || Platform.environment['DEBUG'] == 'true') {
        // ignore: avoid_print
        print('$prefix $message');
      }
    }
  }
}