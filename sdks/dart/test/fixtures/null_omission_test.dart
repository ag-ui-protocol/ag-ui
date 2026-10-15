import 'dart:convert';
import 'dart:io';

import 'package:agui/agui.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../support/repo.dart';

/// The cross-language contract that a producer leaves a valueless optional
/// field out of the JSON rather than writing null. One case per entry whose
/// producedBy names this SDK. As in the TypeScript lane, the raw input goes
/// through omitOptionalNulls first: a typed Dart value can never carry such a
/// null, so the walker is where this SDK meets the contract for raw JSON.
void main() {
  final file = File(
    p.join(repoRoot().path, 'sdks', 'fixtures', 'null-omission.json'),
  );
  final doc = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  final cases =
      (doc['stream'] as List)
          .cast<Map<String, Object?>>()
          .where((c) => (c['producedBy'] as List).contains('dart'))
          .toList();

  test('covers this SDK', () {
    expect(cases.length, greaterThan(15));
  });

  for (final c in cases) {
    test(c['name'] as String, () {
      final input = omitOptionalNulls(
        c['input'] as Map<String, Object?>,
        'Event',
      );
      final event = Event.fromJson(input);
      expect(event.toJson(), c['expected']);
    });
  }
}
