import 'package:agui/agui.dart';
import 'package:test/test.dart';

/// Decodes wire-form operations, so the tests read like the RFC's examples.
List<JsonPatchOperation> ops(List<Map<String, Object?>> raw) => [
  for (final op in raw) JsonPatchOperation.fromJson(op),
];

Object? patch(Object? doc, List<Map<String, Object?>> raw) =>
    applyJsonPatch(doc, ops(raw));

Matcher failsAt(int index, String path) => throwsA(
  isA<FormatException>().having(
    (e) => e.message,
    'message',
    allOf(contains('operation $index'), contains('"$path"')),
  ),
);

void main() {
  group('add', () {
    test('sets a new object member', () {
      expect(
        patch(
          {'a': 1},
          [
            {'op': 'add', 'path': '/b', 'value': 2},
          ],
        ),
        {'a': 1, 'b': 2},
      );
    });

    test('replaces an existing object member', () {
      expect(
        patch(
          {'a': 1},
          [
            {'op': 'add', 'path': '/a', 'value': 3},
          ],
        ),
        {'a': 3},
      );
    });

    test('inserts into an array, and - appends', () {
      expect(
        patch(
          {
            'l': [1, 3],
          },
          [
            {'op': 'add', 'path': '/l/1', 'value': 2},
            {'op': 'add', 'path': '/l/-', 'value': 4},
          ],
        ),
        {
          'l': [1, 2, 3, 4],
        },
      );
    });

    test('an index past the end fails', () {
      expect(
        () => patch(
          {
            'l': [1],
          },
          [
            {'op': 'add', 'path': '/l/3', 'value': 2},
          ],
        ),
        failsAt(0, '/l/3'),
      );
    });

    test('a missing parent fails', () {
      expect(
        () => patch(<String, Object?>{}, [
          {'op': 'add', 'path': '/a/b', 'value': 1},
        ]),
        failsAt(0, '/a/b'),
      );
    });

    test('at the root replaces the document', () {
      expect(
        patch(
          {'a': 1},
          [
            {'op': 'add', 'path': '', 'value': 5},
          ],
        ),
        5,
      );
    });
  });

  group('remove', () {
    test('removes an object member and an array element', () {
      expect(
        patch(
          {
            'a': 1,
            'l': [1, 2, 3],
          },
          [
            {'op': 'remove', 'path': '/a'},
            {'op': 'remove', 'path': '/l/0'},
          ],
        ),
        {
          'l': [2, 3],
        },
      );
    });

    test('a missing target fails', () {
      expect(
        () => patch(
          {'a': 1},
          [
            {'op': 'remove', 'path': '/b'},
          ],
        ),
        failsAt(0, '/b'),
      );
    });
  });

  group('replace', () {
    test('replaces an existing value, null included', () {
      expect(
        patch(
          {
            'a': null,
            'l': [1],
          },
          [
            {'op': 'replace', 'path': '/a', 'value': 'x'},
            {'op': 'replace', 'path': '/l/0', 'value': 9},
          ],
        ),
        {
          'a': 'x',
          'l': [9],
        },
      );
    });

    test('a missing target fails', () {
      expect(
        () => patch(
          {'a': 1},
          [
            {'op': 'replace', 'path': '/b', 'value': 2},
          ],
        ),
        failsAt(0, '/b'),
      );
    });
  });

  group('move', () {
    test('removes from the source and adds at the target', () {
      expect(
        patch(
          {
            'a': {'x': 1},
            'b': <String, Object?>{},
          },
          [
            {'op': 'move', 'from': '/a/x', 'path': '/b/y'},
          ],
        ),
        {
          'a': <String, Object?>{},
          'b': {'y': 1},
        },
      );
    });

    test('within one array sees the shifted indices', () {
      expect(
        patch(
          {
            'l': [1, 2, 3],
          },
          [
            {'op': 'move', 'from': '/l/0', 'path': '/l/2'},
          ],
        ),
        {
          'l': [2, 3, 1],
        },
      );
    });

    test('a missing source fails', () {
      expect(
        () => patch(
          {'a': 1},
          [
            {'op': 'move', 'from': '/z', 'path': '/b'},
          ],
        ),
        failsAt(0, '/b'),
      );
    });

    test('into its own child fails', () {
      expect(
        () => patch(
          {
            'a': {'b': 1},
          },
          [
            {'op': 'move', 'from': '/a', 'path': '/a/c'},
          ],
        ),
        failsAt(0, '/a/c'),
      );
    });
  });

  group('copy', () {
    test('adds a deep copy at the target', () {
      final doc = {
        'a': {
          'l': [1],
        },
      };
      final result =
          patch(doc, [
                {'op': 'copy', 'from': '/a', 'path': '/b'},
                {'op': 'add', 'path': '/b/l/-', 'value': 2},
              ])
              as Map<String, Object?>;
      expect(result, {
        'a': {
          'l': [1],
        },
        'b': {
          'l': [1, 2],
        },
      });
    });
  });

  group('test', () {
    test('passes on deep equality, regardless of member order', () {
      final doc = {
        'a': {
          'x': 1,
          'y': [1, 2.0],
        },
      };
      expect(
        patch(doc, [
          {
            'op': 'test',
            'path': '/a',
            'value': {
              'y': [1.0, 2],
              'x': 1,
            },
          },
        ]),
        doc,
      );
    });

    test('fails on a different value and on a missing path', () {
      expect(
        () => patch(
          {'a': 1},
          [
            {'op': 'test', 'path': '/a', 'value': 2},
          ],
        ),
        failsAt(0, '/a'),
      );
      expect(
        () => patch(
          {'a': 1},
          [
            {'op': 'test', 'path': '/b', 'value': null},
          ],
        ),
        failsAt(0, '/b'),
      );
    });
  });

  test('decodes ~0 and ~1 in reference tokens', () {
    expect(
      patch(
        {'a/b': 1, 'm~n': 2},
        [
          {'op': 'replace', 'path': '/a~1b', 'value': 3},
          {'op': 'replace', 'path': '/m~0n', 'value': 4},
          {'op': 'add', 'path': '/~01', 'value': 5},
        ],
      ),
      {'a/b': 3, 'm~n': 4, '~1': 5},
    );
  });

  test('a failure names its index and leaves the input untouched', () {
    final doc = {
      'a': 1,
      'l': [1],
    };
    expect(
      () => patch(doc, [
        {'op': 'add', 'path': '/b', 'value': 2},
        {'op': 'add', 'path': '/l/-', 'value': 2},
        {'op': 'remove', 'path': '/missing'},
      ]),
      failsAt(2, '/missing'),
    );
    expect(doc, {
      'a': 1,
      'l': [1],
    });
  });

  test('success never mutates the input or aliases patch values', () {
    final doc = {
      'o': {'k': 1},
    };
    final value = {
      'v': [1],
    };
    final result =
        applyJsonPatch(doc, [
              AddOperation(path: '/n', value: value),
              const RemoveOperation(path: '/o/k'),
            ])
            as Map<String, Object?>;
    expect(doc, {
      'o': {'k': 1},
    });
    ((result['n'] as Map)['v'] as List).add(2);
    expect(value, {
      'v': [1],
    });
  });

  test('an empty patch returns an equal copy', () {
    final doc = {
      'a': [1],
    };
    final result = applyJsonPatch(doc, const []);
    expect(result, doc);
    expect(identical(result, doc), isFalse);
  });
}
