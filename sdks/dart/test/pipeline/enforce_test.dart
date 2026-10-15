import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/enforce.dart';
import 'package:test/test.dart';

void main() {
  test('an unknown event type is dropped with a warning', () async {
    final warnings = <String>[];
    final out =
        await enforceEvents(
          Stream.fromIterable([
            {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
            {'type': 'FUTURE_EVENT', 'x': 1},
          ]),
          warnings.add,
        ).toList();
    expect(out.map((e) => e.type), [EventType.runStarted]);
    expect(
      warnings.single,
      contains("Dropping unrecognised event 'FUTURE_EVENT'"),
    );
  });

  test('a stripped property warns with its path', () async {
    final warnings = <String>[];
    final out =
        await enforceEvents(
          Stream.fromIterable([
            {
              'type': 'RUN_STARTED',
              'threadId': 't',
              'runId': 'r',
              'futureProp': 1,
            },
          ]),
          warnings.add,
        ).toList();
    expect(out.single.toJson().containsKey('futureProp'), isFalse);
    expect(warnings.single, contains("'/futureProp'"));
    expect(warnings.single, contains('RUN_STARTED'));
  });

  test('a malformed known field fails the stream', () {
    expect(
      enforceEvents(
        Stream.fromIterable([
          {
            'type': 'RUN_FINISHED',
            'threadId': 't',
            'runId': 'r',
            'outcome': ['x'],
          },
        ]),
        ignoreWarnings,
      ).toList(),
      throwsA(
        isA<AguiDecodeException>().having(
          (e) => e.toString(),
          'toString',
          contains('expected object, received array'),
        ),
      ),
    );
  });
}
