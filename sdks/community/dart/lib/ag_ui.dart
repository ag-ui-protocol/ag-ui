/// AG-UI Dart SDK - Standardizing agent-user interactions
///
/// This library provides strongly-typed Dart models for the AG-UI protocol,
/// enabling agent-user interaction through a standardized event-based system.
library ag_ui;

// Core types
export 'src/types/types.dart';

// Event types
export 'src/events/events.dart';

// SSE client
export 'src/sse/sse_client.dart';
export 'src/sse/sse_message.dart';
export 'src/sse/backoff_strategy.dart';

// Core exports will be added in subsequent tasks
// export 'src/agent.dart';
// export 'src/client.dart';
// export 'src/transport.dart';

/// SDK version
const String agUiVersion = '0.1.0';

/// Initialize the AG-UI SDK
void initAgUI() {
  // Initialization logic will be implemented in subsequent tasks
}
