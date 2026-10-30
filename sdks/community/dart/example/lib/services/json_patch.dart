/// Minimal in-place RFC-6902 applier for the op subset the AG-UI dojo routes emit
/// (add / replace / remove on object keys and arrays, including the "-" append token).
///
/// Returns the (possibly replaced) root so callers can reassign for a root-level op.
///
/// Documented limitation — no intermediate-parent creation: [_resolve] walks only
/// existing nodes and throws if a pointer's parent is missing. The dojo routes never
/// hit this (the server always `add`s whole parent objects, e.g. predictive re-adds the
/// entire `/_predictive` object rather than `/_predictive/draft`), so a future deep
/// `add` into a missing parent SHOULD fail loudly against this assumption.
///
/// Note: `add`/`replace` store `op['value']` by reference (no deep copy). This is safe
/// because each delta is freshly decoded per event, so the stored subtree is not shared
/// with anything else.
dynamic applyJsonPatch(dynamic root, List<Map<String, dynamic>> ops) {
  // A null root has no structure to patch (e.g. a delta arriving after a null
  // STATE_SNAPSHOT). Only a whole-document replace/add at "" can set it; per-path ops
  // are no-ops rather than a crash.
  if (root == null) {
    for (final op in ops) {
      final path = op['path'] as String? ?? '';
      final kind = op['op'] as String?;
      if (path.isEmpty && (kind == 'replace' || kind == 'add')) {
        root = op['value'];
      }
    }
    return root;
  }
  for (final op in ops) {
    final kind = op['op'] as String?;
    final path = op['path'] as String? ?? '';
    final segments = _parsePointer(path);
    if (segments.isEmpty) {
      // Whole-document replace/add (rare). Replace/return the new root.
      if (kind == 'replace' || kind == 'add') root = op['value'];
      continue;
    }
    final parent = _resolve(root, segments.sublist(0, segments.length - 1));
    final key = segments.last;
    switch (kind) {
      case 'add':
        if (parent is List) {
          if (key == '-') {
            parent.add(op['value']);
          } else {
            parent.insert(int.parse(key), op['value']);
          }
        } else if (parent is Map) {
          parent[key] = op['value']; // RFC: add to object == set
        }
      case 'replace':
        if (parent is List) {
          parent[int.parse(key)] = op['value'];
        } else if (parent is Map) {
          parent[key] = op['value'];
        }
      case 'remove':
        if (parent is List) {
          parent.removeAt(int.parse(key));
        } else if (parent is Map) {
          parent.remove(key);
        }
    }
  }
  return root;
}

List<String> _parsePointer(String pointer) {
  if (pointer.isEmpty || pointer == '/') return const [];
  return pointer
      .split('/')
      .skip(1) // leading ''
      .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
      .toList();
}

dynamic _resolve(dynamic node, List<String> segments) {
  for (final seg in segments) {
    node = node is List ? node[int.parse(seg)] : (node as Map)[seg];
  }
  return node;
}
