import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/ag_ui.dart';

void _check(bool condition, String reason) {
  if (!condition) {
    throw StateError(reason);
  }
}

Future<void> _verifyOpenOverflow(
  String prefix, {
  required bool fragmented,
}) async {
  const limit = 32;
  var cancellations = 0;
  var messages = 0;
  final source = StreamController<List<int>>(
    onCancel: () {
      cancellations++;
    },
  );
  final failure = Completer<Object>();
  final subscription =
      SseClient(maxLineCodeUnits: limit).parseStream(source.stream).listen(
    (_) {
      messages++;
    },
    onError: failure.complete,
  );

  try {
    final exact = utf8.encode(prefix.padRight(limit, 'x'));
    if (fragmented) {
      for (final byte in exact) {
        source.add([byte]);
      }
    } else {
      source.add(exact);
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    _check(!failure.isCompleted, 'exact line failed before overflow');

    source.add([0x78]);
    final error = await failure.future.timeout(const Duration(seconds: 3));
    _check(!source.isClosed, 'source closed before overflow was reported');
    _check(
      error is FormatException && error.source == null && error.offset == null,
      'expected a content-free FormatException',
    );
    _check(messages == 0, 'partial message escaped');
    await subscription.cancel();
    _check(cancellations == 1, 'source cancellation count was not one');
  } finally {
    await subscription.cancel();
    await source.close();
  }
}

Future<void> main() async {
  for (final prefix in ['data: ', ':', 'unknown: ']) {
    for (final fragmented in [false, true]) {
      await _verifyOpenOverflow(prefix, fragmented: fragmented);
    }
  }

  final client = SseClient(maxDataCodeUnits: 8);
  _check(client.maxLineCodeUnits == 15, 'line limit was not derived');
  final exact = await client
      .parseStream(
        Stream.value(
          utf8.encode('event: 12345678\ndata: 12345678'),
        ),
      )
      .toList();
  _check(
    exact.length == 1 &&
        exact.single.data == '12345678' &&
        exact.single.event == '12345678',
    'exact data and event boundaries failed',
  );

  var aggregateRejected = false;
  try {
    await client
        .parseStream(Stream.value(utf8.encode('data: 1234\ndata: 5678\n')))
        .drain<void>();
  } on FormatException catch (error) {
    aggregateRejected = error.source == null;
  }
  _check(aggregateRejected, 'aggregate data beyond the limit was accepted');
  await client.close();

  // ignore: avoid_print
  print('PASS: bounded SSE byte parsing');
}
