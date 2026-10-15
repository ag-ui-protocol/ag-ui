import 'dart:io';

import 'package:path/path.dart' as p;

/// The repository root: walked up from the working directory until the
/// conformance corpus is found, so moving the package cannot silently point
/// the tests at a directory that does not exist. The same rule the
/// TypeScript and .NET lanes use.
Directory repoRoot() {
  var dir = Directory.current.absolute;
  while (!Directory(
    p.join(dir.path, 'spec', '1.0', 'conformance'),
  ).existsSync()) {
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('no repository root above ${Directory.current.path}');
    }
    dir = parent;
  }
  return dir;
}
