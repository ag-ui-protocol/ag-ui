import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:ag_ui/ag_ui.dart';
import 'package:file_picker/file_picker.dart';
import '../models/chat_message.dart';
import '../models/endpoint_config.dart';
import '../services/ag_ui_service.dart';
import '../widgets/chat_message_widget.dart';
import '../widgets/chat_input_widget.dart';

class ChatPage extends StatelessWidget {
  final EndpointConfig endpoint;

  const ChatPage({Key? key, required this.endpoint}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => ChatPageState(endpoint: endpoint),
      child: const ChatPageView(),
    );
  }
}

class ChatPageView extends StatelessWidget {
  const ChatPageView({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = context.watch<ChatPageState>();

    return Scaffold(
      backgroundColor: theme.colorScheme.background,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              state.endpoint.name,
              style: theme.textTheme.titleMedium,
            ),
            Text(
              state.endpoint.description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        actions: [
          if (state.connectionStatus != ConnectionStatus.disconnected)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Icon(
                _getConnectionIcon(state.connectionStatus),
                color: _getConnectionColor(state.connectionStatus, theme),
                size: 20,
              ),
            ),
        ],
        bottom: state.isLoading
            ? PreferredSize(
                preferredSize: const Size.fromHeight(2),
                child: LinearProgressIndicator(
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation<Color>(
                    theme.colorScheme.primary,
                  ),
                ),
              )
            : null,
      ),
      body: Column(
        children: [
          Expanded(
            child: state.messages.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          state.endpoint.icon,
                          size: 64,
                          color: theme.colorScheme.outline,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Start a conversation',
                          style: theme.textTheme.titleLarge?.copyWith(
                            color: theme.colorScheme.outline,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Send a message to begin',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.outline,
                          ),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    itemCount: state.messages.length,
                    itemBuilder: (context, index) {
                      final reversedIndex = state.messages.length - 1 - index;
                      return ChatMessageWidget(
                        message: state.messages[reversedIndex],
                      );
                    },
                  ),
          ),
          ChatInputWidget(
            onSendMessage: state.sendMessage,
            isEnabled: !state.isLoading,
          ),
        ],
      ),
    );
  }

  IconData _getConnectionIcon(ConnectionStatus status) {
    switch (status) {
      case ConnectionStatus.connected:
        return Icons.check_circle;
      case ConnectionStatus.connecting:
        return Icons.sync;
      case ConnectionStatus.error:
        return Icons.error;
      case ConnectionStatus.disconnected:
        return Icons.circle_outlined;
    }
  }

  Color _getConnectionColor(ConnectionStatus status, ThemeData theme) {
    switch (status) {
      case ConnectionStatus.connected:
        return Colors.green;
      case ConnectionStatus.connecting:
        return theme.colorScheme.primary;
      case ConnectionStatus.error:
        return theme.colorScheme.error;
      case ConnectionStatus.disconnected:
        return theme.colorScheme.outline;
    }
  }
}

class ChatPageState extends ChangeNotifier {
  final EndpointConfig endpoint;
  final AgUiService _service;
  final List<ChatMessage> _messages = [];
  bool _isLoading = false;
  bool _disposed = false;
  ConnectionStatus _connectionStatus = ConnectionStatus.disconnected;
  ChatMessage? _currentStreamingMessage;

  ChatPageState({required this.endpoint})
      : _service = AgUiService() {
    _service.connectionStatus.listen((status) {
      _connectionStatus = status;
      notifyListeners();
    });
  }

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get isLoading => _isLoading;
  ConnectionStatus get connectionStatus => _connectionStatus;

  void sendMessage(String text) async {
    if (text.trim().isEmpty) return;

    final userMessage = ChatMessage(
      id: 'user_${DateTime.now().millisecondsSinceEpoch}',
      type: ChatMessageType.user,
      content: text,
      timestamp: DateTime.now(),
    );

    _messages.add(userMessage);
    _isLoading = true;
    notifyListeners();

    try {
      await for (final event in _service.sendMessage(endpoint.path, text)) {
        if (_disposed) break;
        _handleEvent(event);
      }
    } catch (e) {
      if (!_disposed) {
        _messages.add(ChatMessage(
          id: 'error_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.system,
          content: 'Error: ${e.toString()}',
          timestamp: DateTime.now(),
        ));
      }
    } finally {
      if (!_disposed) {
        _isLoading = false;
        _currentStreamingMessage = null;
        notifyListeners();
      }
    }
  }

  void _handleEvent(BaseEvent event) {
    if (event is TextMessageStartEvent) {
      _currentStreamingMessage = ChatMessage(
        id: event.messageId ?? 'assistant_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.assistant,
        content: '',
        timestamp: DateTime.now(),
        isStreaming: true,
      );
      _messages.add(_currentStreamingMessage!);
    } else if (event is TextMessageContentEvent) {
      if (_currentStreamingMessage != null) {
        final index = _messages.indexOf(_currentStreamingMessage!);
        if (index != -1) {
          _currentStreamingMessage = _currentStreamingMessage!.copyWith(
            content: _currentStreamingMessage!.content + event.delta,
          );
          _messages[index] = _currentStreamingMessage!;
        }
      }
    } else if (event is TextMessageEndEvent) {
      if (_currentStreamingMessage != null) {
        final index = _messages.indexOf(_currentStreamingMessage!);
        if (index != -1) {
          _messages[index] = _currentStreamingMessage!.copyWith(
            isStreaming: false,
          );
        }
        _currentStreamingMessage = null;
      }
    } else if (event is ThinkingStartEvent) {
      _messages.add(ChatMessage(
        id: 'thinking_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.thinking,
        content: 'Thinking...',
        timestamp: DateTime.now(),
        isStreaming: true,
      ));
    } else if (event is ThinkingContentEvent) {
      final thinkingMessages = _messages
          .where((m) => m.type == ChatMessageType.thinking && m.isStreaming)
          .toList();
      if (thinkingMessages.isNotEmpty) {
        final lastThinking = thinkingMessages.last;
        final index = _messages.indexOf(lastThinking);
        if (index != -1) {
          _messages[index] = lastThinking.copyWith(
            content: lastThinking.content + event.delta,
          );
        }
      }
    } else if (event is ThinkingEndEvent) {
      final thinkingMessages = _messages
          .where((m) => m.type == ChatMessageType.thinking && m.isStreaming)
          .toList();
      if (thinkingMessages.isNotEmpty) {
        final lastThinking = thinkingMessages.last;
        final index = _messages.indexOf(lastThinking);
        if (index != -1) {
          _messages[index] = lastThinking.copyWith(isStreaming: false);
        }
      }
    } else if (event is ReasoningStartEvent) {
      _messages.add(ChatMessage(
        id: 'reasoning_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.reasoning,
        content: 'Reasoning...',
        timestamp: DateTime.now(),
        isStreaming: true,
      ));
    } else if (event is ReasoningMessageContentEvent) {
      final reasoningMessages = _messages
          .where((m) => m.type == ChatMessageType.reasoning && m.isStreaming)
          .toList();
      if (reasoningMessages.isNotEmpty) {
        final lastReasoning = reasoningMessages.last;
        final index = _messages.indexOf(lastReasoning);
        if (index != -1) {
          _messages[index] = lastReasoning.copyWith(
            content: lastReasoning.content + event.delta,
          );
        }
      }
    } else if (event is ReasoningEndEvent) {
      final reasoningMessages = _messages
          .where((m) => m.type == ChatMessageType.reasoning && m.isStreaming)
          .toList();
      if (reasoningMessages.isNotEmpty) {
        final lastReasoning = reasoningMessages.last;
        final index = _messages.indexOf(lastReasoning);
        if (index != -1) {
          _messages[index] = lastReasoning.copyWith(isStreaming: false);
        }
      }
    } else if (event is ToolCallResultEvent) {
      _messages.add(ChatMessage.fromAssistantEvent(event));
    } else if (event is ToolCallStartEvent) {
      _messages.add(ChatMessage(
        id: event.toolCallId ?? 'tool_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.tool,
        content: '🔧 Calling tool: ${event.toolCallName ?? "Unknown"}',
        timestamp: DateTime.now(),
        isStreaming: true,
        toolName: event.toolCallName,
      ));
    } else if (event is ToolCallArgsEvent) {
      // Update the tool call with arguments
      final toolMessages = _messages
          .where((m) => m.type == ChatMessageType.tool && m.id == event.toolCallId && m.isStreaming)
          .toList();
      if (toolMessages.isNotEmpty) {
        final tool = toolMessages.last;
        final index = _messages.indexOf(tool);
        if (index != -1) {
          final args = event.delta ?? '';
          _messages[index] = tool.copyWith(
            content: tool.content + '\nArguments: $args',
            toolArgs: args,
          );
        }
      }
    } else if (event is ToolCallEndEvent) {
      final toolMessages = _messages
          .where((m) => m.type == ChatMessageType.tool && m.id == event.toolCallId)
          .toList();
      if (toolMessages.isNotEmpty) {
        final tool = toolMessages.last;
        final index = _messages.indexOf(tool);
        if (index != -1) {
          _messages[index] = tool.copyWith(
            content: tool.content + '\n✅ Tool completed',
            isStreaming: false,
          );
        }
      }
    } else if (event is MessagesSnapshotEvent) {
      // Handle messages snapshot - typically contains the full conversation state
      for (final message in event.messages ?? []) {
        if (message is AssistantMessage) {
          final hasToolCalls = (message.toolCalls?.isNotEmpty ?? false);
          final content = message.content ??
              (hasToolCalls ? '🤖 Assistant used tools to generate response' : 'Response generated');

          _messages.add(ChatMessage(
            id: message.id ?? 'assistant_${DateTime.now().millisecondsSinceEpoch}',
            type: ChatMessageType.assistant,
            content: content,
            timestamp: DateTime.now(),
          ));

          // Add tool calls if present
          if (hasToolCalls) {
            for (final toolCall in message.toolCalls ?? []) {
              _messages.add(ChatMessage(
                id: toolCall.id ?? 'tool_${DateTime.now().millisecondsSinceEpoch}',
                type: ChatMessageType.tool,
                content: '⚡ Tool: ${toolCall.function?.name ?? "Unknown"}\n${toolCall.function?.arguments ?? ""}',
                timestamp: DateTime.now(),
                toolName: toolCall.function?.name,
                toolArgs: toolCall.function?.arguments,
              ));
            }
          }
        } else if (message is ReasoningMessage) {
          final text = message.content ?? message.thinking ?? '';
          if (text.isNotEmpty) {
            _messages.add(ChatMessage(
              id: message.id ?? 'reasoning_${DateTime.now().millisecondsSinceEpoch}',
              type: ChatMessageType.reasoning,
              content: text,
              timestamp: DateTime.now(),
            ));
          }
        }
      }
    } else if (event is CustomEvent && event.name == 'image_generated') {
      final value = event.value as Map<String, dynamic>?;
      final url = value?['url'] as String?;
      if (url != null && url.isNotEmpty) {
        _messages.add(ChatMessage(
          id: 'image_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.image,
          content: url,
          timestamp: DateTime.now(),
        ));
      }
    } else if (event is StateSnapshotEvent) {
      final snapshot = event.snapshot;
      if (snapshot != null && snapshot is Map) {
        if (snapshot.containsKey('steps') || snapshot.containsKey('content')) {
          String stateContent = '📊 UI State Generated:\n';
          if (snapshot.containsKey('steps') && snapshot['steps'] is List) {
            final steps = snapshot['steps'] as List;
            stateContent += 'Progress Steps:\n';
            for (int i = 0; i < steps.length; i++) {
              final step = steps[i];
              if (step is Map) {
                final description = step['description'] ?? 'Step ${i + 1}';
                final status = step['status'] ?? 'pending';
                final statusIcon = status == 'completed' ? '✅' :
                                   status == 'in_progress' ? '🔄' :
                                   status == 'enabled' ? '⚡' : '⏳';
                stateContent += '  $statusIcon $description\n';
              }
            }
          } else {
            stateContent += snapshot['content'].toString();
          }
          _messages.add(ChatMessage(
            id: 'state_${DateTime.now().millisecondsSinceEpoch}',
            type: ChatMessageType.system,
            content: stateContent,
            timestamp: DateTime.now(),
          ));
        }
        // Unknown snapshot shapes (e.g. image-gen {status, prompt}) are silently ignored.
      }
    } else if (event is StateDeltaEvent) {
      // Handle state delta updates
      final delta = event.delta;
      if (delta != null && delta is List && delta.isNotEmpty) {
        // Find the last state message to update
        final stateMessages = _messages
            .where((m) => m.type == ChatMessageType.system && m.content.startsWith('📊'))
            .toList();

        if (stateMessages.isNotEmpty) {
          final lastState = stateMessages.last;
          final index = _messages.indexOf(lastState);

          // Apply JSON patch operations to show what changed
          String updateInfo = '';
          for (final op in delta) {
            if (op is Map) {
              final operation = op['op'] ?? '';
              final path = op['path'] ?? '';
              final value = op['value'];

              if (operation == 'replace' && path.contains('/status')) {
                // Extract step number from path like "/steps/0/status"
                final stepMatch = RegExp(r'/steps/(\d+)/status').firstMatch(path);
                if (stepMatch != null) {
                  final stepNum = int.parse(stepMatch.group(1)!) + 1;
                  final statusIcon = value == 'completed' ? '✅' :
                                   value == 'in_progress' ? '🔄' :
                                   value == 'enabled' ? '⚡' : '⏳';
                  updateInfo += '\n  $statusIcon Step $stepNum → $value';
                }
              }
            }
          }

          if (updateInfo.isNotEmpty && index != -1) {
            _messages[index] = lastState.copyWith(
              content: lastState.content + updateInfo,
            );
          }
        }
      }
    } else if (event is RunStartedEvent || event is RunFinishedEvent) {
      // These are lifecycle events, we can ignore them or show status
    } else if (event is TextMessageChunkEvent) {
      // Handle chunk events similar to content events
      if (_currentStreamingMessage == null) {
        _currentStreamingMessage = ChatMessage(
          id: event.messageId ?? 'assistant_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.assistant,
          content: event.delta ?? '',
          timestamp: DateTime.now(),
          isStreaming: true,
        );
        _messages.add(_currentStreamingMessage!);
      } else {
        final index = _messages.indexOf(_currentStreamingMessage!);
        if (index != -1) {
          _currentStreamingMessage = _currentStreamingMessage!.copyWith(
            content: _currentStreamingMessage!.content + (event.delta ?? ''),
          );
          _messages[index] = _currentStreamingMessage!;
        }
      }
    }

    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _service.dispose();
    super.dispose();
  }
}

class MultimodalChatPageState extends ChatPageState {
  Uint8List? _pickedBytes;
  String?    _pickedFileName;
  String?    _pickedMimeType;

  MultimodalChatPageState({required super.endpoint});

  Uint8List? get pickedBytes    => _pickedBytes;
  String?    get pickedFileName => _pickedFileName;
  String?    get pickedMimeType => _pickedMimeType;
  bool       get hasFile        => _pickedBytes != null;

  Future<void> pickFile(
    List<String> allowedExtensions,
    BuildContext context,
  ) async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: allowedExtensions,
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;
    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null) return;

    const maxBytes = 5 * 1024 * 1024;
    if (bytes.length > maxBytes) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('File too large — pick a file under 5 MB')),
        );
      }
      return;
    }

    _pickedBytes    = bytes;
    _pickedFileName = file.name;
    _pickedMimeType = _mimeTypeFor(file.extension ?? '');
    notifyListeners();
  }

  void clearPicked() {
    _pickedBytes    = null;
    _pickedFileName = null;
    _pickedMimeType = null;
    notifyListeners();
  }

  void sendMultimodal(String questionText) async {
    if (_pickedBytes == null) return;
    if (_isLoading)           return;

    final bytes    = _pickedBytes!;
    final mime     = _pickedMimeType ?? 'application/octet-stream';
    final fileName = _pickedFileName ?? 'file';
    final b64      = base64Encode(bytes);
    final source   = DataSource(value: b64, mimeType: mime);

    final List<InputContent> parts;
    switch (endpoint.path) {
      case 'vision':
        parts = [
          ImageInputContent(source: source),
          if (questionText.trim().isNotEmpty) TextInputContent(questionText.trim()),
        ];
      case 'audio':
        parts = [AudioInputContent(source: source)];
      case 'document':
        parts = [
          DocumentInputContent(source: source),
          if (questionText.trim().isNotEmpty) TextInputContent(questionText.trim()),
        ];
      default:
        parts = [ImageInputContent(source: source)];
    }

    switch (endpoint.path) {
      case 'vision':
        _messages.add(ChatMessage(
          id: 'attachment_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.imageAttachment,
          content: fileName,
          imageBytes: bytes,
          timestamp: DateTime.now(),
        ));
      case 'audio':
        _messages.add(ChatMessage(
          id: 'attachment_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.audioAttachment,
          content: fileName,
          fileName: fileName,
          timestamp: DateTime.now(),
        ));
      case 'document':
        _messages.add(ChatMessage(
          id: 'attachment_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.documentAttachment,
          content: fileName,
          fileName: fileName,
          timestamp: DateTime.now(),
        ));
    }

    _isLoading = true;
    clearPicked();
    notifyListeners();

    try {
      await for (final event in _service.sendMultimodalMessage(endpoint.path, parts)) {
        if (_disposed) break;
        _handleEvent(event);
      }
    } catch (e) {
      if (!_disposed) {
        _messages.add(ChatMessage(
          id: 'error_${DateTime.now().millisecondsSinceEpoch}',
          type: ChatMessageType.system,
          content: 'Error: ${e.toString()}',
          timestamp: DateTime.now(),
        ));
      }
    } finally {
      if (!_disposed) {
        _isLoading = false;
        _currentStreamingMessage = null;
        notifyListeners();
      }
    }
  }

  static String _mimeTypeFor(String ext) => const {
    'jpg':  'image/jpeg',
    'jpeg': 'image/jpeg',
    'png':  'image/png',
    'gif':  'image/gif',
    'webp': 'image/webp',
    'mp3':  'audio/mpeg',
    'wav':  'audio/wav',
    'm4a':  'audio/mp4',
    'ogg':  'audio/ogg',
    'webm': 'audio/webm',
    'pdf':  'application/pdf',
  }[ext.toLowerCase()] ?? 'application/octet-stream';
}