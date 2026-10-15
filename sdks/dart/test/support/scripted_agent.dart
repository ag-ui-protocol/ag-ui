import 'package:agui/agui.dart';

/// An agent whose transport replays a scripted list of raw events, for tests
/// that exercise the pipeline without HTTP.
final class ScriptedAgent extends AbstractAgent {
  ScriptedAgent(
    this.script, {
    super.threadId = 't',
    super.initialMessages,
    super.initialState,
    super.maxProtocolVersion,
    super.onWarning,
  });

  /// Produces the raw event stream for one run; called once per run.
  final Stream<Map<String, Object?>> Function(RunAgentInput input) script;

  /// Every input this agent was run with, in order.
  final List<RunAgentInput> inputs = [];

  @override
  Stream<Map<String, Object?>> connect(RunAgentInput input) {
    inputs.add(input);
    return script(input);
  }
}

/// A scripted agent replaying a fixed list of events.
ScriptedAgent scripted(
  List<Map<String, Object?>> events, {
  List<Message>? initialMessages,
  State initialState = const <String, Object?>{},
  String? maxProtocolVersion,
  WarningSink? onWarning,
}) => ScriptedAgent(
  (_) => Stream.fromIterable(events),
  initialMessages: initialMessages,
  initialState: initialState,
  maxProtocolVersion: maxProtocolVersion,
  onWarning: onWarning,
);
