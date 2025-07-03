// Package server provides the server SDK for building AG-UI endpoints.
//
// This package enables developers to create AG-UI servers that can host
// AI agents and handle client connections. It provides a framework for
// routing events to agents, managing agent lifecycles, and handling
// transport protocols.
//
// The server supports multiple transport mechanisms and can scale to
// handle multiple concurrent client connections and agent instances.
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/server"
//
//	// Create a new server
//	s := server.New(server.Config{
//		Address: ":8080",
//	})
//
//	// Register an agent
//	myAgent := &MyAgent{}
//	s.RegisterAgent("my-agent", myAgent)
//
//	// Start the server
//	if err := s.ListenAndServe(); err != nil {
//		log.Fatal(err)
//	}
package server
