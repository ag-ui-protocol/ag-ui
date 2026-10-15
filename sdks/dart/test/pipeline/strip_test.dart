import 'package:agui/src/pipeline/strip.dart';
import 'package:test/test.dart';

void main() {
  test('drops an unknown property on a closed object and names it', () {
    final r = stripUnknown({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      'futureProp': 1,
    }, 'RunStartedEvent');
    expect(r.value.containsKey('futureProp'), isFalse);
    expect(r.stripped, ['/futureProp']);
  });

  test('keeps extras on an open patch operation', () {
    final r = stripUnknown({
      'type': 'STATE_DELTA',
      'delta': [
        {'op': 'add', 'path': '/a', 'value': 1, 'note': 'x'},
      ],
    }, 'StateDeltaEvent');
    expect(r.stripped, isEmpty);
    expect(((r.value['delta'] as List).first as Map)['note'], 'x');
  });

  test('drops an unknown union member from an array', () {
    final r = stripUnknown({
      'type': 'STATE_DELTA',
      'delta': [
        {'op': 'teleport', 'path': '/a'},
        {'op': 'remove', 'path': '/b'},
      ],
    }, 'StateDeltaEvent');
    expect(r.stripped, ['/delta/0']);
    expect((r.value['delta'] as List).length, 1);
  });

  test('drops an unknown outcome and names the key', () {
    final r = stripUnknown({
      'type': 'RUN_FINISHED',
      'threadId': 't',
      'runId': 'r',
      'outcome': {'type': 'paused'},
    }, 'RunFinishedEvent');
    expect(r.stripped, ['/outcome']);
    expect(r.value.containsKey('outcome'), isFalse);
  });

  test('drops an unknown part inside a snapshot message', () {
    final r = stripUnknown({
      'type': 'MESSAGES_SNAPSHOT',
      'messages': [
        {
          'id': 'u',
          'role': 'user',
          'content': [
            {'type': 'text', 'text': 'a'},
            {'type': 'hologram'},
          ],
        },
      ],
    }, 'MessagesSnapshotEvent');
    expect(r.stripped, ['/messages/0/content/1']);
  });

  test('a media part with an unknown source kind drops the whole part', () {
    final r = stripUnknown({
      'type': 'MESSAGES_SNAPSHOT',
      'messages': [
        {
          'id': 'u',
          'role': 'user',
          'content': [
            {
              'type': 'image',
              'source': {
                'type': 'teleport',
                'value': 'x',
                'mimeType': 'image/png',
              },
            },
          ],
        },
      ],
    }, 'MessagesSnapshotEvent');
    expect(r.stripped, ['/messages/0/content/0']);
    expect(((r.value['messages'] as List).first as Map)['content'], isEmpty);
  });

  test('leaves a malformed known value for the decoder', () {
    final r = stripUnknown({
      'type': 'RUN_FINISHED',
      'threadId': 't',
      'runId': 'r',
      'outcome': ['x'],
    }, 'RunFinishedEvent');
    expect(r.stripped, isEmpty);
    expect(r.value['outcome'], ['x']);
  });

  test('does not walk opaque positions', () {
    final r = stripUnknown({
      'type': 'STATE_SNAPSHOT',
      'snapshot': {'anything': 1, 'type': 'x'},
      'metadata': {
        'k': {'deep': null},
      },
    }, 'StateSnapshotEvent');
    expect(r.stripped, isEmpty);
    expect(r.value['snapshot'], {'anything': 1, 'type': 'x'});
  });
}
