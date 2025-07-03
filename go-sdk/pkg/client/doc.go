// Package client provides the client SDK for connecting to AG-UI servers.
//
// This package enables Go applications to connect to AG-UI servers and interact
// with AI agents. It provides a high-level API for sending events, receiving
// responses, and managing the connection lifecycle.
//
// The client supports multiple transport mechanisms including HTTP/SSE and
// WebSocket connections, with automatic reconnection and error handling.
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/client"
//
//	// Create a new client
//	c, err := client.New("http://localhost:8080/ag-ui")
//	if err != nil {
//		log.Fatal(err)
//	}
//	defer c.Close()
//
//	// Send an event to an agent
//	event := &client.MessageEvent{
//		Content: "Hello, agent!",
//	}
//
//	response, err := c.SendEvent(ctx, "my-agent", event)
//	if err != nil {
//		log.Fatal(err)
//	}
//
//	// Process the response
//	fmt.Println(response)
package client
