import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('AG-UI SDK', () {
    test('has correct version', () {
      expect(AgUI.version, '0.1.0');
    });
    
    test('can initialize', () {
      expect(() => AgUI.init(), returnsNormally);
    });
  });
}