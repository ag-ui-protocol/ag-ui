# Protocol Buffer Definitions and Code Generation

This directory contains the Protocol Buffer (`.proto`) files that define the AG-UI (Agent-User Interaction Protocol) message formats. These files are used to generate Go code for efficient serialization and cross-platform compatibility with the TypeScript and Python SDKs.

## Overview

The AG-UI protocol defines 16 standardized event types for communication between AI agents and front-end applications:

- **Text Message Events**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`
- **Tool Call Events**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`
- **State Events**: `STATE_SNAPSHOT`, `STATE_DELTA`
- **Message Events**: `MESSAGES_SNAPSHOT`
- **Run Events**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Step Events**: `STEP_STARTED`, `STEP_FINISHED`
- **Utility Events**: `RAW`, `CUSTOM`

## File Structure

```
proto/
├── README.md              # This file
├── events.proto           # Core event definitions
├── types.proto            # Common message types (Message, ToolCall)
└── patch.proto            # JSON Patch operations for state deltas
```

## Generated Code

Generated Go code is placed in `pkg/proto/generated/`:

```
pkg/proto/generated/
├── events.pb.go           # Generated from events.proto
├── types.pb.go            # Generated from types.proto
└── patch.pb.go            # Generated from patch.proto
```

## Code Generation

### Prerequisites

- `protoc` compiler (version 3.21+)
- `protoc-gen-go` plugin for Go code generation

Install required tools:

```bash
# Install protoc (macOS with Homebrew)
brew install protobuf

# Install Go plugin
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
```

### Generation Commands

#### Using Make (Recommended)

```bash
# Generate all protobuf code
make proto-gen

# Clean generated files
make proto-clean

# Install development tools
make tools-install
```

#### Manual Generation

```bash
# Generate Go code from proto files
protoc \
  --go_out=pkg/proto/generated \
  --go_opt=paths=source_relative \
  --proto_path=proto \
  proto/*.proto
```

### Automated Verification

Verify that the generated code is compatible with the TypeScript SDK:

```bash
go run scripts/verify-proto-compatibility.go
```

## Features

### Go Integration

- **Proper Go Naming**: Generated types follow Go conventions (PascalCase for exports)
- **JSON Compatibility**: Includes JSON tags with camelCase field names for REST API compatibility
- **Optional Fields**: Uses Go pointers for optional protobuf fields
- **Type Safety**: Full type safety with compile-time validation

### Cross-SDK Compatibility

- **TypeScript SDK**: Field names match camelCase conventions used in TypeScript
- **Python SDK**: Binary protobuf format is identical across all implementations
- **JSON Interoperability**: JSON serialization is compatible between all SDKs

### Example Usage

```go
package main

import (
    "github.com/ag-ui/go-sdk/pkg/proto/generated"
    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/encoding/protojson"
)

func main() {
    // Create an event
    baseEvent := &generated.BaseEvent{
        Type:      generated.EventType_TEXT_MESSAGE_START,
        Timestamp: proto.Int64(time.Now().Unix()),
    }

    textEvent := &generated.TextMessageStartEvent{
        BaseEvent: baseEvent,
        MessageId: "msg-123",
        Role:      proto.String("user"),
    }

    // Serialize to binary protobuf
    binaryData, err := proto.Marshal(textEvent)
    if err != nil {
        log.Fatal(err)
    }

    // Serialize to JSON
    jsonData, err := protojson.Marshal(textEvent)
    if err != nil {
        log.Fatal(err)
    }

    // Deserialize from binary
    var decoded generated.TextMessageStartEvent
    err = proto.Unmarshal(binaryData, &decoded)
    if err != nil {
        log.Fatal(err)
    }
}
```

## Protocol Specification

### Event Types

All events include a `BaseEvent` with:
- `type`: Event type identifier
- `timestamp`: Optional Unix timestamp
- `raw_event`: Optional raw event data

### Message Structure

Messages follow this structure:
- `id`: Unique message identifier
- `role`: Message role (user, assistant, system, tool)
- `content`: Optional message content
- `tool_calls`: Array of tool call objects
- `tool_call_id`: Optional tool call identifier for tool responses

### Tool Calls

Tool calls include:
- `id`: Unique tool call identifier
- `type`: Tool call type (typically "function")
- `function`: Function details with name and arguments

## Development Workflow

1. **Modify Proto Files**: Edit `.proto` files in this directory
2. **Regenerate Code**: Run `make proto-gen` to update generated Go code
3. **Verify Compatibility**: Run `go run scripts/verify-proto-compatibility.go`
4. **Test Changes**: Ensure all tests pass with `go test ./...`
5. **Commit Changes**: Include both `.proto` files and generated `.pb.go` files

## Cross-Platform Compatibility

The protocol buffer definitions in this directory are shared with:

- **TypeScript SDK**: Source definitions in `typescript-sdk/packages/proto/src/proto/`
- **Python SDK**: Generated code used by `python-sdk/ag_ui/core/`

When modifying protocol definitions:

1. Update the corresponding files in other SDKs
2. Verify binary compatibility between implementations
3. Test JSON serialization compatibility
4. Update SDK version compatibility matrices

## Troubleshooting

### Common Issues

1. **Missing protoc**: Install Protocol Buffer compiler
2. **Missing protoc-gen-go**: Install with `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest`
3. **Import errors**: Ensure `google.golang.org/protobuf` is in go.mod
4. **JSON field names**: Verify camelCase field names in generated JSON tags

### Verification

Run the compatibility verification script to check for common issues:

```bash
go run scripts/verify-proto-compatibility.go
```

This script verifies:
- All event types are present with correct values
- JSON field naming follows camelCase conventions
- Complex message structures serialize correctly
- Binary protobuf compatibility is maintained

## Version Compatibility

- **Protocol Version**: Based on TypeScript SDK v0.0.30
- **Protoc Version**: 3.21+ (tested with 5.29.3)
- **Go Protobuf**: v1.36.6+
- **Go Version**: 1.24.4+

For the latest compatibility information, see the main [README.md](../README.md) file. 