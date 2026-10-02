import 'dart:typed_data';
import 'package:ag_ui/ag_ui.dart';

enum ChatMessageType {
  user,
  assistant,
  system,
  tool,
  thinking,
  image,
  imageAttachment,
  audioAttachment,
  documentAttachment,
  reasoning,
  card,
}

class ChatMessage {
  final String id;
  final ChatMessageType type;
  final String content;
  final DateTime timestamp;
  final bool isStreaming;
  final String? toolName;
  final dynamic toolArgs;
  final dynamic toolResult;
  final String? fileName;
  final Uint8List? imageBytes;

  /// Parsed arguments for a `card` message (tool_based_generative_ui render_card),
  /// or the proposed-call args for an `approval` message (human_in_the_loop).
  final Map<String, dynamic>? cardData;

  ChatMessage({
    required this.id,
    required this.type,
    required this.content,
    required this.timestamp,
    this.isStreaming = false,
    this.toolName,
    this.toolArgs,
    this.toolResult,
    this.fileName,
    this.imageBytes,
    this.cardData,
  });

  ChatMessage copyWith({
    String? id,
    ChatMessageType? type,
    String? content,
    DateTime? timestamp,
    bool? isStreaming,
    String? toolName,
    dynamic toolArgs,
    dynamic toolResult,
    String? fileName,
    Uint8List? imageBytes,
    Map<String, dynamic>? cardData,
  }) {
    return ChatMessage(
      id: id ?? this.id,
      type: type ?? this.type,
      content: content ?? this.content,
      timestamp: timestamp ?? this.timestamp,
      isStreaming: isStreaming ?? this.isStreaming,
      toolName: toolName ?? this.toolName,
      toolArgs: toolArgs ?? this.toolArgs,
      toolResult: toolResult ?? this.toolResult,
      fileName: fileName ?? this.fileName,
      imageBytes: imageBytes ?? this.imageBytes,
      cardData: cardData ?? this.cardData,
    );
  }

  static ChatMessage fromUserMessage(UserMessage message) {
    return ChatMessage(
      id: message.id ?? 'user_${DateTime.now().millisecondsSinceEpoch}',
      type: ChatMessageType.user,
      content: message.content ?? '',
      timestamp: DateTime.now(),
    );
  }

  static ChatMessage fromAssistantEvent(BaseEvent event) {
    final timestamp = event.timestamp != null
        ? DateTime.fromMillisecondsSinceEpoch(event.timestamp!)
        : DateTime.now();

    if (event is TextMessageContentEvent) {
      return ChatMessage(
        id: 'assistant_${event.timestamp ?? DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.assistant,
        content: event.delta,
        timestamp: timestamp,
        isStreaming: true,
      );
    } else if (event is TextMessageEndEvent) {
      return ChatMessage(
        id: event.messageId ?? 'assistant_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.assistant,
        content: '',
        timestamp: timestamp,
        isStreaming: false,
      );
    } else if (event is ThinkingContentEvent) {
      return ChatMessage(
        id: 'thinking_${event.timestamp ?? DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.thinking,
        content: event.delta,
        timestamp: timestamp,
        isStreaming: true,
      );
    } else if (event is ToolCallResultEvent) {
      return ChatMessage(
        id: event.toolCallId ?? 'tool_${DateTime.now().millisecondsSinceEpoch}',
        type: ChatMessageType.tool,
        content: 'Tool Result',
        timestamp: timestamp,
        toolName: 'Tool',
        toolResult: event.content,
      );
    }

    return ChatMessage(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      type: ChatMessageType.system,
      content: 'Unknown event type: ${event.eventType.value}',
      timestamp: timestamp,
    );
  }
}