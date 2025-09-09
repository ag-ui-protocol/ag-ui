/// Message types for AG-UI protocol.
library;

import 'base.dart';
import 'tool.dart';

/// Role types for messages
enum MessageRole {
  developer('developer'),
  system('system'),
  assistant('assistant'),
  user('user'),
  tool('tool');

  final String value;
  const MessageRole(this.value);

  static MessageRole fromString(String value) {
    return MessageRole.values.firstWhere(
      (role) => role.value == value,
      orElse: () => throw AGUIValidationError(
        message: 'Invalid message role: $value',
        field: 'role',
        value: value,
      ),
    );
  }
}

/// Base message class for all message types
sealed class Message extends AGUIModel with TypeDiscriminator {
  final String id;
  final MessageRole role;
  final String? content;
  final String? name;

  const Message({
    required this.id,
    required this.role,
    this.content,
    this.name,
  });

  @override
  String get type => role.value;

  /// Factory constructor to create specific message types from JSON
  factory Message.fromJson(Map<String, dynamic> json) {
    final roleStr = JsonDecoder.requireField<String>(json, 'role');
    final role = MessageRole.fromString(roleStr);

    switch (role) {
      case MessageRole.developer:
        return DeveloperMessage.fromJson(json);
      case MessageRole.system:
        return SystemMessage.fromJson(json);
      case MessageRole.assistant:
        return AssistantMessage.fromJson(json);
      case MessageRole.user:
        return UserMessage.fromJson(json);
      case MessageRole.tool:
        return ToolMessage.fromJson(json);
    }
  }

  @override
  Map<String, dynamic> toJson() => {
    'id': id,
    'role': role.value,
    if (content != null) 'content': content,
    if (name != null) 'name': name,
  };
}

/// Developer message with required content
class DeveloperMessage extends Message {
  @override
  final String content;

  const DeveloperMessage({
    required super.id,
    required this.content,
    super.name,
  }) : super(role: MessageRole.developer);

  factory DeveloperMessage.fromJson(Map<String, dynamic> json) {
    return DeveloperMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
    );
  }

  @override
  DeveloperMessage copyWith({
    String? id,
    String? content,
    String? name,
  }) {
    return DeveloperMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: name ?? this.name,
    );
  }
}

/// System message with required content
class SystemMessage extends Message {
  @override
  final String content;

  const SystemMessage({
    required super.id,
    required this.content,
    super.name,
  }) : super(role: MessageRole.system);

  factory SystemMessage.fromJson(Map<String, dynamic> json) {
    return SystemMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
    );
  }

  @override
  SystemMessage copyWith({
    String? id,
    String? content,
    String? name,
  }) {
    return SystemMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: name ?? this.name,
    );
  }
}

/// Assistant message with optional content and tool calls
class AssistantMessage extends Message {
  final List<ToolCall>? toolCalls;

  const AssistantMessage({
    required super.id,
    super.content,
    super.name,
    this.toolCalls,
  }) : super(role: MessageRole.assistant);

  factory AssistantMessage.fromJson(Map<String, dynamic> json) {
    return AssistantMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.optionalField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      toolCalls: JsonDecoder.optionalListField<Map<String, dynamic>>(
        json,
        'toolCalls',
      )?.map((item) => ToolCall.fromJson(item)).toList() ??
        JsonDecoder.optionalListField<Map<String, dynamic>>(
          json,
          'tool_calls',
        )?.map((item) => ToolCall.fromJson(item)).toList(),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    if (toolCalls != null && toolCalls!.isNotEmpty) 
      'toolCalls': toolCalls!.map((tc) => tc.toJson()).toList(),
  };

  @override
  AssistantMessage copyWith({
    String? id,
    String? content,
    String? name,
    List<ToolCall>? toolCalls,
  }) {
    return AssistantMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: name ?? this.name,
      toolCalls: toolCalls ?? this.toolCalls,
    );
  }
}

/// User message with required content
class UserMessage extends Message {
  @override
  final String content;

  const UserMessage({
    required super.id,
    required this.content,
    super.name,
  }) : super(role: MessageRole.user);

  factory UserMessage.fromJson(Map<String, dynamic> json) {
    return UserMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
    );
  }

  @override
  UserMessage copyWith({
    String? id,
    String? content,
    String? name,
  }) {
    return UserMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: name ?? this.name,
    );
  }
}

/// Tool message with tool call result
class ToolMessage extends Message {
  @override
  final String content;
  final String toolCallId;
  final String? error;

  const ToolMessage({
    required super.id,
    required this.content,
    required this.toolCallId,
    this.error,
  }) : super(role: MessageRole.tool);

  factory ToolMessage.fromJson(Map<String, dynamic> json) {
    final toolCallId = JsonDecoder.optionalField<String>(json, 'toolCallId') ??
        JsonDecoder.optionalField<String>(json, 'tool_call_id');
    
    if (toolCallId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: toolCallId or tool_call_id',
        field: 'toolCallId',
        json: json,
      );
    }
    
    return ToolMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      toolCallId: toolCallId,
      error: JsonDecoder.optionalField<String>(json, 'error'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'toolCallId': toolCallId,
    if (error != null) 'error': error,
  };

  @override
  ToolMessage copyWith({
    String? id,
    String? content,
    String? toolCallId,
    String? error,
  }) {
    return ToolMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      toolCallId: toolCallId ?? this.toolCallId,
      error: error ?? this.error,
    );
  }
}