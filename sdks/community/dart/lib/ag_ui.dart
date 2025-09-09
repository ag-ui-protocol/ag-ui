/// AG-UI Dart SDK - Standardizing agent-user interactions
///
/// This library provides strongly-typed Dart models for the AG-UI protocol,
/// enabling agent-user interaction through a standardized event-based system.
library ag_ui;

// Core types
export 'src/types/types.dart';

// Event types
export 'src/events/events.dart';

// Encoder/Decoder
export 'src/encoder/encoder.dart';
export 'src/encoder/decoder.dart';
export 'src/encoder/stream_adapter.dart';
// Hide ValidationError from encoder/errors.dart since we're using the one from client/errors.dart
export 'src/encoder/errors.dart' hide ValidationError;

// SSE client
export 'src/sse/sse_client.dart';
export 'src/sse/sse_message.dart';
export 'src/sse/backoff_strategy.dart';

// Client API
export 'src/client/client.dart';
export 'src/client/config.dart';
export 'src/client/errors.dart';
export 'src/client/validators.dart';

// Client codec (hide ToolResult since it's defined in types/tool.dart)
export 'src/encoder/client_codec.dart' hide ToolResult;

// Core exports will be added in subsequent tasks
// export 'src/agent.dart';
// export 'src/transport.dart';

/// SDK version
const String agUiVersion = '0.1.0';

/// Initialize the AG-UI SDK
void initAgUI() {
  // Initialization logic will be implemented in subsequent tasks
}
