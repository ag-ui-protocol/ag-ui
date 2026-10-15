import '../generated/shapes.dart';

/// A document with the material the protocol does not describe removed, and
/// the JSON-pointer paths of everything that was removed.
typedef StripResult = ({Map<String, Object?> value, List<String> stripped});

/// Marks "this whole value is unrecognisable here" while unwinding.
final class _Drop {
  const _Drop();
}

const _drop = _Drop();

/// Deep-strips material the protocol does not describe from a raw document,
/// without judging what it does describe. Three kinds of deviation are
/// removed, never fatal: an unknown property on a closed object, an
/// unrecognised member of a discriminated union (the array element is
/// dropped, or the key omitted), and nothing else — a malformed VALUE on a
/// described field is left in place for the decoder to reject fatally,
/// because inventing a reading for it would be data corruption.
///
/// Open objects (the RFC 6902 operations) keep their extra members, as the
/// RFC requires. Arbitrary-JSON positions are opaque and pass through whole.
/// An unrecognisable value in an optional position is removable; in a
/// required position the containing object is unrecognisable too, and the
/// drop cascades to the nearest removable ancestor.
StripResult stripUnknown(Map<String, Object?> value, String definition) {
  final stripped = <String>[];
  final result = _strip(value, RefShape(definition), '', stripped);
  if (identical(result, _drop)) {
    throw StateError(
      'Internal error: the stripper found the whole value unrecognisable, '
      'which the shapes are not supposed to allow — shape/stripper mismatch.',
    );
  }
  return (value: result! as Map<String, Object?>, stripped: stripped);
}

Object? _strip(Object? value, Shape shape, String path, List<String> stripped) {
  switch (shape) {
    case RefShape(:final name):
      final target = shapes[name];
      if (target == null) throw StateError('shapes has no entry $name');
      return _strip(value, target, path, stripped);
    case ObjectShape(:final fields, :final optional, :final closed):
      if (value is! Map) return value;
      final result = <String, Object?>{};
      for (final entry in value.entries) {
        final key = entry.key as String;
        final field = fields[key];
        if (field == null) {
          if (!closed) {
            result[key] = entry.value;
          } else {
            stripped.add('$path/$key');
          }
          continue;
        }
        final mark = stripped.length;
        final child = _strip(entry.value, field, '$path/$key', stripped);
        if (identical(child, _drop)) {
          stripped.length = mark;
          if (optional.contains(key)) {
            stripped.add('$path/$key');
            continue;
          }
          return _drop;
        }
        result[key] = child;
      }
      return result;
    case UnionShape(:final discriminator, :final members):
      if (value is! Map) return value;
      final member = members[value[discriminator]];
      if (member == null) return _drop;
      return _strip(value, RefShape(member), path, stripped);
    case ListShape(:final items):
      if (value is! List) return value;
      final result = <Object?>[];
      for (var i = 0; i < value.length; i++) {
        final mark = stripped.length;
        final child = _strip(value[i], items, '$path/$i', stripped);
        if (identical(child, _drop)) {
          stripped.length = mark;
          stripped.add('$path/$i');
          continue;
        }
        result.add(child);
      }
      return result;
    case ChoiceShape(:final options):
      for (final option in options) {
        if (option is ListShape && value is List) {
          return _strip(value, option, path, stripped);
        }
      }
      return value;
    case OpaqueShape():
      return value;
  }
}
