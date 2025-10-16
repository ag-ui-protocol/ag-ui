/// Tool-related types for AG-UI protocol.
///
/// This library defines types for tool interactions, including tool calls
/// from the assistant and tool definitions.
library;

import 'base.dart';

/// Represents a function call within a tool call.
///
/// Contains the function name and serialized arguments for execution.
class FunctionCall extends AGUIModel {
  final String name;
  final String arguments;

  const FunctionCall({
    required this.name,
    required this.arguments,
  });

  factory FunctionCall.fromJson(Map<String, dynamic> json) {
    return FunctionCall(
      name: JsonDecoder.requireField<String>(json, 'name'),
      arguments: JsonDecoder.requireField<String>(json, 'arguments'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'name': name,
    'arguments': arguments,
  };

  @override
  FunctionCall copyWith({
    String? name,
    String? arguments,
  }) {
    return FunctionCall(
      name: name ?? this.name,
      arguments: arguments ?? this.arguments,
    );
  }
}

/// Represents a tool call made by the assistant.
///
/// Tool calls allow the assistant to request execution of external functions
/// or tools to gather information or perform actions.
class ToolCall extends AGUIModel {
  final String id;
  final String type;
  final FunctionCall function;

  const ToolCall({
    required this.id,
    this.type = 'function',
    required this.function,
  });

  factory ToolCall.fromJson(Map<String, dynamic> json) {
    return ToolCall(
      id: JsonDecoder.requireField<String>(json, 'id'),
      type: JsonDecoder.optionalField<String>(json, 'type') ?? 'function',
      function: FunctionCall.fromJson(
        JsonDecoder.requireField<Map<String, dynamic>>(json, 'function'),
      ),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type,
    'function': function.toJson(),
  };

  @override
  ToolCall copyWith({
    String? id,
    String? type,
    FunctionCall? function,
  }) {
    return ToolCall(
      id: id ?? this.id,
      type: type ?? this.type,
      function: function ?? this.function,
    );
  }
}

/// Represents a tool definition.
///
/// Defines a tool that can be called by the assistant, including its
/// name, description, and parameter schema.
class Tool extends AGUIModel {
  final String name;
  final String description;
  final dynamic parameters; // JSON Schema for the tool parameters

  const Tool({
    required this.name,
    required this.description,
    this.parameters,
  });

  factory Tool.fromJson(Map<String, dynamic> json) {
    return Tool(
      name: JsonDecoder.requireField<String>(json, 'name'),
      description: JsonDecoder.requireField<String>(json, 'description'),
      parameters: json['parameters'], // Allow any JSON Schema
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'name': name,
    'description': description,
    if (parameters != null) 'parameters': parameters,
  };

  @override
  Tool copyWith({
    String? name,
    String? description,
    dynamic parameters,
  }) {
    return Tool(
      name: name ?? this.name,
      description: description ?? this.description,
      parameters: parameters ?? this.parameters,
    );
  }
}

/// Represents the result of a tool call
class ToolResult extends AGUIModel {
  final String toolCallId;
  final String content;
  final String? error;

  const ToolResult({
    required this.toolCallId,
    required this.content,
    this.error,
  });

  factory ToolResult.fromJson(Map<String, dynamic> json) {
    final toolCallId = JsonDecoder.optionalField<String>(json, 'toolCallId') ??
        JsonDecoder.optionalField<String>(json, 'tool_call_id');
    
    if (toolCallId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: toolCallId or tool_call_id',
        field: 'toolCallId',
        json: json,
      );
    }
    
    return ToolResult(
      toolCallId: toolCallId,
      content: JsonDecoder.requireField<String>(json, 'content'),
      error: JsonDecoder.optionalField<String>(json, 'error'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'toolCallId': toolCallId,
    'content': content,
    if (error != null) 'error': error,
  };

  @override
  ToolResult copyWith({
    String? toolCallId,
    String? content,
    String? error,
  }) {
    return ToolResult(
      toolCallId: toolCallId ?? this.toolCallId,
      content: content ?? this.content,
      error: error ?? this.error,
    );
  }
}