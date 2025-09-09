# AG-UI Dart SDK

The official Dart SDK for the AG-UI protocol, standardizing agent-user interactions.

## Installation

This package is distributed via GitHub only (not published to pub.dev). To use it in your Dart or Flutter project, add it as a Git dependency in your `pubspec.yaml` file.

### Using the latest version (unpinned)

```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/ag-ui-protocol/ag-ui.git
      path: sdks/community/dart
```

### Using a specific tag (recommended for production)

```yaml
dependencies:
  ag_ui:
    git:
      url: https://github.com/ag-ui-protocol/ag-ui.git
      path: sdks/community/dart
      ref: v0.1.0  # Replace with desired version tag
```

### Updating to a newer version

To update to the latest version or a newer tag:

1. Update the `ref` field in your `pubspec.yaml` to the desired tag (or remove it for latest)
2. Run `dart pub get` or `flutter pub get` to fetch the updated package

### Available versions

Check the [GitHub Releases](https://github.com/ag-ui-protocol/ag-ui/releases) page for available version tags.

For more information about Git dependencies in Dart, see the [official documentation](https://dart.dev/tools/pub/dependencies#git-packages).

## Usage

```dart
import 'package:ag_ui/ag_ui.dart';

void main() {
  AgUI.init();
  // Your code here
}
```

## Features

- Event-driven communication between agents and UIs
- Support for multiple transport protocols (SSE, WebSockets, HTTP)
- Tool-based generative UI capabilities
- Human-in-the-loop interactions
- State management with snapshots and deltas

## Documentation

For full documentation, visit [https://docs.ag-ui.com](https://docs.ag-ui.com)

## Example

See the [example](example/) directory for a complete demonstration of AG-UI features.

## License

See the main repository for license information.