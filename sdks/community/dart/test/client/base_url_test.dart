import 'package:ag_ui/src/client/base_url.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:test/test.dart';

void main() {
  test('absolute base URLs are unchanged', () {
    for (final value in [
      'https://example.com/api',
      'http://localhost:8000',
      'https://example.com/%E9',
      'https://example.com/%FF',
    ]) {
      expect(resolveBaseUrl(value), value);
    }
  });

  for (final value in [
    '',
    '//example.com/api',
    '//user:pass@example.com/api',
    'ftp://example.com/api',
    'https://user:pass@example.com/api',
    'http://',
    'api?token=value',
    'api#fragment',
    '?token=value',
    '#fragment',
    'api/%0a/run',
    'api/%0d/../run',
    'api/%E2%80%A8/run',
    'https://example.com/%0a/run',
    'api/\nrun',
    'api/\r/../run',
    'api/\u2028run',
    'https://example.com/\nrun',
  ]) {
    test('rejects unsafe base URL ${value.codeUnits}', () {
      final containsControl = value.contains('%0') ||
          value.contains('%E2%80%A8') ||
          RegExp('[\x00-\x1f\x7f\u2028]').hasMatch(value);
      expect(
        () => resolveBaseUrl(value),
        throwsA(
          containsControl
              ? isA<ValidationError>().having(
                  (error) => error.constraint,
                  'constraint',
                  'no-control-chars',
                )
              : isA<ValidationError>(),
        ),
      );
    });
  }
}
