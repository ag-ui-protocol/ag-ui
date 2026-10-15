import 'package:agui/agui.dart';
import 'package:test/test.dart';

void main() {
  test('uuidV4 has the v4 shape and is unique', () {
    final re = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    final ids = {for (var i = 0; i < 100; i++) uuidV4()};
    expect(ids.length, 100);
    for (final id in ids) {
      expect(re.hasMatch(id), isTrue, reason: id);
    }
  });

  test('compareProtocolVersions is numeric and pads missing components', () {
    expect(compareProtocolVersions('1.0', '1.0.0'), 0);
    expect(compareProtocolVersions('0.0.57', '1.0'), lessThan(0));
    expect(compareProtocolVersions('1.10', '1.9'), greaterThan(0));
    expect(compareProtocolVersions('0.0.45', '0.0.45'), 0);
  });
}
