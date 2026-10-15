import '../errors.dart';
import '../generated/models.dart';
import '../generated/version.dart';
import '../pipeline/run_pipeline.dart';
import '../pipeline/versions.dart';
import 'ids.dart';
import 'warnings.dart';

/// What a run added: the messages that were not there before, and the
/// result a successful RUN_FINISHED carried.
final class RunAgentResult {
  const RunAgentResult({required this.newMessages, this.result});

  final List<Message> newMessages;
  final Object? result;
}

/// An agent the client can run: holds the conversation and state, builds the
/// request, and drives the pipeline. Subclasses provide the transport by
/// implementing [connect].
///
/// One run at a time: a second [run] while one is active throws
/// [AguiStateException]. Events are yielded after they have been applied,
/// so [messages] and [state] are current when a listener sees one.
abstract class AbstractAgent {
  AbstractAgent({
    this.agentId,
    String? threadId,
    List<Message>? initialMessages,
    State initialState = const <String, Object?>{},
    this.description,
    this.maxProtocolVersion,
    WarningSink? onWarning,
  }) : threadId = threadId ?? uuidV4(),
       messages = List.of(initialMessages ?? const <Message>[]),
       state = initialState,
       onWarning = onWarning ?? ignoreWarnings;

  final String? agentId;
  final String threadId;
  final String? description;

  /// The peer ceiling: the highest protocol version the agent on the other
  /// side speaks. Null means a current peer. A ceiling below 1.0 installs the
  /// era shims and leaves the protocol version off the request.
  final String? maxProtocolVersion;

  /// Where tolerated deviations are reported.
  final WarningSink onWarning;

  /// The conversation, kept current by the pipeline as events are applied.
  List<Message> messages;

  /// The agent state, kept current by the pipeline.
  State state;

  /// The interrupts the last run finished with, if it was interrupted.
  List<Interrupt> pendingInterrupts = const [];

  bool _isRunning = false;

  /// Whether a run is in progress.
  bool get isRunning => _isRunning;

  /// Whether this client declares its protocol version to the peer: only
  /// when the peer's ceiling is not pinned below it, because a downgraded
  /// peer predates the field and may reject an unknown input member.
  bool get declaresProtocolVersion =>
      maxProtocolVersion == null ||
      compareProtocolVersions(maxProtocolVersion!, protocolVersion) >= 0;

  /// The transport: sends [input] and yields each event's raw JSON object as
  /// it arrives, before any of the pipeline's stages have seen it.
  Stream<Map<String, Object?>> connect(RunAgentInput input);

  /// Builds the request for a run from the agent's current conversation.
  RunAgentInput prepareRunAgentInput({
    String? runId,
    String? parentRunId,
    List<Tool> tools = const [],
    List<Context> context = const [],
    Object? forwardedProps,
    List<ResumeEntry>? resume,
  }) => RunAgentInput(
    threadId: threadId,
    runId: runId ?? uuidV4(),
    parentRunId: parentRunId,
    protocolVersion: declaresProtocolVersion ? protocolVersion : null,
    tools: List.of(tools),
    context: List.of(context),
    forwardedProps: forwardedProps ?? const <String, Object?>{},
    state: state,
    // Activity messages are the client's own rendering state, never input.
    messages: [
      for (final message in messages)
        if (message is! ActivityMessage) message,
    ],
    resume: resume == null ? null : List.of(resume),
  );

  /// Runs the agent once. Throws [AguiStateException] synchronously when a
  /// run is already active. The returned stream yields every event after it
  /// has been applied to [messages] and [state]; a protocol violation or
  /// transport failure ends it with an error.
  Stream<Event> run({
    String? runId,
    String? parentRunId,
    List<Tool> tools = const [],
    List<Context> context = const [],
    Object? forwardedProps,
    List<ResumeEntry>? resume,
  }) {
    if (_isRunning) {
      throw const AguiStateException(
        'A run is already in progress. Wait for it to finish before starting '
        'another one.',
      );
    }
    _isRunning = true;
    final input = prepareRunAgentInput(
      runId: runId,
      parentRunId: parentRunId,
      tools: tools,
      context: context,
      forwardedProps: forwardedProps,
      resume: resume,
    );
    return _guarded(input);
  }

  Stream<Event> _guarded(RunAgentInput input) async* {
    try {
      yield* runPipeline(this, input);
    } finally {
      _isRunning = false;
    }
  }

  /// Runs the agent once and waits for the run to end.
  Future<RunAgentResult> runAgent({
    String? runId,
    String? parentRunId,
    List<Tool> tools = const [],
    List<Context> context = const [],
    Object? forwardedProps,
    List<ResumeEntry>? resume,
  }) async {
    final before = {for (final message in messages) message.id};
    Object? result;
    await for (final event in run(
      runId: runId,
      parentRunId: parentRunId,
      tools: tools,
      context: context,
      forwardedProps: forwardedProps,
      resume: resume,
    )) {
      if (event is RunFinishedEvent) {
        final outcome = event.outcome;
        if (outcome == null || outcome is RunFinishedSuccessOutcome) {
          result = event.result;
        }
      }
    }
    return RunAgentResult(
      newMessages: [
        for (final message in messages)
          if (!before.contains(message.id)) message,
      ],
      result: result,
    );
  }
}
