import 'dart:convert';
import 'dart:io';

import 'package:agui/agui.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../support/repo.dart';

/// AgentCapabilities round-trips: parsed into the generated model and
/// serialized back, the result equals `expected` with unset optionals absent.
void main() {
  final file = File(
    p.join(repoRoot().path, 'sdks', 'fixtures', 'agent-capabilities.json'),
  );
  final doc = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  final cases =
      (doc['cases'] as List)
          .cast<Map<String, Object?>>()
          .where((c) => (c['producedBy'] as List).contains('dart'))
          .toList();

  test('covers this SDK', () {
    expect(cases, isNotEmpty);
  });

  for (final c in cases) {
    test(c['name'] as String, () {
      final value = AgentCapabilities.fromJson(
        c['input'] as Map<String, Object?>,
      );
      expect(value.toJson(), c['expected']);
    });
  }
}
