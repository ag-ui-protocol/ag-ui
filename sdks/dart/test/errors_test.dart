import 'package:agui/agui.dart';
import 'package:test/test.dart';

void main() {
  test('decode exception names the definition and path', () {
    const e = AguiDecodeException(
      definition: 'TextMessageContentEvent',
      path: '/delta',
      message: 'expected string, received number',
    );
    expect(
      e.toString(),
      'TextMessageContentEvent at /delta: expected string, received number',
    );
  });

  test('protocol exception prints its message bare', () {
    expect(
      const AguiProtocolException("First event must be 'RUN_STARTED'")
          .toString(),
      "First event must be 'RUN_STARTED'",
    );
  });
}
