/// Every failure this package raises.
sealed class AguiException implements Exception {
  const AguiException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// A JSON document that does not match the protocol definition it was decoded
/// against: a missing required field, a wrong type, an unknown enum value or
/// an unknown discriminator. [path] is a JSON pointer into the document
/// (`''` for the whole value).
final class AguiDecodeException extends AguiException {
  const AguiDecodeException({
    required this.definition,
    required this.path,
    required String message,
  }) : super(message);

  final String definition;
  final String path;

  @override
  String toString() => '$definition at $path: $message';
}

/// A stream that breaks the protocol's lifecycle or streaming rules.
final class AguiProtocolException extends AguiException {
  const AguiProtocolException(super.message);
}

/// An HTTP response the transport cannot use.
final class AguiHttpException extends AguiException {
  const AguiHttpException(super.message, {required this.statusCode, this.body});

  final int statusCode;
  final String? body;
}

/// The agent was used in a way its lifecycle forbids, such as starting a run
/// while one is active.
final class AguiStateException extends AguiException {
  const AguiStateException(super.message);
}
