// Package tools provides tool system and execution framework for AI agents.
//
// This package implements the tool calling capabilities that allow AI agents
// to execute external functions and interact with systems beyond the chat
// interface. Tools can be registered, validated, and executed in a secure
// sandboxed environment.
//
// Example usage:
//
//	import "github.com/ag-ui/go-sdk/pkg/tools"
//
//	// Define a tool
//	calculator := tools.NewTool("calculator", func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
//		// Tool implementation
//		return result, nil
//	})
//
//	// Register with agent
//	agent.RegisterTool(calculator)
package tools
