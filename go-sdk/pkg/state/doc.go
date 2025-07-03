// Package state provides state management and JSON Patch implementation.
//
// This package implements bidirectional state synchronization between AI agents
// and front-end applications using JSON Patch (RFC 6902) operations. It enables
// real-time updates to shared application state with conflict resolution and
// event sourcing capabilities.
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/state"
//
//	// Create a state manager
//	sm := state.NewManager()
//
//	// Apply a patch
//	patch := state.Patch{
//		{Op: "add", Path: "/users/123", Value: user},
//	}
//	err := sm.ApplyPatch(patch)
//
//	// Get current state
//	currentState := sm.GetState()
package state
