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
//	package main
//
//	import (
//		"context"
//		"log"
//		"time"
//
//		"github.com/ag-ui/go-sdk/pkg/core"
//	)
//
//	// MyAgent implements the core.Agent interface
//	type MyAgent struct {
//		name string
//	}
//
//	func (a *MyAgent) Name() string { return a.name }
//	func (a *MyAgent) Description() string { return "Example agent that echoes messages" }
//
//	func (a *MyAgent) HandleEvent(ctx context.Context, event interface{}) ([]interface{}, error) {
//		log.Printf("Agent %s received event", a.name)
//
//		// Type assert to get a specific event type
//		if msgEvent, ok := event.(core.MessageEvent); ok {
//			log.Printf("Processing message: %s", msgEvent.Data().Content)
//
//			// Create a response event
//			response := core.NewEvent("response-123", "message", core.MessageData{
//				Content: "Echo: " + msgEvent.Data().Content,
//				Sender:  a.name,
//			})
//
//			return []interface{}{response}, nil
//		}
//
//		return nil, nil
//	}
//
//	func main() {
//		agent := &MyAgent{name: "echo-agent"}
//
//		// Create a message event
//		event := core.NewEvent("msg-123", "message", core.MessageData{
//			Content: "Hello, agent!",
//			Sender:  "user",
//		})
//
//		// Process the event
//		responses, err := agent.HandleEvent(context.Background(), event)
//		if err != nil {
//			log.Fatal(err)
//		}
//
//		log.Printf("Agent returned %d responses", len(responses))
//	}
package core
