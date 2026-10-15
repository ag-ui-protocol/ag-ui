import 'package:agui/agui.dart';

/// Decoders by definition name, for tests that read documents named by the
/// definition they validate against (the spec fixture corpus). The generator
/// does not emit a by-name registry on purpose; this is test support.
final Map<String, Object Function(Map<String, Object?> json)> decoders = {
  'ActivityDeltaEvent': ActivityDeltaEvent.fromJson,
  'ActivitySnapshotEvent': ActivitySnapshotEvent.fromJson,
  'AgentCapabilities': AgentCapabilities.fromJson,
  'CustomEvent': CustomEvent.fromJson,
  'ExecutionCapabilities': ExecutionCapabilities.fromJson,
  'FileSource': FileSource.fromJson,
  'Interrupt': Interrupt.fromJson,
  'MessagesSnapshotEvent': MessagesSnapshotEvent.fromJson,
  'MultiAgentCapabilities': MultiAgentCapabilities.fromJson,
  'RawEvent': RawEvent.fromJson,
  'ReasoningEncryptedValueEvent': ReasoningEncryptedValueEvent.fromJson,
  'ReasoningEndEvent': ReasoningEndEvent.fromJson,
  'ReasoningMessageChunkEvent': ReasoningMessageChunkEvent.fromJson,
  'ReasoningMessageContentEvent': ReasoningMessageContentEvent.fromJson,
  'ReasoningMessageEndEvent': ReasoningMessageEndEvent.fromJson,
  'ReasoningMessageStartEvent': ReasoningMessageStartEvent.fromJson,
  'ReasoningStartEvent': ReasoningStartEvent.fromJson,
  'ResumeEntry': ResumeEntry.fromJson,
  'RunAgentInput': RunAgentInput.fromJson,
  'RunErrorEvent': RunErrorEvent.fromJson,
  'RunFinishedEvent': RunFinishedEvent.fromJson,
  'RunStartedEvent': RunStartedEvent.fromJson,
  'StateDeltaEvent': StateDeltaEvent.fromJson,
  'StateSnapshotEvent': StateSnapshotEvent.fromJson,
  'StepFinishedEvent': StepFinishedEvent.fromJson,
  'StepStartedEvent': StepStartedEvent.fromJson,
  'SubagentErrorEvent': SubagentErrorEvent.fromJson,
  'SubagentFinishedEvent': SubagentFinishedEvent.fromJson,
  'SubagentInfo': SubagentInfo.fromJson,
  'SubagentStartedEvent': SubagentStartedEvent.fromJson,
  'TextMessageChunkEvent': TextMessageChunkEvent.fromJson,
  'TextMessageContentEvent': TextMessageContentEvent.fromJson,
  'TextMessageEndEvent': TextMessageEndEvent.fromJson,
  'TextMessageStartEvent': TextMessageStartEvent.fromJson,
  'Tool': Tool.fromJson,
  'ToolCallArgsEvent': ToolCallArgsEvent.fromJson,
  'ToolCallChunkEvent': ToolCallChunkEvent.fromJson,
  'ToolCallEndEvent': ToolCallEndEvent.fromJson,
  'ToolCallResultEvent': ToolCallResultEvent.fromJson,
  'ToolCallStartEvent': ToolCallStartEvent.fromJson,
  'ToolMessage': ToolMessage.fromJson,
  'UserMessage': UserMessage.fromJson,
};

/// Decodes [json] as [definition]; throws [AguiDecodeException] on mismatch.
Object decodeDefinition(String definition, Map<String, Object?> json) {
  final decoder = decoders[definition];
  if (decoder == null) {
    throw ArgumentError('no decoder for $definition — add it to decoders');
  }
  return decoder(json);
}

/// Re-encodes a decoded value. Every generated class has `toJson`, but they
/// share no interface, so the call goes through `dynamic` here, in test
/// support only.
Map<String, Object?> encodeDefinition(Object value) =>
    // ignore: avoid_dynamic_calls
    (value as dynamic).toJson() as Map<String, Object?>;
