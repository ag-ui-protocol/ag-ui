/// All event types for AG-UI protocol.
///
/// This library defines all event types used in the AG-UI protocol for
/// streaming agent responses and state updates.
///
/// Note: All event classes are in a single file because Dart's sealed classes
/// can only be extended within the same library.
library;

import '../types/base.dart';
import '../types/message.dart';
import '../types/context.dart';
import 'event_type.dart';

export 'event_type.dart';

/// Base event for all AG-UI protocol events.
///
/// All protocol events extend this class and are identified by their
/// [eventType]. Use the [BaseEvent.fromJson] factory to deserialize
/// events from JSON.
sealed class BaseEvent extends AGUIModel with TypeDiscriminator {
  final EventType eventType;
  final int? timestamp;
  final dynamic rawEvent;

  const BaseEvent({
    required this.eventType,
    this.timestamp,
    this.rawEvent,
  });

  @override
  String get type => eventType.value;

  /// Factory constructor to create specific event types from JSON
  factory BaseEvent.fromJson(Map<String, dynamic> json) {
    final typeStr = JsonDecoder.requireField<String>(json, 'type');
    final eventType = EventType.fromString(typeStr);

    switch (eventType) {
      case EventType.textMessageStart:
        return TextMessageStartEvent.fromJson(json);
      case EventType.textMessageContent:
        return TextMessageContentEvent.fromJson(json);
      case EventType.textMessageEnd:
        return TextMessageEndEvent.fromJson(json);
      case EventType.textMessageChunk:
        return TextMessageChunkEvent.fromJson(json);
      case EventType.thinkingTextMessageStart:
        return ThinkingTextMessageStartEvent.fromJson(json);
      case EventType.thinkingTextMessageContent:
        return ThinkingTextMessageContentEvent.fromJson(json);
      case EventType.thinkingTextMessageEnd:
        return ThinkingTextMessageEndEvent.fromJson(json);
      case EventType.toolCallStart:
        return ToolCallStartEvent.fromJson(json);
      case EventType.toolCallArgs:
        return ToolCallArgsEvent.fromJson(json);
      case EventType.toolCallEnd:
        return ToolCallEndEvent.fromJson(json);
      case EventType.toolCallChunk:
        return ToolCallChunkEvent.fromJson(json);
      case EventType.toolCallResult:
        return ToolCallResultEvent.fromJson(json);
      case EventType.thinkingStart:
        return ThinkingStartEvent.fromJson(json);
      case EventType.thinkingContent:
        return ThinkingContentEvent.fromJson(json);
      case EventType.thinkingEnd:
        return ThinkingEndEvent.fromJson(json);
      case EventType.stateSnapshot:
        return StateSnapshotEvent.fromJson(json);
      case EventType.stateDelta:
        return StateDeltaEvent.fromJson(json);
      case EventType.messagesSnapshot:
        return MessagesSnapshotEvent.fromJson(json);
      case EventType.raw:
        return RawEvent.fromJson(json);
      case EventType.custom:
        return CustomEvent.fromJson(json);
      case EventType.runStarted:
        return RunStartedEvent.fromJson(json);
      case EventType.runFinished:
        return RunFinishedEvent.fromJson(json);
      case EventType.runError:
        return RunErrorEvent.fromJson(json);
      case EventType.stepStarted:
        return StepStartedEvent.fromJson(json);
      case EventType.stepFinished:
        return StepFinishedEvent.fromJson(json);
    }
  }

  @override
  Map<String, dynamic> toJson() => {
    'type': eventType.value,
    if (timestamp != null) 'timestamp': timestamp,
    if (rawEvent != null) 'rawEvent': rawEvent,
  };
}

/// Text message roles that can be used in text message events.
///
/// Defines the possible roles for text messages in the protocol.
enum TextMessageRole {
  developer('developer'),
  system('system'),
  assistant('assistant'),
  user('user');

  final String value;
  const TextMessageRole(this.value);

  static TextMessageRole fromString(String value) {
    return TextMessageRole.values.firstWhere(
      (role) => role.value == value,
      orElse: () => TextMessageRole.assistant,
    );
  }
}

// ============================================================================
// Text Message Events
// ============================================================================

/// Event indicating the start of a text message
final class TextMessageStartEvent extends BaseEvent {
  final String messageId;
  final TextMessageRole role;

  const TextMessageStartEvent({
    required this.messageId,
    this.role = TextMessageRole.assistant,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageStart);

  factory TextMessageStartEvent.fromJson(Map<String, dynamic> json) {
    return TextMessageStartEvent(
      messageId: JsonDecoder.requireField<String>(json, 'messageId'),
      role: TextMessageRole.fromString(
        JsonDecoder.optionalField<String>(json, 'role') ?? 'assistant',
      ),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'messageId': messageId,
    'role': role.value,
  };

  @override
  TextMessageStartEvent copyWith({
    String? messageId,
    TextMessageRole? role,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageStartEvent(
      messageId: messageId ?? this.messageId,
      role: role ?? this.role,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing text message content
final class TextMessageContentEvent extends BaseEvent {
  final String messageId;
  final String delta;

  const TextMessageContentEvent({
    required this.messageId,
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageContent);

  factory TextMessageContentEvent.fromJson(Map<String, dynamic> json) {
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    if (delta.isEmpty) {
      throw AGUIValidationError(
        message: 'Delta must not be an empty string',
        field: 'delta',
        value: delta,
        json: json,
      );
    }
    
    return TextMessageContentEvent(
      messageId: JsonDecoder.requireField<String>(json, 'messageId'),
      delta: delta,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'messageId': messageId,
    'delta': delta,
  };

  @override
  TextMessageContentEvent copyWith({
    String? messageId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageContentEvent(
      messageId: messageId ?? this.messageId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a text message
final class TextMessageEndEvent extends BaseEvent {
  final String messageId;

  const TextMessageEndEvent({
    required this.messageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageEnd);

  factory TextMessageEndEvent.fromJson(Map<String, dynamic> json) {
    return TextMessageEndEvent(
      messageId: JsonDecoder.requireField<String>(json, 'messageId'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'messageId': messageId,
  };

  @override
  TextMessageEndEvent copyWith({
    String? messageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageEndEvent(
      messageId: messageId ?? this.messageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a chunk of text message content
final class TextMessageChunkEvent extends BaseEvent {
  final String? messageId;
  final TextMessageRole? role;
  final String? delta;

  const TextMessageChunkEvent({
    this.messageId,
    this.role,
    this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageChunk);

  factory TextMessageChunkEvent.fromJson(Map<String, dynamic> json) {
    final roleStr = JsonDecoder.optionalField<String>(json, 'role');
    return TextMessageChunkEvent(
      messageId: JsonDecoder.optionalField<String>(json, 'messageId'),
      role: roleStr != null ? TextMessageRole.fromString(roleStr) : null,
      delta: JsonDecoder.optionalField<String>(json, 'delta'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    if (messageId != null) 'messageId': messageId,
    if (role != null) 'role': role!.value,
    if (delta != null) 'delta': delta,
  };

  @override
  TextMessageChunkEvent copyWith({
    String? messageId,
    TextMessageRole? role,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageChunkEvent(
      messageId: messageId ?? this.messageId,
      role: role ?? this.role,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Thinking Events
// ============================================================================

/// Event indicating the start of a thinking section
final class ThinkingStartEvent extends BaseEvent {
  final String? title;

  const ThinkingStartEvent({
    this.title,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingStart);

  factory ThinkingStartEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingStartEvent(
      title: JsonDecoder.optionalField<String>(json, 'title'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    if (title != null) 'title': title,
  };

  @override
  ThinkingStartEvent copyWith({
    String? title,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingStartEvent(
      title: title ?? this.title,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing thinking content
final class ThinkingContentEvent extends BaseEvent {
  final String delta;

  const ThinkingContentEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingContent);

  factory ThinkingContentEvent.fromJson(Map<String, dynamic> json) {
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    if (delta.isEmpty) {
      throw AGUIValidationError(
        message: 'Delta must not be an empty string',
        field: 'delta',
        value: delta,
        json: json,
      );
    }
    
    return ThinkingContentEvent(
      delta: delta,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'delta': delta,
  };

  @override
  ThinkingContentEvent copyWith({
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingContentEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a thinking section
final class ThinkingEndEvent extends BaseEvent {
  const ThinkingEndEvent({
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingEnd);

  factory ThinkingEndEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingEndEvent(
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  ThinkingEndEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingEndEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the start of a thinking text message
final class ThinkingTextMessageStartEvent extends BaseEvent {
  const ThinkingTextMessageStartEvent({
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingTextMessageStart);

  factory ThinkingTextMessageStartEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingTextMessageStartEvent(
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  ThinkingTextMessageStartEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageStartEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing thinking text message content
final class ThinkingTextMessageContentEvent extends BaseEvent {
  final String delta;

  const ThinkingTextMessageContentEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingTextMessageContent);

  factory ThinkingTextMessageContentEvent.fromJson(Map<String, dynamic> json) {
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    if (delta.isEmpty) {
      throw AGUIValidationError(
        message: 'Delta must not be an empty string',
        field: 'delta',
        value: delta,
        json: json,
      );
    }
    
    return ThinkingTextMessageContentEvent(
      delta: delta,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'delta': delta,
  };

  @override
  ThinkingTextMessageContentEvent copyWith({
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageContentEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a thinking text message
final class ThinkingTextMessageEndEvent extends BaseEvent {
  const ThinkingTextMessageEndEvent({
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingTextMessageEnd);

  factory ThinkingTextMessageEndEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingTextMessageEndEvent(
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  ThinkingTextMessageEndEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageEndEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Tool Call Events
// ============================================================================

/// Event indicating the start of a tool call
final class ToolCallStartEvent extends BaseEvent {
  final String toolCallId;
  final String toolCallName;
  final String? parentMessageId;

  const ToolCallStartEvent({
    required this.toolCallId,
    required this.toolCallName,
    this.parentMessageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallStart);

  factory ToolCallStartEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallStartEvent(
      toolCallId: JsonDecoder.requireField<String>(json, 'toolCallId'),
      toolCallName: JsonDecoder.requireField<String>(json, 'toolCallName'),
      parentMessageId: JsonDecoder.optionalField<String>(json, 'parentMessageId'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'toolCallId': toolCallId,
    'toolCallName': toolCallName,
    if (parentMessageId != null) 'parentMessageId': parentMessageId,
  };

  @override
  ToolCallStartEvent copyWith({
    String? toolCallId,
    String? toolCallName,
    String? parentMessageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallStartEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      toolCallName: toolCallName ?? this.toolCallName,
      parentMessageId: parentMessageId ?? this.parentMessageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing tool call arguments
final class ToolCallArgsEvent extends BaseEvent {
  final String toolCallId;
  final String delta;

  const ToolCallArgsEvent({
    required this.toolCallId,
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallArgs);

  factory ToolCallArgsEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallArgsEvent(
      toolCallId: JsonDecoder.requireField<String>(json, 'toolCallId'),
      delta: JsonDecoder.requireField<String>(json, 'delta'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'toolCallId': toolCallId,
    'delta': delta,
  };

  @override
  ToolCallArgsEvent copyWith({
    String? toolCallId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallArgsEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a tool call
final class ToolCallEndEvent extends BaseEvent {
  final String toolCallId;

  const ToolCallEndEvent({
    required this.toolCallId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallEnd);

  factory ToolCallEndEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallEndEvent(
      toolCallId: JsonDecoder.requireField<String>(json, 'toolCallId'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'toolCallId': toolCallId,
  };

  @override
  ToolCallEndEvent copyWith({
    String? toolCallId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallEndEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a chunk of tool call content
final class ToolCallChunkEvent extends BaseEvent {
  final String? toolCallId;
  final String? toolCallName;
  final String? parentMessageId;
  final String? delta;

  const ToolCallChunkEvent({
    this.toolCallId,
    this.toolCallName,
    this.parentMessageId,
    this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallChunk);

  factory ToolCallChunkEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallChunkEvent(
      toolCallId: JsonDecoder.optionalField<String>(json, 'toolCallId'),
      toolCallName: JsonDecoder.optionalField<String>(json, 'toolCallName'),
      parentMessageId: JsonDecoder.optionalField<String>(json, 'parentMessageId'),
      delta: JsonDecoder.optionalField<String>(json, 'delta'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    if (toolCallId != null) 'toolCallId': toolCallId,
    if (toolCallName != null) 'toolCallName': toolCallName,
    if (parentMessageId != null) 'parentMessageId': parentMessageId,
    if (delta != null) 'delta': delta,
  };

  @override
  ToolCallChunkEvent copyWith({
    String? toolCallId,
    String? toolCallName,
    String? parentMessageId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallChunkEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      toolCallName: toolCallName ?? this.toolCallName,
      parentMessageId: parentMessageId ?? this.parentMessageId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing the result of a tool call
final class ToolCallResultEvent extends BaseEvent {
  final String messageId;
  final String toolCallId;
  final String content;
  final String? role;

  const ToolCallResultEvent({
    required this.messageId,
    required this.toolCallId,
    required this.content,
    this.role,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallResult);

  factory ToolCallResultEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallResultEvent(
      messageId: JsonDecoder.requireField<String>(json, 'messageId'),
      toolCallId: JsonDecoder.requireField<String>(json, 'toolCallId'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      role: JsonDecoder.optionalField<String>(json, 'role'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'messageId': messageId,
    'toolCallId': toolCallId,
    'content': content,
    if (role != null) 'role': role,
  };

  @override
  ToolCallResultEvent copyWith({
    String? messageId,
    String? toolCallId,
    String? content,
    String? role,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallResultEvent(
      messageId: messageId ?? this.messageId,
      toolCallId: toolCallId ?? this.toolCallId,
      content: content ?? this.content,
      role: role ?? this.role,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// State Events
// ============================================================================

/// Event containing a snapshot of the state
final class StateSnapshotEvent extends BaseEvent {
  final State snapshot;

  const StateSnapshotEvent({
    required this.snapshot,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stateSnapshot);

  factory StateSnapshotEvent.fromJson(Map<String, dynamic> json) {
    return StateSnapshotEvent(
      snapshot: json['snapshot'],
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'snapshot': snapshot,
  };

  @override
  StateSnapshotEvent copyWith({
    State? snapshot,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StateSnapshotEvent(
      snapshot: snapshot ?? this.snapshot,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a delta of the state (JSON Patch RFC 6902)
final class StateDeltaEvent extends BaseEvent {
  final List<dynamic> delta;

  const StateDeltaEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stateDelta);

  factory StateDeltaEvent.fromJson(Map<String, dynamic> json) {
    return StateDeltaEvent(
      delta: JsonDecoder.requireField<List<dynamic>>(json, 'delta'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'delta': delta,
  };

  @override
  StateDeltaEvent copyWith({
    List<dynamic>? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StateDeltaEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a snapshot of messages
final class MessagesSnapshotEvent extends BaseEvent {
  final List<Message> messages;

  const MessagesSnapshotEvent({
    required this.messages,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.messagesSnapshot);

  factory MessagesSnapshotEvent.fromJson(Map<String, dynamic> json) {
    return MessagesSnapshotEvent(
      messages: JsonDecoder.requireListField<Map<String, dynamic>>(
        json,
        'messages',
      ).map((item) => Message.fromJson(item)).toList(),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'messages': messages.map((m) => m.toJson()).toList(),
  };

  @override
  MessagesSnapshotEvent copyWith({
    List<Message>? messages,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return MessagesSnapshotEvent(
      messages: messages ?? this.messages,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a raw event
final class RawEvent extends BaseEvent {
  final dynamic event;
  final String? source;

  const RawEvent({
    required this.event,
    this.source,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.raw);

  factory RawEvent.fromJson(Map<String, dynamic> json) {
    return RawEvent(
      event: json['event'],
      source: JsonDecoder.optionalField<String>(json, 'source'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'event': event,
    if (source != null) 'source': source,
  };

  @override
  RawEvent copyWith({
    dynamic event,
    String? source,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RawEvent(
      event: event ?? this.event,
      source: source ?? this.source,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a custom event
final class CustomEvent extends BaseEvent {
  final String name;
  final dynamic value;

  const CustomEvent({
    required this.name,
    required this.value,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.custom);

  factory CustomEvent.fromJson(Map<String, dynamic> json) {
    return CustomEvent(
      name: JsonDecoder.requireField<String>(json, 'name'),
      value: json['value'],
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'name': name,
    'value': value,
  };

  @override
  CustomEvent copyWith({
    String? name,
    dynamic value,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return CustomEvent(
      name: name ?? this.name,
      value: value ?? this.value,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Lifecycle Events
// ============================================================================

/// Event indicating that a run has started
final class RunStartedEvent extends BaseEvent {
  final String threadId;
  final String runId;

  const RunStartedEvent({
    required this.threadId,
    required this.runId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runStarted);

  factory RunStartedEvent.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final threadId = JsonDecoder.optionalField<String>(json, 'threadId') ??
        JsonDecoder.requireField<String>(json, 'thread_id');
    final runId = JsonDecoder.optionalField<String>(json, 'runId') ??
        JsonDecoder.requireField<String>(json, 'run_id');
    
    return RunStartedEvent(
      threadId: threadId,
      runId: runId,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'threadId': threadId,
    'runId': runId,
  };

  @override
  RunStartedEvent copyWith({
    String? threadId,
    String? runId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RunStartedEvent(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a run has finished
final class RunFinishedEvent extends BaseEvent {
  final String threadId;
  final String runId;
  final dynamic result;

  const RunFinishedEvent({
    required this.threadId,
    required this.runId,
    this.result,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runFinished);

  factory RunFinishedEvent.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final threadId = JsonDecoder.optionalField<String>(json, 'threadId') ??
        JsonDecoder.requireField<String>(json, 'thread_id');
    final runId = JsonDecoder.optionalField<String>(json, 'runId') ??
        JsonDecoder.requireField<String>(json, 'run_id');
    
    return RunFinishedEvent(
      threadId: threadId,
      runId: runId,
      result: json['result'],
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'threadId': threadId,
    'runId': runId,
    if (result != null) 'result': result,
  };

  @override
  RunFinishedEvent copyWith({
    String? threadId,
    String? runId,
    dynamic result,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RunFinishedEvent(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      result: result ?? this.result,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a run has encountered an error
final class RunErrorEvent extends BaseEvent {
  final String message;
  final String? code;

  const RunErrorEvent({
    required this.message,
    this.code,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runError);

  factory RunErrorEvent.fromJson(Map<String, dynamic> json) {
    return RunErrorEvent(
      message: JsonDecoder.requireField<String>(json, 'message'),
      code: JsonDecoder.optionalField<String>(json, 'code'),
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'message': message,
    if (code != null) 'code': code,
  };

  @override
  RunErrorEvent copyWith({
    String? message,
    String? code,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RunErrorEvent(
      message: message ?? this.message,
      code: code ?? this.code,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a step has started
final class StepStartedEvent extends BaseEvent {
  final String stepName;

  const StepStartedEvent({
    required this.stepName,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stepStarted);

  factory StepStartedEvent.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final stepName = JsonDecoder.optionalField<String>(json, 'stepName') ??
        JsonDecoder.requireField<String>(json, 'step_name');
    
    return StepStartedEvent(
      stepName: stepName,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'stepName': stepName,
  };

  @override
  StepStartedEvent copyWith({
    String? stepName,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StepStartedEvent(
      stepName: stepName ?? this.stepName,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a step has finished
final class StepFinishedEvent extends BaseEvent {
  final String stepName;

  const StepFinishedEvent({
    required this.stepName,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stepFinished);

  factory StepFinishedEvent.fromJson(Map<String, dynamic> json) {
    // Handle both camelCase and snake_case field names
    final stepName = JsonDecoder.optionalField<String>(json, 'stepName') ??
        JsonDecoder.requireField<String>(json, 'step_name');
    
    return StepFinishedEvent(
      stepName: stepName,
      timestamp: JsonDecoder.optionalField<int>(json, 'timestamp'),
      rawEvent: json['rawEvent'],
    );
  }

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'stepName': stepName,
  };

  @override
  StepFinishedEvent copyWith({
    String? stepName,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StepFinishedEvent(
      stepName: stepName ?? this.stepName,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}