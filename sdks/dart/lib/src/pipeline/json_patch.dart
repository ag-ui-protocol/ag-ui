import '../generated/models.dart';

/// RFC 6902 over a deep copy; throws FormatException naming the operation
/// index and path when an operation cannot be applied; the input is never
/// mutated.
///
/// Mirrors what the TypeScript client gets from fast-json-patch's
/// `applyPatch(document, patch, validate = true, mutate = false)`: the
/// document is copied once, the operations run in order against the copy, and
/// the first one that cannot be applied aborts the whole patch, so a caller
/// either gets the fully patched copy or an exception and its original.
///
/// Values taken from the patch (add, replace) are copied in as well, so the
/// result never aliases the operations it was built from.
Object? applyJsonPatch(Object? document, List<JsonPatchOperation> patch) {
  var result = _deepCopy(document);
  for (var index = 0; index < patch.length; index++) {
    result = _applyOperation(result, patch[index], index);
  }
  return result;
}

/// Applies one operation to [document], which this module owns and may
/// mutate in place. Returns the new document: usually [document] itself, but
/// a different value for operations on the root.
Object? _applyOperation(Object? document, JsonPatchOperation op, int index) {
  Never fail(String reason) =>
      throw FormatException(
        'JSON Patch operation $index (${op.op} "${op.path}") failed: $reason',
      );

  final path = op.path;
  if (path.isNotEmpty && !path.startsWith('/')) {
    fail('the path must be empty or start with a slash');
  }

  // move and copy read their source first: a missing `from` is reported as
  // such, before anything about the target path (fast-json-patch's
  // OPERATION_FROM_UNRESOLVABLE).
  Object? sourceValue;
  if (op is MoveOperation || op is CopyOperation) {
    final from = op is MoveOperation ? op.from : (op as CopyOperation).from;
    final found = _resolve(document, from);
    if (!found.exists) {
      fail(
        'cannot perform the operation from a path that does not exist '
        '("$from")',
      );
    }
    sourceValue = _deepCopy(found.value);
  }

  // Operations on the root replace the whole document.
  if (path.isEmpty) {
    switch (op) {
      case AddOperation(:final value):
      case ReplaceOperation(:final value):
        return _deepCopy(value);
      case RemoveOperation():
        // fast-json-patch leaves null behind when the root is removed.
        return null;
      case MoveOperation():
      case CopyOperation():
        return sourceValue;
      case TestOperation(:final value):
        if (!_jsonEquals(document, value)) fail('test operation failed');
        return document;
    }
  }

  final tokens = [
    for (final raw in path.substring(1).split('/')) _unescape(raw),
  ];

  // Walk to the parent of the target. Every intermediate value must exist
  // and be a container.
  var parent = document;
  for (var i = 0; i < tokens.length - 1; i++) {
    final child = _child(parent, tokens[i]);
    if (!child.exists) {
      fail(
        op is AddOperation
            ? 'cannot perform an add operation at the desired path'
            : 'cannot perform the operation at a path that does not exist',
      );
    }
    final next = child.value;
    if (next is! Map<String, Object?> && next is! List<Object?>) {
      fail('cannot perform the operation at the desired path');
    }
    parent = next;
  }
  final key = tokens.last;

  // move is remove-then-add; the removal happens on the working copy, which
  // is thrown away if the add then fails.
  if (op is MoveOperation) {
    _removeAt(document, op.from, fail);
    // The parent was resolved before the removal; re-resolve it so a move
    // within one array sees the shifted indices.
    final reParent = _resolve(document, _parentPointer(path));
    if (!reParent.exists) {
      fail('cannot perform an add operation at the desired path');
    }
    _add(reParent.value, key, sourceValue, fail);
    return document;
  }

  switch (op) {
    case AddOperation(:final value):
      _add(parent, key, _deepCopy(value), fail);
    case CopyOperation():
      _add(parent, key, sourceValue, fail);
    case RemoveOperation():
      _remove(parent, key, fail);
    case ReplaceOperation(:final value):
      if (parent is Map<String, Object?>) {
        if (!parent.containsKey(key)) {
          fail('cannot perform the operation at a path that does not exist');
        }
        parent[key] = _deepCopy(value);
      } else if (parent is List<Object?>) {
        final i = _existingIndex(parent, key, fail);
        parent[i] = _deepCopy(value);
      } else {
        fail('cannot perform the operation at a path that does not exist');
      }
    case TestOperation(:final value):
      final target = _child(parent, key);
      if (!target.exists || !_jsonEquals(target.value, value)) {
        fail('test operation failed');
      }
    case MoveOperation():
      // Handled above.
      break;
  }
  return document;
}

/// Inserts [value] under [key]: sets or replaces an object member, inserts
/// into an array (`-` appends).
void _add(
  Object? parent,
  String key,
  Object? value,
  Never Function(String) fail,
) {
  if (parent is Map<String, Object?>) {
    parent[key] = value;
  } else if (parent is List<Object?>) {
    if (key == '-') {
      parent.add(value);
      return;
    }
    final i = _arrayIndex(key, fail);
    if (i > parent.length) {
      fail(
        'the specified index MUST NOT be greater than the number of elements '
        'in the array',
      );
    }
    parent.insert(i, value);
  } else {
    fail('cannot perform an add operation at the desired path');
  }
}

/// Removes the member or element under [key], which must exist.
void _remove(Object? parent, String key, Never Function(String) fail) {
  if (parent is Map<String, Object?>) {
    if (!parent.containsKey(key)) {
      fail('cannot perform the operation at a path that does not exist');
    }
    parent.remove(key);
  } else if (parent is List<Object?>) {
    parent.removeAt(_existingIndex(parent, key, fail));
  } else {
    fail('cannot perform the operation at a path that does not exist');
  }
}

/// Removes the value at [pointer] inside [document] (the source of a move).
void _removeAt(Object? document, String pointer, Never Function(String) fail) {
  final parent = _resolve(document, _parentPointer(pointer));
  if (pointer.isEmpty || !parent.exists) {
    fail('cannot move a value from a path that does not exist');
  }
  final key = _unescape(pointer.substring(pointer.lastIndexOf('/') + 1));
  _remove(parent.value, key, fail);
}

String _parentPointer(String pointer) =>
    pointer.isEmpty ? '' : pointer.substring(0, pointer.lastIndexOf('/'));

/// The index [key] names in [list], which must be an existing element.
int _existingIndex(
  List<Object?> list,
  String key,
  Never Function(String) fail,
) {
  if (key == '-') {
    fail('cannot perform the operation at a path that does not exist');
  }
  final i = _arrayIndex(key, fail);
  if (i >= list.length) {
    fail('cannot perform the operation at a path that does not exist');
  }
  return i;
}

final _digits = RegExp(r'^\d+$');

/// Parses an array index token. fast-json-patch accepts any run of ASCII
/// digits (its `isInteger`), so leading zeros are tolerated here too.
int _arrayIndex(String key, Never Function(String) fail) {
  if (!_digits.hasMatch(key)) {
    fail(
      'expected an unsigned base-10 integer value, making the new referenced '
      'value the array element with the zero-based index',
    );
  }
  return int.parse(key);
}

/// Decodes one reference token: `~1` is `/` and `~0` is `~`, in that order so
/// `~01` reads as the literal `~1` (RFC 6901 section 4).
String _unescape(String token) =>
    token.replaceAll('~1', '/').replaceAll('~0', '~');

typedef _Found = ({bool exists, Object? value});

/// Resolves a whole JSON pointer against [document].
_Found _resolve(Object? document, String pointer) {
  if (pointer.isEmpty) return (exists: true, value: document);
  if (!pointer.startsWith('/')) return (exists: false, value: null);
  Object? current = document;
  for (final raw in pointer.substring(1).split('/')) {
    final found = _child(current, _unescape(raw));
    if (!found.exists) return found;
    current = found.value;
  }
  return (exists: true, value: current);
}

/// One step of a pointer: the member or element [key] names in [container].
/// A present member whose value is null exists.
_Found _child(Object? container, String key) {
  if (container is Map<String, Object?>) {
    return container.containsKey(key)
        ? (exists: true, value: container[key])
        : (exists: false, value: null);
  }
  if (container is List<Object?>) {
    if (!_digits.hasMatch(key)) return (exists: false, value: null);
    final i = int.parse(key);
    return i < container.length
        ? (exists: true, value: container[i])
        : (exists: false, value: null);
  }
  return (exists: false, value: null);
}

/// A structural copy of a JSON value. Maps and lists become fresh mutable
/// ones; scalars are shared, being immutable.
Object? _deepCopy(Object? value) => switch (value) {
  final Map<String, Object?> map => <String, Object?>{
    for (final entry in map.entries) entry.key: _deepCopy(entry.value),
  },
  final List<Object?> list => <Object?>[
    for (final item in list) _deepCopy(item),
  ],
  _ => value,
};

/// Deep JSON equality, as the test operation needs it: objects by member
/// regardless of order, arrays element by element, numbers by value (so 1
/// equals 1.0, as it does in JavaScript).
bool _jsonEquals(Object? a, Object? b) {
  if (a is Map<String, Object?> && b is Map<String, Object?>) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (!b.containsKey(entry.key)) return false;
      if (!_jsonEquals(entry.value, b[entry.key])) return false;
    }
    return true;
  }
  if (a is List<Object?> && b is List<Object?>) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map || b is Map || a is List || b is List) return false;
  return a == b;
}
