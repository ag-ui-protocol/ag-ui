import '../generated/shapes.dart';

/// Removes every whole optional field that is `null` from a raw document,
/// walking only the protocol's own structure: nulls inside arbitrary JSON
/// (state, metadata values, raw events, tool arguments) and required nulls
/// (CUSTOM's `value`, say) are left exactly where they are.
///
/// This is the producer-side contract every SDK is held to by
/// `sdks/fixtures/null-omission.json`: a field with no value is left out of
/// the JSON rather than written as null. Typed Dart values never carry such a
/// null — `toJson` omits them — so this walker exists for documents that
/// arrive as JSON, the way the TypeScript SDK's generated `omitOptionalNulls`
/// does. [root] names the definition the document is, such as `'Event'` or
/// `'RunAgentInput'`.
///
/// Returns a new structure; never mutates the input. Unknown keys are kept.
Map<String, Object?> omitOptionalNulls(
  Map<String, Object?> value,
  String root,
) {
  final shape = shapes[root];
  if (shape == null)
    throw ArgumentError.value(root, 'root', 'not a definition');
  return _walk(value, shape) as Map<String, Object?>;
}

Object? _walk(Object? value, Shape shape) {
  switch (shape) {
    case RefShape(:final name):
      final target = shapes[name];
      if (target == null) {
        throw StateError('shapes has no entry $name');
      }
      return _walk(value, target);
    case ObjectShape(:final fields, :final optional):
      if (value is! Map) return value;
      final result = <String, Object?>{};
      for (final entry in value.entries) {
        final key = entry.key as String;
        final field = fields[key];
        if (entry.value == null && field != null && optional.contains(key)) {
          continue;
        }
        result[key] = field == null ? entry.value : _walk(entry.value, field);
      }
      return result;
    case UnionShape(:final discriminator, :final members):
      if (value is! Map) return value;
      final member = members[value[discriminator]];
      return member == null ? value : _walk(value, RefShape(member));
    case ListShape(:final items):
      if (value is! List) return value;
      return [for (final item in value) _walk(item, items)];
    case ChoiceShape(:final options):
      for (final option in options) {
        if (option is ListShape && value is List) return _walk(value, option);
      }
      return value;
    case OpaqueShape():
      return value;
  }
}
