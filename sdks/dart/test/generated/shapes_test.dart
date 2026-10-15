import 'package:agui/agui.dart';
import 'package:test/test.dart';

void main() {
  test('every event type in the union has an object shape', () {
    final union = shapes['Event']! as UnionShape;
    expect(union.members.length, EventType.values.length);
    for (final member in union.members.values) {
      expect(shapes[member], isA<ObjectShape>(), reason: member);
    }
  });

  test('patch operations are open, everything else is closed', () {
    expect((shapes['AddOperation']! as ObjectShape).closed, isFalse);
    expect((shapes['RunStartedEvent']! as ObjectShape).closed, isTrue);
  });

  test('every reference resolves to an entry', () {
    void walk(Shape shape) {
      switch (shape) {
        case RefShape(:final name):
          expect(shapes.containsKey(name), isTrue, reason: name);
        case ListShape(:final items):
          walk(items);
        case ChoiceShape(:final options):
          options.forEach(walk);
        case ObjectShape(:final fields):
          fields.values.forEach(walk);
        case UnionShape(:final members):
          for (final member in members.values) {
            expect(shapes.containsKey(member), isTrue, reason: member);
          }
        case OpaqueShape():
          break;
      }
    }

    shapes.values.forEach(walk);
  });
}
