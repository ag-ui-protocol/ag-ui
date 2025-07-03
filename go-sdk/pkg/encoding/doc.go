// Package encoding provides event encoding and decoding for the AG-UI protocol.
//
// This package handles the serialization and deserialization of AG-UI events
// for transmission over various transport layers. It supports multiple encoding
// formats including JSON and Protocol Buffers, with automatic format detection
// and conversion capabilities.
//
// The encoding system is designed to be extensible, allowing new formats to be
// added without breaking existing code. It also provides validation and
// schema enforcement for event data.
//
// Supported formats:
//   - JSON: Human-readable format for debugging and development
//   - Protocol Buffers: High-performance binary format for production
//   - MessagePack: Compact binary format for bandwidth-sensitive applications
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/encoding"
//
//	// Create a JSON encoder
//	encoder := encoding.NewJSON()
//
//	// Encode an event
//	data, err := encoder.Encode(event)
//	if err != nil {
//		log.Fatal(err)
//	}
//
//	// Decode an event
//	event, err := encoder.Decode(data)
//	if err != nil {
//		log.Fatal(err)
//	}
package encoding
