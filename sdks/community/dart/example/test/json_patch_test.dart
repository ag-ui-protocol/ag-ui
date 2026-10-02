import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:ag_ui_example/services/json_patch.dart';

/// Deep-mutable clone, mirroring how the pages clone a STATE_SNAPSHOT before mutating.
dynamic clone(dynamic v) => jsonDecode(jsonEncode(v));

void main() {
  group('applyJsonPatch — op kinds', () {
    test('replace a scalar in a map', () {
      final doc = clone({'title': 'a'});
      applyJsonPatch(doc, [
        {'op': 'replace', 'path': '/title', 'value': 'b'}
      ]);
      expect(doc['title'], 'b');
    });

    test('replace a nested array element status (checklist)', () {
      final doc = clone({
        'steps': [
          {'description': 's0', 'status': 'pending'},
          {'description': 's1', 'status': 'pending'},
        ]
      });
      applyJsonPatch(doc, [
        {'op': 'replace', 'path': '/steps/0/status', 'value': 'in_progress'}
      ]);
      applyJsonPatch(doc, [
        {'op': 'replace', 'path': '/steps/0/status', 'value': 'completed'}
      ]);
      expect(doc['steps'][0]['status'], 'completed');
      expect(doc['steps'][1]['status'], 'pending');
    });

    test('add to a map key', () {
      final doc = clone({'recipe': {}});
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/recipe/title', 'value': 'Soup'}
      ]);
      expect(doc['recipe']['title'], 'Soup');
    });

    test('add to array via "-" append token', () {
      final doc = clone({
        'recipe': {
          'ingredients': [
            {'name': 'pasta', 'amount': '200g'}
          ]
        }
      });
      applyJsonPatch(doc, [
        {
          'op': 'add',
          'path': '/recipe/ingredients/-',
          'value': {'name': 'basil', 'amount': '1 bunch'}
        }
      ]);
      expect((doc['recipe']['ingredients'] as List).length, 2);
      expect(doc['recipe']['ingredients'][1]['name'], 'basil');
    });

    test('add to array via numeric index insert', () {
      final doc = clone({
        'xs': [1, 3]
      });
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/xs/1', 'value': 2}
      ]);
      expect(doc['xs'], [1, 2, 3]);
    });

    test('remove an array element by index', () {
      final doc = clone({
        'recipe': {
          'ingredients': [
            {'name': 'a'},
            {'name': 'b'},
            {'name': 'c'},
          ]
        }
      });
      applyJsonPatch(doc, [
        {'op': 'remove', 'path': '/recipe/ingredients/1'}
      ]);
      final names =
          (doc['recipe']['ingredients'] as List).map((e) => e['name']).toList();
      expect(names, ['a', 'c']);
    });

    test('remove a map key', () {
      final doc = clone({'_predictive': {'draft': 'x'}, 'recipe': {}});
      applyJsonPatch(doc, [
        {'op': 'remove', 'path': '/_predictive'}
      ]);
      expect(doc.containsKey('_predictive'), false);
      expect(doc.containsKey('recipe'), true);
    });
  });

  group('applyJsonPatch — per-route sequences', () {
    test('shared_state: title, servings, add/remove ingredient, add step', () {
      final doc = clone({
        'recipe': {
          'title': 'Tomato Pasta',
          'servings': 2,
          'ingredients': [
            {'name': 'pasta', 'amount': '200g'}
          ],
          'steps': ['Boil water'],
        }
      });
      applyJsonPatch(doc, [
        {'op': 'replace', 'path': '/recipe/title', 'value': 'Veg Pasta'}
      ]);
      applyJsonPatch(doc, [
        {'op': 'replace', 'path': '/recipe/servings', 'value': 4}
      ]);
      applyJsonPatch(doc, [
        {
          'op': 'add',
          'path': '/recipe/ingredients/-',
          'value': {'name': 'tomato', 'amount': '3'}
        }
      ]);
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/recipe/steps/-', 'value': 'Simmer 10 min'}
      ]);
      applyJsonPatch(doc, [
        {'op': 'remove', 'path': '/recipe/ingredients/0'}
      ]);
      final r = doc['recipe'];
      expect(r['title'], 'Veg Pasta');
      expect(r['servings'], 4);
      expect((r['ingredients'] as List).single['name'], 'tomato');
      expect((r['steps'] as List).length, 2);
    });

    test('predictive: /_predictive add-then-remove leaves the doc clean', () {
      final doc = clone({
        'recipe': {
          'steps': ['old step']
        }
      });
      // Draft re-added each tick (whole object).
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/_predictive', 'value': {'draft': 'step one'}}
      ]);
      applyJsonPatch(doc, [
        {
          'op': 'add',
          'path': '/_predictive',
          'value': {'draft': 'step one\nstep two'}
        }
      ]);
      expect(doc['_predictive']['draft'], 'step one\nstep two');
      // Commit + clear.
      applyJsonPatch(doc, [
        {
          'op': 'add',
          'path': '/recipe/steps',
          'value': ['step one', 'step two']
        }
      ]);
      applyJsonPatch(doc, [
        {'op': 'remove', 'path': '/_predictive'}
      ]);
      expect(doc.containsKey('_predictive'), false);
      expect(doc['recipe']['steps'], ['step one', 'step two']);
    });

    test('dropping every /_predictive delta still reaches committed state', () {
      final doc = clone({
        'recipe': {
          'steps': ['old']
        }
      });
      // Apply ONLY the committed (non-/_predictive) op.
      applyJsonPatch(doc, [
        {
          'op': 'add',
          'path': '/recipe/steps',
          'value': ['a', 'b', 'c']
        }
      ]);
      expect(doc['recipe']['steps'], ['a', 'b', 'c']);
    });
  });

  group('applyJsonPatch — null root guard', () {
    test('per-path op on a null root is a no-op (returns null, no throw)', () {
      final out = applyJsonPatch(null, [
        {'op': 'replace', 'path': '/a', 'value': 1}
      ]);
      expect(out, isNull);
    });

    test('whole-document add on a null root sets the root', () {
      final out = applyJsonPatch(null, [
        {'op': 'add', 'path': '', 'value': {'recipe': {}}}
      ]);
      expect(out, {'recipe': {}});
    });
  });

  group('applyJsonPatch — malformed input throws (documents the contract)', () {
    test('remove past end of array throws', () {
      final doc = clone({'xs': [1, 2]});
      expect(
        () => applyJsonPatch(doc, [
          {'op': 'remove', 'path': '/xs/5'}
        ]),
        throwsA(anything),
      );
    });

    test('"-" token with replace throws (only valid for add)', () {
      final doc = clone({'xs': [1]});
      expect(
        () => applyJsonPatch(doc, [
          {'op': 'replace', 'path': '/xs/-', 'value': 9}
        ]),
        throwsA(anything),
      );
    });

    test('non-integer array index segment throws', () {
      final doc = clone({'xs': [1]});
      expect(
        () => applyJsonPatch(doc, [
          {'op': 'replace', 'path': '/xs/foo', 'value': 9}
        ]),
        throwsA(anything),
      );
    });
  });

  group('applyJsonPatch — pointer parsing', () {
    test('whole-document replace at root', () {
      var doc = clone({'a': 1});
      doc = applyJsonPatch(doc, [
        {'op': 'replace', 'path': '', 'value': {'b': 2}}
      ]);
      expect(doc, {'b': 2});
    });

    test('escaped pointer tokens ~0 and ~1', () {
      final doc = clone({'a/b': {}, 'c~d': {}});
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/a~1b/x', 'value': 1}
      ]);
      applyJsonPatch(doc, [
        {'op': 'add', 'path': '/c~0d/y', 'value': 2}
      ]);
      expect(doc['a/b']['x'], 1);
      expect(doc['c~d']['y'], 2);
    });
  });
}
