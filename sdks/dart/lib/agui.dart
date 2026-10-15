/// Dart client for the AG-UI protocol.
library;

export 'src/client/agent.dart';
export 'src/client/http_agent.dart';
export 'src/client/ids.dart';
export 'src/client/warnings.dart';
export 'src/codec/omit_optional_nulls.dart';
export 'src/errors.dart';
export 'src/generated/models.dart';
export 'src/generated/shapes.dart';
export 'src/generated/version.dart';
export 'src/pipeline/compat/boundary.dart' show decodeLegacyMessage;
export 'src/pipeline/json_patch.dart';
export 'src/pipeline/versions.dart';
export 'src/sse/sse_parser.dart';
