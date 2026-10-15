import '../../client/warnings.dart';
import '../compat/thinking.dart';

/// The 0.0.45 downgrade, inbound only: THINKING_* events translated to their
/// REASONING_* equivalents. The always-on compatibility boundary runs the
/// same state machine first and so usually finds every one of them before
/// this shim does; it is kept, gated at its threshold, so the two cannot
/// disagree about what a 0.0.45 peer is owed.
Stream<Map<String, Object?>> translateThinkingFor0045(
  Stream<Map<String, Object?>> source,
  WarningSink warn,
) async* {
  final translator = ThinkingTranslator(
    onTranslate:
        (from, to) => warn(
          'AG-UI is converting $from to $to. To remove this warning, upgrade your '
          'AG-UI integration package (e.g. @ag-ui/langgraph). To surpress it, set '
          'SUPPRESS_TRANSFORMATION_WARNINGS=true in your .env file.',
        ),
  );
  await for (final event in source) {
    yield translator.translate(event);
  }
}
