import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../support/repo.dart';

/// The shared conformance fixture format: one replayed stream plus the
/// outcome the specification requires of any client that consumes it. The
/// same files drive the TypeScript, .NET and Dart lanes, so the format is
/// declarative: it states what must be observable afterwards, never how a
/// particular client arrives there. The keys are documented in
/// `spec/1.0/conformance/README.md`.
final class StreamFixture {
  StreamFixture.fromJson(Map<String, Object?> json)
    : name = json['name'] as String,
      area = json['area'] as String,
      description = json['description'] as String,
      maxProtocolVersion =
          (json['client'] as Map?)?['maxProtocolVersion'] as String?,
      input = (json['input'] as Map?)?.cast<String, Object?>(),
      stream = (json['stream'] as List).cast<Map<String, Object?>>(),
      expectation = (json['expect'] as Map).cast<String, Object?>(),
      overrides =
          (json['expectOverrides'] as Map?)?.cast<String, Object?>() ??
          const {};

  final String name;
  final String area;
  final String description;

  /// Pins the peer ceiling, which installs the era shims. Null is a current
  /// peer and no shims.
  final String? maxProtocolVersion;

  /// What the run starts from: `messages`, `tools`, `context`,
  /// `forwardedProps`, each optional.
  final Map<String, Object?>? input;

  /// The events to replay, verbatim and deliberately untyped.
  final List<Map<String, Object?>> stream;

  /// What the specification requires of every client.
  final Map<String, Object?> expectation;

  /// Per-lane overrides, each with an `intentional` reason.
  final Map<String, Object?> overrides;
}

/// The expectation one lane must satisfy: the base, with the lane's
/// override keys replacing the same keys.
Map<String, Object?> resolveExpectation(StreamFixture fixture, String lane) {
  final override = (fixture.overrides[lane] as Map?)?.cast<String, Object?>();
  if (override == null) return fixture.expectation;
  return {...fixture.expectation, ...override}..remove('intentional');
}

/// Every fixture in `spec/1.0/conformance/streams`, by file name.
List<StreamFixture> loadFixtures() {
  final dir = Directory(
    p.join(repoRoot().path, 'spec', '1.0', 'conformance', 'streams'),
  );
  final files =
      dir
          .listSync()
          .whereType<File>()
          .where((f) => f.path.endsWith('.json'))
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  return [
    for (final file in files)
      StreamFixture.fromJson(
        (jsonDecode(file.readAsStringSync()) as Map).cast<String, Object?>(),
      ),
  ];
}
