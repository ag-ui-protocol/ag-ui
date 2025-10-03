/// Context and run types for AG-UI protocol.
library;

import 'base.dart';
import 'message.dart';
import 'tool.dart';

/// Additional context for the agent
class Context extends AGUIModel {
  final String description;
  final String value;

  const Context({
    required this.description,
    required this.value,
  });

  factory Context.fromJson(Map<String, dynamic> json) {
    return Context(
      description: JsonDecoder.requireField<String>(json, 'description'),
      value: JsonDecoder.requireField<String>(json, 'value'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'description': description,
    'value': value,
  };

  @override
  Context copyWith({
    String? description,
    String? value,
  }) {
    return Context(
      description: description ?? this.description,
      value: value ?? this.value,
    );
  }
}

/// Input for running an agent
class RunAgentInput extends AGUIModel {
  final String threadId;
  final String runId;
  final dynamic state;
  final List<Message> messages;
  final List<Tool> tools;
  final List<Context> context;
  final dynamic forwardedProps;

  const RunAgentInput({
    required this.threadId,
    required this.runId,
    this.state,
    required this.messages,
    required this.tools,
    required this.context,
    this.forwardedProps,
  });

  factory RunAgentInput.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final threadId = JsonDecoder.optionalField<String>(json, 'threadId') ??
        JsonDecoder.optionalField<String>(json, 'thread_id');
    final runId = JsonDecoder.optionalField<String>(json, 'runId') ??
        JsonDecoder.optionalField<String>(json, 'run_id');
    
    if (threadId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: threadId or thread_id',
        field: 'threadId',
        json: json,
      );
    }
    if (runId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: runId or run_id',
        field: 'runId',
        json: json,
      );
    }
    
    return RunAgentInput(
      threadId: threadId,
      runId: runId,
      state: json['state'],
      messages: JsonDecoder.requireListField<Map<String, dynamic>>(
        json,
        'messages',
      ).map((item) => Message.fromJson(item)).toList(),
      tools: JsonDecoder.requireListField<Map<String, dynamic>>(
        json,
        'tools',
      ).map((item) => Tool.fromJson(item)).toList(),
      context: JsonDecoder.requireListField<Map<String, dynamic>>(
        json,
        'context',
      ).map((item) => Context.fromJson(item)).toList(),
      forwardedProps: json['forwardedProps'] ?? json['forwarded_props'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'threadId': threadId,
    'runId': runId,
    if (state != null) 'state': state,
    'messages': messages.map((m) => m.toJson()).toList(),
    'tools': tools.map((t) => t.toJson()).toList(),
    'context': context.map((c) => c.toJson()).toList(),
    if (forwardedProps != null) 'forwardedProps': forwardedProps,
  };

  @override
  RunAgentInput copyWith({
    String? threadId,
    String? runId,
    dynamic state,
    List<Message>? messages,
    List<Tool>? tools,
    List<Context>? context,
    dynamic forwardedProps,
  }) {
    return RunAgentInput(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      state: state ?? this.state,
      messages: messages ?? this.messages,
      tools: tools ?? this.tools,
      context: context ?? this.context,
      forwardedProps: forwardedProps ?? this.forwardedProps,
    );
  }
}

/// Represents a run in the AG-UI protocol
class Run extends AGUIModel {
  final String threadId;
  final String runId;
  final dynamic result;

  const Run({
    required this.threadId,
    required this.runId,
    this.result,
  });

  factory Run.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final threadId = JsonDecoder.optionalField<String>(json, 'threadId') ??
        JsonDecoder.optionalField<String>(json, 'thread_id');
    final runId = JsonDecoder.optionalField<String>(json, 'runId') ??
        JsonDecoder.optionalField<String>(json, 'run_id');
    
    if (threadId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: threadId or thread_id',
        field: 'threadId',
        json: json,
      );
    }
    if (runId == null) {
      throw AGUIValidationError(
        message: 'Missing required field: runId or run_id',
        field: 'runId',
        json: json,
      );
    }
    
    return Run(
      threadId: threadId,
      runId: runId,
      result: json['result'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    'threadId': threadId,
    'runId': runId,
    if (result != null) 'result': result,
  };

  @override
  Run copyWith({
    String? threadId,
    String? runId,
    dynamic result,
  }) {
    return Run(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      result: result ?? this.result,
    );
  }
}

/// Type alias for state (can be any type)
typedef State = dynamic;