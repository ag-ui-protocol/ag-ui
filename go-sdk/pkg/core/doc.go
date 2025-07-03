// Package core provides the foundational types and interfaces for the AG-UI protocol.
//
// This package defines the core abstractions that enable communication between
// AI agents and front-end applications through the AG-UI protocol. It includes
// event types, agent interfaces, and fundamental protocol structures.
//
// The AG-UI protocol is a lightweight, event-based system that standardizes
// how AI agents connect to front-end applications, enabling:
//   - Real-time streaming communication
//   - Bidirectional state synchronization
//   - Human-in-the-loop collaboration
//   - Tool-based interactions
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/core"
//
//	// Define an agent that implements the core interfaces
//	type MyAgent struct {
//		// agent implementation
//	}
//
//	func (a *MyAgent) HandleEvent(ctx context.Context, event core.Event) error {
//		// handle incoming events from the frontend
//		return nil
//	}
package core
