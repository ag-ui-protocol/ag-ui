module github.com/ag-ui/go-sdk

go 1.24.4

require (
	github.com/evanphx/json-patch/v5 v5.9.11 // RFC 6902 JSON Patch implementation
	github.com/google/uuid v1.6.0 // RFC 4122 UUID generation
	// Core Runtime Dependencies
	github.com/gorilla/websocket v1.5.3 // WebSocket transport for real-time communication
	github.com/sirupsen/logrus v1.9.3 // Structured logging
	golang.org/x/net v0.38.0 // Extended network libraries
	golang.org/x/sync v0.12.0 // Extended synchronization primitives
	google.golang.org/grpc v1.73.0 // gRPC transport for protocol extensions
	google.golang.org/protobuf v1.36.6 // Protocol buffer runtime
)

// Testing Dependencies
require github.com/stretchr/testify v1.10.0 // Rich testing framework

require (
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	golang.org/x/sys v0.31.0 // indirect
	golang.org/x/text v0.23.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20250324211829-b45e905df463 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
