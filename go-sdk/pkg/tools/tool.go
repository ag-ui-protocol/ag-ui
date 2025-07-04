package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Tool represents a function that can be called by an AI agent.
// It includes metadata, parameter schema, and execution logic.
type Tool struct {
	// ID is the unique identifier for the tool
	ID string `json:"id"`

	// Name is the human-readable name of the tool
	Name string `json:"name"`

	// Description explains what the tool does
	Description string `json:"description"`

	// Version follows semantic versioning (e.g., "1.0.0")
	Version string `json:"version"`

	// Schema defines the JSON Schema for tool parameters
	Schema *ToolSchema `json:"schema"`

	// Metadata contains additional tool information
	Metadata *ToolMetadata `json:"metadata,omitempty"`

	// Executor implements the tool's execution logic
	Executor ToolExecutor `json:"-"`

	// Capabilities defines what features this tool supports
	Capabilities *ToolCapabilities `json:"capabilities,omitempty"`
}

// ReadOnlyTool provides a read-only view of a tool to avoid cloning overhead.
// This interface prevents modifications while allowing access to tool properties.
type ReadOnlyTool interface {
	GetID() string
	GetName() string
	GetDescription() string
	GetVersion() string
	GetSchema() *ToolSchema
	GetMetadata() *ToolMetadata
	GetExecutor() ToolExecutor
	GetCapabilities() *ToolCapabilities
	// Clone returns a full copy if modification is needed
	Clone() *Tool
}

// readOnlyToolView implements ReadOnlyTool by wrapping a Tool pointer.
type readOnlyToolView struct {
	tool *Tool
}

// NewReadOnlyTool creates a read-only view of a tool without cloning.
func NewReadOnlyTool(tool *Tool) ReadOnlyTool {
	return &readOnlyToolView{tool: tool}
}

func (r *readOnlyToolView) GetID() string {
	return r.tool.ID
}

func (r *readOnlyToolView) GetName() string {
	return r.tool.Name
}

func (r *readOnlyToolView) GetDescription() string {
	return r.tool.Description
}

func (r *readOnlyToolView) GetVersion() string {
	return r.tool.Version
}

func (r *readOnlyToolView) GetSchema() *ToolSchema {
	return r.tool.Schema
}

func (r *readOnlyToolView) GetMetadata() *ToolMetadata {
	return r.tool.Metadata
}

func (r *readOnlyToolView) GetExecutor() ToolExecutor {
	return r.tool.Executor
}

func (r *readOnlyToolView) GetCapabilities() *ToolCapabilities {
	return r.tool.Capabilities
}

func (r *readOnlyToolView) Clone() *Tool {
	return r.tool.Clone()
}

// ToolSchema represents a JSON Schema for tool parameters.
// It validates and describes the expected input structure.
type ToolSchema struct {
	// Type is typically "object" for tool parameters
	Type string `json:"type"`

	// Properties defines the individual parameters
	Properties map[string]*Property `json:"properties,omitempty"`

	// Required lists the mandatory parameter names
	Required []string `json:"required,omitempty"`

	// AdditionalProperties controls whether extra parameters are allowed
	AdditionalProperties *bool `json:"additionalProperties,omitempty"`

	// Description provides schema-level documentation
	Description string `json:"description,omitempty"`
}

// Property represents a single parameter in the tool schema.
type Property struct {
	// Type defines the JSON type (string, number, integer, boolean, array, object)
	Type string `json:"type"`

	// Description explains the parameter's purpose
	Description string `json:"description,omitempty"`

	// Format provides additional type constraints (e.g., "email", "uri", "date-time")
	Format string `json:"format,omitempty"`

	// Enum restricts the value to a set of allowed options
	Enum []interface{} `json:"enum,omitempty"`

	// Default provides a default value if the parameter is not supplied
	Default interface{} `json:"default,omitempty"`

	// Minimum/Maximum for numeric types
	Minimum *float64 `json:"minimum,omitempty"`
	Maximum *float64 `json:"maximum,omitempty"`

	// MinLength/MaxLength for string types
	MinLength *int `json:"minLength,omitempty"`
	MaxLength *int `json:"maxLength,omitempty"`

	// Pattern for regex validation of strings
	Pattern string `json:"pattern,omitempty"`

	// Items defines the schema for array elements
	Items *Property `json:"items,omitempty"`

	// Properties for nested objects
	Properties map[string]*Property `json:"properties,omitempty"`

	// Required properties for nested objects
	Required []string `json:"required,omitempty"`
}

// ToolMetadata contains additional information about a tool.
type ToolMetadata struct {
	// Author identifies who created the tool
	Author string `json:"author,omitempty"`

	// License specifies the tool's license
	License string `json:"license,omitempty"`

	// Documentation URL for detailed docs
	Documentation string `json:"documentation,omitempty"`

	// Examples of tool usage
	Examples []ToolExample `json:"examples,omitempty"`

	// Tags for categorization and discovery
	Tags []string `json:"tags,omitempty"`

	// Dependencies on other tools
	Dependencies []string `json:"dependencies,omitempty"`

	// Custom metadata fields
	Custom map[string]interface{} `json:"custom,omitempty"`
}

// ToolExample shows how to use a tool.
type ToolExample struct {
	// Name identifies the example
	Name string `json:"name"`

	// Description explains what the example demonstrates
	Description string `json:"description"`

	// Input shows the parameters to pass
	Input map[string]interface{} `json:"input"`

	// Output shows the expected result
	Output interface{} `json:"output,omitempty"`
}

// ToolCapabilities defines what features a tool supports.
type ToolCapabilities struct {
	// Streaming indicates if the tool supports streaming arguments/results
	Streaming bool `json:"streaming"`

	// Async indicates if the tool supports asynchronous execution
	Async bool `json:"async"`

	// Cancellable indicates if the tool execution can be cancelled
	Cancellable bool `json:"cancellable"`

	// Retryable indicates if the tool supports automatic retry on failure
	Retryable bool `json:"retryable"`

	// Cacheable indicates if the tool results can be cached
	Cacheable bool `json:"cacheable"`

	// RateLimit defines requests per minute limit (0 = unlimited)
	RateLimit int `json:"rateLimit,omitempty"`

	// Timeout defines maximum execution time
	Timeout time.Duration `json:"timeout,omitempty"`
}

// ToolExecutor is the interface that tool implementations must satisfy.
type ToolExecutor interface {
	// Execute runs the tool with the given parameters.
	// The context can be used for cancellation and timeout.
	// Parameters are validated against the schema before execution.
	Execute(ctx context.Context, params map[string]interface{}) (*ToolExecutionResult, error)
}

// StreamingToolExecutor extends ToolExecutor with streaming capabilities.
type StreamingToolExecutor interface {
	ToolExecutor

	// ExecuteStream runs the tool and streams results through the channel.
	// The channel is closed when execution completes or an error occurs.
	ExecuteStream(ctx context.Context, params map[string]interface{}) (<-chan *ToolStreamChunk, error)
}

// ToolExecutionResult represents the outcome of a tool execution.
type ToolExecutionResult struct {
	// Success indicates if the execution completed successfully
	Success bool `json:"success"`

	// Data contains the tool's output
	Data interface{} `json:"data,omitempty"`

	// Error contains any error message
	Error string `json:"error,omitempty"`

	// Metadata contains execution information
	Metadata map[string]interface{} `json:"metadata,omitempty"`

	// Duration is how long the execution took
	Duration time.Duration `json:"duration,omitempty"`

	// Timestamp is when the execution completed
	Timestamp time.Time `json:"timestamp"`
}

// ToolStreamChunk represents a piece of streaming output.
type ToolStreamChunk struct {
	// Type indicates the chunk type (data, error, metadata, complete)
	Type string `json:"type"`

	// Data contains the chunk payload
	Data interface{} `json:"data,omitempty"`

	// Index is the chunk sequence number
	Index int `json:"index"`

	// Timestamp is when the chunk was produced
	Timestamp time.Time `json:"timestamp"`
}

// ToolFilter is used to query tools in the registry.
type ToolFilter struct {
	// Name filters by tool name (supports wildcards)
	Name string

	// Tags filters by tool tags (tools must have all specified tags)
	Tags []string

	// Category filters by tool category
	Category string

	// Capabilities filters by required capabilities
	Capabilities *ToolCapabilities

	// Version filters by version constraints (e.g., ">=1.0.0")
	Version string

	// Keywords searches in name and description
	Keywords []string
}

// Validate checks if the tool definition is valid.
func (t *Tool) Validate() error {
	if t.ID == "" {
		return fmt.Errorf("tool ID is required")
	}
	if t.Name == "" {
		return fmt.Errorf("tool name is required")
	}
	if t.Description == "" {
		return fmt.Errorf("tool description is required")
	}
	if t.Version == "" {
		return fmt.Errorf("tool version is required")
	}
	if t.Schema == nil {
		return fmt.Errorf("tool schema is required")
	}
	if t.Executor == nil {
		return fmt.Errorf("tool executor is required")
	}

	// Validate schema
	if err := t.Schema.Validate(); err != nil {
		return fmt.Errorf("invalid schema: %w", err)
	}

	return nil
}

// Validate checks if the tool schema is valid.
func (s *ToolSchema) Validate() error {
	if s.Type != "object" {
		return fmt.Errorf("schema type must be 'object', got %q", s.Type)
	}

	// Validate properties
	for name, prop := range s.Properties {
		if err := prop.Validate(); err != nil {
			return fmt.Errorf("property %q: %w", name, err)
		}
	}

	// Check that required properties exist
	for _, req := range s.Required {
		if _, ok := s.Properties[req]; !ok {
			return fmt.Errorf("required property %q not defined in schema", req)
		}
	}

	return nil
}

// Validate checks if the property definition is valid.
func (p *Property) Validate() error {
	validTypes := map[string]bool{
		"string":  true,
		"number":  true,
		"integer": true,
		"boolean": true,
		"array":   true,
		"object":  true,
		"null":    true,
	}

	if !validTypes[p.Type] {
		return fmt.Errorf("invalid type %q", p.Type)
	}

	// Validate array items
	if p.Type == "array" && p.Items != nil {
		if err := p.Items.Validate(); err != nil {
			return fmt.Errorf("array items: %w", err)
		}
	}

	// Validate nested object properties
	if p.Type == "object" && p.Properties != nil {
		for name, prop := range p.Properties {
			if err := prop.Validate(); err != nil {
				return fmt.Errorf("nested property %q: %w", name, err)
			}
		}
	}

	return nil
}

// MarshalJSON customizes JSON marshaling for Tool.
func (t *Tool) MarshalJSON() ([]byte, error) {
	type Alias Tool
	return json.Marshal(&struct {
		*Alias
		Executor string `json:"executor,omitempty"`
	}{
		Alias:    (*Alias)(t),
		Executor: fmt.Sprintf("%T", t.Executor),
	})
}

// Clone creates a deep copy of the tool.
func (t *Tool) Clone() *Tool {
	clone := &Tool{
		ID:          t.ID,
		Name:        t.Name,
		Description: t.Description,
		Version:     t.Version,
		Executor:    t.Executor,
	}

	if t.Schema != nil {
		clone.Schema = t.Schema.Clone()
	}

	if t.Metadata != nil {
		clone.Metadata = t.Metadata.Clone()
	}

	if t.Capabilities != nil {
		clone.Capabilities = &ToolCapabilities{
			Streaming:   t.Capabilities.Streaming,
			Async:       t.Capabilities.Async,
			Cancellable: t.Capabilities.Cancellable,
			Retryable:   t.Capabilities.Retryable,
			Cacheable:   t.Capabilities.Cacheable,
			RateLimit:   t.Capabilities.RateLimit,
			Timeout:     t.Capabilities.Timeout,
		}
	}

	return clone
}

// Clone creates a deep copy of the schema.
func (s *ToolSchema) Clone() *ToolSchema {
	clone := &ToolSchema{
		Type:        s.Type,
		Description: s.Description,
	}

	if s.Properties != nil {
		clone.Properties = make(map[string]*Property, len(s.Properties))
		for k, v := range s.Properties {
			clone.Properties[k] = v.Clone()
		}
	}

	if s.Required != nil {
		clone.Required = make([]string, len(s.Required))
		copy(clone.Required, s.Required)
	}

	if s.AdditionalProperties != nil {
		b := *s.AdditionalProperties
		clone.AdditionalProperties = &b
	}

	return clone
}

// Clone creates a deep copy of the property.
func (p *Property) Clone() *Property {
	clone := &Property{
		Type:        p.Type,
		Description: p.Description,
		Format:      p.Format,
		Pattern:     p.Pattern,
		Default:     p.Default,
	}

	if p.Enum != nil {
		clone.Enum = make([]interface{}, len(p.Enum))
		copy(clone.Enum, p.Enum)
	}

	if p.Minimum != nil {
		m := *p.Minimum
		clone.Minimum = &m
	}

	if p.Maximum != nil {
		m := *p.Maximum
		clone.Maximum = &m
	}

	if p.MinLength != nil {
		m := *p.MinLength
		clone.MinLength = &m
	}

	if p.MaxLength != nil {
		m := *p.MaxLength
		clone.MaxLength = &m
	}

	if p.Items != nil {
		clone.Items = p.Items.Clone()
	}

	if p.Properties != nil {
		clone.Properties = make(map[string]*Property, len(p.Properties))
		for k, v := range p.Properties {
			clone.Properties[k] = v.Clone()
		}
	}

	if p.Required != nil {
		clone.Required = make([]string, len(p.Required))
		copy(clone.Required, p.Required)
	}

	return clone
}

// Clone creates a deep copy of the metadata.
func (m *ToolMetadata) Clone() *ToolMetadata {
	clone := &ToolMetadata{
		Author:        m.Author,
		License:       m.License,
		Documentation: m.Documentation,
	}

	if m.Examples != nil {
		clone.Examples = make([]ToolExample, len(m.Examples))
		for i, ex := range m.Examples {
			clone.Examples[i] = ToolExample{
				Name:        ex.Name,
				Description: ex.Description,
				Input:       cloneMap(ex.Input),
				Output:      ex.Output,
			}
		}
	}

	if m.Tags != nil {
		clone.Tags = make([]string, len(m.Tags))
		copy(clone.Tags, m.Tags)
	}

	if m.Dependencies != nil {
		clone.Dependencies = make([]string, len(m.Dependencies))
		copy(clone.Dependencies, m.Dependencies)
	}

	if m.Custom != nil {
		clone.Custom = cloneMap(m.Custom)
	}

	return clone
}

// cloneMap creates a shallow copy of a map.
func cloneMap(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return nil
	}
	clone := make(map[string]interface{}, len(m))
	for k, v := range m {
		clone[k] = v
	}
	return clone
}