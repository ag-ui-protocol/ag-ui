import '../../client/warnings.dart';
import '../../generated/models.dart';

const _subagentLifecycle = {
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'SUBAGENT_ERROR',
};

/// [value] without its top-level `subagentRunId`, or [value] itself.
Object? _stripSubagentRunId(Object? value) {
  if (value is! Map || !value.containsKey('subagentRunId')) return value;
  return Map<String, Object?>.from(value)..remove('subagentRunId');
}

List<Object?> _stripMessages(List<Object?> messages) => [
  for (final message in messages) _stripSubagentRunId(message),
];

/// The 0.0.57 downgrade, outgoing: a pre-subagent peer never receives
/// attribution it does not understand, so `subagentRunId` is removed from
/// every message in the request.
RunAgentInput stripSubagentsFor0057(RunAgentInput input, WarningSink warn) {
  final json = input.toJson();
  json['messages'] = _stripMessages(json['messages'] as List);
  return RunAgentInput.fromJson(json);
}

/// The 0.0.57 downgrade, inbound: SUBAGENT_* lifecycle events are dropped
/// with a warning, and `subagentRunId` is removed from every remaining event,
/// from MESSAGES_SNAPSHOT messages, from RUN_FINISHED's interrupts and from
/// RUN_STARTED's echoed input messages. Opaque application payloads are not
/// walked.
Stream<Map<String, Object?>> dropSubagentsFor0057(
  Stream<Map<String, Object?>> source,
  WarningSink warn,
) async* {
  await for (final event in source) {
    final type = event['type'];
    if (type is String && _subagentLifecycle.contains(type)) {
      warn(
        'AG-UI is dropping $type because the target agent predates subagent '
        'support. To remove this warning, upgrade your AG-UI integration '
        'package. To suppress it, set SUPPRESS_TRANSFORMATION_WARNINGS=true in '
        'your .env file.',
      );
      continue;
    }
    final stripped = _stripSubagentRunId(event)! as Map<String, Object?>;
    switch (type) {
      case 'MESSAGES_SNAPSHOT':
        final messages = stripped['messages'];
        if (messages is List) {
          yield Map<String, Object?>.from(stripped)
            ..['messages'] = _stripMessages(messages);
          continue;
        }
      case 'RUN_FINISHED':
        final outcome = stripped['outcome'];
        if (outcome is Map && outcome['interrupts'] is List) {
          yield Map<String, Object?>.from(stripped)
            ..['outcome'] = (Map<String, Object?>.from(outcome)
              ..['interrupts'] = _stripMessages(outcome['interrupts'] as List));
          continue;
        }
      case 'RUN_STARTED':
        final input = stripped['input'];
        if (input is Map && input['messages'] is List) {
          yield Map<String, Object?>.from(stripped)
            ..['input'] = (Map<String, Object?>.from(input)
              ..['messages'] = _stripMessages(input['messages'] as List));
          continue;
        }
    }
    yield stripped;
  }
}
