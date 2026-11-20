import 'dart:js_interop';

@JS('document.baseURI')
external JSString get _documentBaseUri;

/// Use this document, including its base href, rather than the parent frame.
Uri? get documentBaseUri => Uri.tryParse(_documentBaseUri.toDart);
