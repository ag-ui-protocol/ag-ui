@TestOn('vm')
library;

import 'package:ag_ui/src/client/base_url.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:test/test.dart';

void main() {
  for (final value in ['api/agui', '/api/agui']) {
    test('native rejects relative base $value with clear error', () {
      expect(
        () => resolveBaseUrl(value),
        throwsA(
          isA<ValidationError>().having(
            (error) => error.constraint,
            'constraint',
            'absolute-url-required',
          ),
        ),
      );
    });
  }
}
