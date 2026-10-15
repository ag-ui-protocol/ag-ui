import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/producer_version.dart';
import 'package:test/test.dart';

List<String> warningsFor(String? declared) {
  final warnings = <String>[];
  warnOnProducerDeclaration(
    RunStartedEvent(threadId: 't', runId: 'r', protocolVersion: declared),
    warnings.add,
  );
  return warnings;
}

void main() {
  group('compareDeclaredProtocol', () {
    test('compares components numerically, not lexicographically', () {
      // The pair that tells the two orderings apart: as strings "1.10" < "1.9".
      expect(compareDeclaredProtocol('1.10', '1.9'), 'newer');
      expect(compareDeclaredProtocol('1.9', '1.10'), 'not-newer');
      expect(compareDeclaredProtocol('1.0', '1.0'), 'not-newer');
    });

    test('rejects everything outside the two-component grammar', () {
      for (final declared in ['1', '1.0.0', '1.x', 'draft', 'v1.0', '']) {
        expect(
          compareDeclaredProtocol(declared, '1.0'),
          'uninterpretable',
          reason: declared,
        );
      }
    });
  });

  group('warnOnProducerDeclaration', () {
    test('is silent when absent, equal or older', () {
      expect(warningsFor(null), isEmpty);
      expect(warningsFor(protocolVersion), isEmpty);
      expect(warningsFor('0.9'), isEmpty);
    });

    test('warns on a newer declaration', () {
      expect(warningsFor('1.10'), [
        '[ag-ui] The producer speaks protocol 1.10; this client speaks '
            '$protocolVersion. Unrecognised material will be stripped with '
            'warnings.',
      ]);
    });

    test('warns on an uninterpretable declaration', () {
      expect(warningsFor('1.0.0'), [
        "[ag-ui] The producer declared protocol version '1.0.0', which this "
            'client cannot interpret.',
      ]);
    });
  });
}
