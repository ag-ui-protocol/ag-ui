import '../client/warnings.dart';
import '../generated/models.dart';
import '../generated/shapes.dart';
import 'strip.dart';

/// The enforcement stage: sits after the compatibility boundary and the era
/// shims and before chunk expansion, and guarantees that nothing unrecognised
/// survives to verification or application code.
///
/// - An event whose type nothing translated is dropped, with a warning.
/// - Unknown properties and unrecognised union members on a known event are
///   stripped, each with a warning naming its path.
/// - A malformed value on a field the protocol DOES describe stays fatal:
///   the generated decoder throws, and the run errors.
Stream<Event> enforceEvents(
  Stream<Map<String, Object?>> source,
  WarningSink warn,
) async* {
  final union = shapes['Event']! as UnionShape;
  await for (final json in source) {
    final type = json['type'];
    final definition = type is String ? union.members[type] : null;
    if (definition == null) {
      warn(
        "[ag-ui][enforce] Dropping unrecognised event '$type': no middleware "
        'translated it and the protocol does not describe it.',
      );
      continue;
    }
    final result = stripUnknown(json, definition);
    for (final path in result.stripped) {
      warn(
        "[ag-ui][enforce] Removed unrecognised material at '$path' on $type. "
        'Nothing handled it; see the repo-root DEPRECATIONS.md if it is a '
        'retired shape.',
      );
    }
    yield Event.fromJson(result.value);
  }
}
