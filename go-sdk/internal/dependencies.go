// Package internal contains dependencies import file.
// This file ensures dependencies are preserved in go.mod during development.
// These dependencies will be used in upcoming implementations:
// - github.com/evanphx/json-patch/v5: For JSON Patch operations in state management
// - github.com/google/uuid: For generating unique event and message IDs
// - github.com/gorilla/websocket: For WebSocket transport implementation
// - github.com/sirupsen/logrus: For structured logging in the SDK
// - golang.org/x/net/http2: For HTTP/2 transport optimization
// - golang.org/x/sync/errgroup: For concurrent event processing
// - google.golang.org/grpc: For gRPC transport option
// - google.golang.org/protobuf/proto: Already in use for protobuf serialization
// - github.com/stretchr/testify/assert: For comprehensive unit testing
package internal

import (
	// Core Runtime Dependencies - to be used in transport and state management
	_ "github.com/evanphx/json-patch/v5" // JSON Patch operations
	_ "github.com/google/uuid"           // UUID generation for events
	_ "github.com/gorilla/websocket"     // WebSocket transport
	_ "github.com/sirupsen/logrus"       // Structured logging

	// Performance and Concurrency Dependencies
	_ "golang.org/x/net/http2"     // HTTP/2 transport optimization
	_ "golang.org/x/sync/errgroup" // Concurrent processing utilities

	// Protocol and Communication Dependencies
	_ "google.golang.org/grpc"           // gRPC transport (optional)
	_ "google.golang.org/protobuf/proto" // Protobuf serialization (in use)

	// Testing Dependencies
	_ "github.com/stretchr/testify/assert" // Enhanced test assertions
)
