import 'dart:convert';
import 'dart:io';

import 'package:agui/agui.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../support/definitions.dart';
import '../support/repo.dart';

/// Every document under spec/1.0/fixtures, decoded against the definition its
/// directory names: valid ones must decode and re-encode to the same JSON,
/// invalid ones must be rejected — except the ones rejected for an unknown
/// property, which the codec ignores by design (the enforcement stage strips
/// and warns; see test/pipeline/strip_test.dart).
void main() {
  test('the corpus is present', () {
    expect(
      Directory(
        p.join(repoRoot().path, 'spec', '1.0', 'fixtures'),
      ).existsSync(),
      isTrue,
    );
  });

  final fixtures = Directory(
    p.join(repoRoot().path, 'spec', '1.0', 'fixtures'),
  );
  final definitions =
      fixtures.listSync().whereType<Directory>().toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  for (final dir in definitions) {
    final definition = p.basename(dir.path);
    group(definition, () {
      final valid = Directory(p.join(dir.path, 'valid'));
      if (valid.existsSync()) {
        for (final file in valid.listSync().whereType<File>()) {
          test('accepts ${p.basename(file.path)} and re-encodes it equal', () {
            final json =
                jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
            final value = decodeDefinition(definition, json);
            expect(encodeDefinition(value), json);
          });
        }
      }
      final invalid = Directory(p.join(dir.path, 'invalid'));
      if (invalid.existsSync()) {
        final documents = invalid.listSync().whereType<File>().where(
          (f) => f.path.endsWith('.json') && !f.path.endsWith('.expect.json'),
        );
        for (final file in documents) {
          final expectFile = File(
            '${file.path.substring(0, file.path.length - 5)}.expect.json',
          );
          final expectation =
              jsonDecode(expectFile.readAsStringSync()) as Map<String, Object?>;
          final keyword = expectation['keyword'] as String;
          final json =
              jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
          if (keyword == 'unevaluatedProperties') {
            test('ignores the unknown key in ${p.basename(file.path)}', () {
              expect(() => decodeDefinition(definition, json), returnsNormally);
            });
          } else {
            test('rejects ${p.basename(file.path)} ($keyword)', () {
              expect(
                () => decodeDefinition(definition, json),
                throwsA(isA<AguiDecodeException>()),
              );
            });
          }
        }
      }
    });
  }
}
