@TestOn('browser')
library;

import 'dart:js_interop';

import 'package:ag_ui/ag_ui.dart';
import 'package:ag_ui/src/client/base_url.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

@JS('window')
external JSObject get _window;

@JS('window.parent')
external JSObject get _parent;

@JS('document')
external _Document get _document;

extension type _Document(JSObject _) implements JSObject {
  external String get baseURI;
  external _Element get head;
  external _Element createElement(String tag);
  external _Element? querySelector(String selector);
}

extension type _Element(JSObject _) implements JSObject {
  external String? getAttribute(String name);
  external void setAttribute(String name, String value);
  external void removeAttribute(String name);
  external void prepend(_Element element);
  external void remove();
}

void main() {
  late _Element base;
  late bool created;
  String? oldHref;

  setUp(() {
    final existing = _document.querySelector('base');
    created = existing == null;
    base = existing ?? _document.createElement('base');
    oldHref = base.getAttribute('href');
    if (created) {
      _document.head.prepend(base);
    }
  });

  tearDown(() {
    if (created) {
      base.remove();
    } else if (oldHref == null) {
      base.removeAttribute('href');
    } else {
      base.setAttribute('href', oldHref!);
    }
  });

  Future<void> expectRequest(String baseUrl, String expected) async {
    var calls = 0;
    final client = AgUiClient(
      config: AgUiClientConfig(baseUrl: baseUrl),
      httpClient: MockClient((request) async {
        calls++;
        expect(request.url.toString(), expected);
        expect(request.method, 'POST');
        return http.Response(
          '',
          200,
          headers: {'content-type': 'text/event-stream'},
        );
      }),
    );
    addTearDown(client.close);
    await client
        .runAgent('run', const SimpleRunAgentInput(messages: []))
        .toList();
    expect(calls, 1);
  }

  test('uses the test iframe document rather than its parent', () async {
    // package:test loads browser suites in an iframe.
    expect(_window == _parent, isFalse);
    base.setAttribute('href', '/iframe-app/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('api/agui', '$origin/iframe-app/api/agui/run');
  });

  test('rejects credential-bearing document bases', () {
    base.setAttribute('href', 'https://user:pass@example.com/app/');
    expect(() => resolveBaseUrl('api'), throwsA(isA<ValidationError>()));
  });

  test('rejects non-HTTP document bases', () {
    base.setAttribute('href', 'file:///app/');
    expect(() => resolveBaseUrl('api'), throwsA(isA<ValidationError>()));
  });

  test('path-relative base honors this document base href', () async {
    base.setAttribute('href', '/my-app/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('api/agui', '$origin/my-app/api/agui/run');
  });

  test('root and trailing-slash paths do not add duplicate slashes', () async {
    base.setAttribute('href', '/my-app/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('/', '$origin/run');
    await expectRequest('.', '$origin/my-app/run');
    await expectRequest('api/', '$origin/my-app/api/run');
  });

  test('root-relative base stays at the origin root', () async {
    base.setAttribute('href', '/my-app/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('/api/agui', '$origin/api/agui/run');
  });

  test('without base href uses this document URL', () async {
    base.removeAttribute('href');
    final expected = Uri.parse(_document.baseURI).resolve('api/agui');
    await expectRequest('api/agui', '$expected/run');
  });

  test('path-relative URL uses an absolute cross-origin document base',
      () async {
    base.setAttribute('href', 'https://backend.example/app/');
    await expectRequest('api/agui', 'https://backend.example/app/api/agui/run');
    await expectRequest('/api/agui', 'https://backend.example/api/agui/run');
  });

  test('dot segments resolve against the document base', () async {
    base.setAttribute('href', '/my-app/nested/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('../api/agui', '$origin/my-app/api/agui/run');
    await expectRequest('./api/agui', '$origin/my-app/nested/api/agui/run');
  });

  test('absolute URL ignores document base href', () async {
    base.setAttribute('href', '/my-app/');
    await expectRequest(
      'https://example.com/api',
      'https://example.com/api/run',
    );
  });

  test('reads changed base href for each call', () async {
    base.setAttribute('href', '/first/');
    final origin = Uri.parse(_document.baseURI).origin;
    await expectRequest('api', '$origin/first/api/run');
    base.setAttribute('href', '/second/');
    await expectRequest('api', '$origin/second/api/run');
  });
}
