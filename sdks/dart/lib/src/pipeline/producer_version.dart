import '../client/warnings.dart';
import '../generated/models.dart';
import '../generated/version.dart';
import 'versions.dart';

final _grammar = RegExp(r'^\d+\.\d+$');

/// The producer's RUN_STARTED declaration, judged against what this client
/// speaks. Older or absent is the downgrade signal the versioning rules expect
/// a consumer to notice quietly; NEWER means material this client may be
/// stripping, and that deserves a voice.
///
/// The grammar is exactly the published one — two numeric components —
/// checked BEFORE any comparison: [compareProtocolVersions] would happily read
/// "1", "1.0.0" or "1.x" as equal to "1.0", and the spec says a value outside
/// the grammar is handled like a newer one, not silently accepted.
///
/// Returns `'newer'`, `'not-newer'` or `'uninterpretable'`.
String compareDeclaredProtocol(String declared, String spoken) {
  if (!_grammar.hasMatch(declared)) return 'uninterpretable';
  return compareProtocolVersions(declared, spoken) > 0 ? 'newer' : 'not-newer';
}

/// Warns when a RUN_STARTED declares a protocol version this client cannot
/// interpret or one newer than it speaks. Says nothing when the declaration is
/// absent, equal to [protocolVersion], or older.
void warnOnProducerDeclaration(RunStartedEvent event, WarningSink warn) {
  final declared = event.protocolVersion;
  if (declared == null || declared == protocolVersion) return;
  switch (compareDeclaredProtocol(declared, protocolVersion)) {
    case 'uninterpretable':
      warn(
        "[ag-ui] The producer declared protocol version '$declared', which "
        'this client cannot interpret.',
      );
    case 'newer':
      warn(
        '[ag-ui] The producer speaks protocol $declared; this client speaks '
        '$protocolVersion. Unrecognised material will be stripped with '
        'warnings.',
      );
  }
}
