// Package tools provides a comprehensive tool system for the AG-UI protocol.
//
// The tools package implements a flexible and extensible framework for defining,
// registering, and executing tools within AG-UI agents. It includes:
//
// - JSON Schema-based tool definition and validation
// - Dynamic tool registry with discovery capabilities
// - Concurrent execution engine with timeout and cancellation support
// - Streaming support for large tool arguments and results
// - AI provider integration for OpenAI and Anthropic formats
// - Built-in tools for common operations
//
// # Tool Definition
//
// Tools are defined using the Tool struct, which includes metadata, parameter
// schema, and an executor implementation:
//
//	tool := &Tool{
//		Name:        "weather",
//		Description: "Get current weather for a location",
//		Version:     "1.0.0",
//		Schema: &ToolSchema{
//			Type: "object",
//			Properties: map[string]*Property{
//				"location": {
//					Type:        "string",
//					Description: "City name or coordinates",
//				},
//			},
//			Required: []string{"location"},
//		},
//		Executor: weatherExecutor,
//	}
//
// # Tool Registration
//
// Tools are managed through a central registry that supports dynamic
// registration and discovery:
//
//	registry := NewRegistry()
//	err := registry.Register(tool)
//
// # Tool Execution
//
// Tools are executed through the execution engine, which handles validation,
// timeout management, and result formatting:
//
//	engine := NewExecutionEngine(registry)
//	result, err := engine.Execute(ctx, "weather", map[string]interface{}{
//		"location": "San Francisco",
//	})
//
// # AI Provider Integration
//
// The package provides converters for major AI provider tool formats:
//
//	openAITool := ConvertToOpenAITool(tool)
//	anthropicTool := ConvertToAnthropicTool(tool)
package tools
