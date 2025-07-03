// Package transport provides transport layer implementations for the AG-UI protocol.
//
// This package implements various transport mechanisms for communication between
// AG-UI clients and servers, including HTTP/SSE and WebSocket transports.
// It handles low-level protocol details, connection management, and event
// serialization/deserialization.
//
// The transport layer is designed to be pluggable, allowing different
// implementations to be used based on requirements such as latency,
// reliability, and scalability.
//
// Supported transports:
//   - HTTP/SSE: Server-Sent Events over HTTP for real-time streaming
//   - WebSocket: Full-duplex communication for low-latency applications
//   - HTTP: Traditional request-response for simple interactions
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/transport"
//
//	// Create an HTTP/SSE transport
//	t, err := transport.NewHTTPSSE(transport.Config{
//		BaseURL: "http://localhost:8080",
//	})
//	if err != nil {
//		log.Fatal(err)
//	}
//
//	// Send an event
//	err = t.SendEvent(ctx, event)
//	if err != nil {
//		log.Fatal(err)
//	}
package transport
