import 'base_uri_stub.dart' if (dart.library.js_interop) 'base_uri_web.dart';
import 'errors.dart';
import 'validators.dart';

/// Resolve browser path references without changing absolute URL handling.
String resolveBaseUrl(String baseUrl) {
  // Validate before resolution so normalization cannot hide invalid input.
  Validators.validateUrl(baseUrl, 'baseUrl', allowRelative: true);
  final uri = Uri.parse(baseUrl);
  if (uri.hasScheme) {
    return baseUrl;
  }

  if (uri.hasQuery || uri.hasFragment) {
    throw ValidationError(
      'Relative baseUrl must be a path without a query or fragment',
      field: 'baseUrl',
      constraint: 'path-only',
      value: baseUrl,
    );
  }

  final base = documentBaseUri;
  if (base == null || (base.scheme != 'http' && base.scheme != 'https')) {
    throw ValidationError(
      'Relative baseUrl requires an HTTP(S) browser document; '
      'use an absolute HTTP(S) URL on native platforms',
      field: 'baseUrl',
      constraint: 'absolute-url-required',
      value: baseUrl,
    );
  }
  final resolved = base.resolveUri(uri).toString();
  Validators.validateUrl(resolved, 'baseUrl');
  // runAgent appends a slash before its endpoint. Avoid a duplicate slash
  // for relative bases such as "/", ".", or "api/"; preserve absolute inputs.
  return resolved.endsWith('/')
      ? resolved.substring(0, resolved.length - 1)
      : resolved;
}
