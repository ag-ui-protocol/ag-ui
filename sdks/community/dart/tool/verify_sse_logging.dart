import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';

Future<void> main() async {
  final info = await developer.Service.getInfo();
  final uri = info.serverUri;
  if (uri == null) {
    throw StateError('Run with --enable-vm-service=0');
  }

  final socket = await WebSocket.connect(
    uri.replace(scheme: 'ws', path: '${uri.path}ws').toString(),
  );
  final subscribed = Completer<void>();
  final barrier = Completer<void>();
  final logs = <String>[];
  final prints = <String>[];
  const canary = 'SYNTHETIC_SSE_CANARY';
  final subscription = socket.listen((data) {
    final event = jsonDecode(data as String) as Map<String, dynamic>;
    if (event['id'] == '1') {
      if (event.containsKey('error')) {
        subscribed.completeError(StateError('Logging subscription failed'));
      } else {
        subscribed.complete();
      }
    }
    if (event['method'] == 'streamNotify') {
      logs.add(data);
      if (data.contains('SSE_LOG_CAPTURE_COMPLETE')) {
        barrier.complete();
      }
    }
  });

  try {
    socket.add(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': '1',
        'method': 'streamListen',
        'params': {'streamId': 'Logging'},
      }),
    );
    await subscribed.future.timeout(const Duration(seconds: 5));
    await runZoned(
      () async {
        for (final prefix in [
          'data: ',
          ':',
          'unknown: ',
          'event: ',
          'id: ',
          'retry: ',
        ]) {
          try {
            await SseClient(maxLineCodeUnits: 32)
                .parseStream(
                  Stream.value(utf8.encode('$prefix${canary * 5}')),
                )
                .drain<void>();
            throw StateError('missing overflow');
          } on FormatException catch (error) {
            if (error.source != null || error.toString().contains(canary)) {
              throw StateError('input appeared in the parser error');
            }
          }
        }

        final messages = await SseClient(maxLineCodeUnits: 4096)
            .parseStream(
              Stream.value(
                utf8.encode(
                  'id: keep\nid: ${canary * 60}\ndata: ok\n\n',
                ),
              ),
            )
            .toList();
        if (messages.single.id != 'keep') {
          throw StateError('oversized ID replaced the prior ID');
        }
        developer.log('SSE_LOG_CAPTURE_COMPLETE', name: 'ag_ui.sse_probe');
      },
      zoneSpecification: ZoneSpecification(
        print: (_, __, ___, text) {
          prints.add(text);
        },
      ),
    );
    await barrier.future.timeout(const Duration(seconds: 5));
    if (!logs.any((line) => line.contains('SSE id field dropped'))) {
      throw StateError('parser logging was not captured');
    }
    if ([...logs, ...prints].any((line) => line.contains(canary))) {
      throw StateError('input appeared in diagnostics');
    }

    // ignore: avoid_print
    print('PASS: SSE diagnostics contain no input canaries');
  } finally {
    await subscription.cancel();
    await socket.close();
  }
}
