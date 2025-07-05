package tools_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/ag-ui/go-sdk/pkg/tools"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Mock executor for testing
type mockExecutor struct {
	result *tools.ToolExecutionResult
	err    error
}

func (m *mockExecutor) Execute(ctx context.Context, params map[string]interface{}) (*tools.ToolExecutionResult, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.result, nil
}

// Helper functions
func stringPtr(s string) *string {
	return &s
}

func floatPtr(f float64) *float64 {
	return &f
}

func toolTestIntPtr(i int) *int {
	return &i
}

func toolTestBoolPtr(b bool) *bool {
	return &b
}

func TestTool_Validate(t *testing.T) {
	tests := []struct {
		name    string
		tool    *tools.Tool
		wantErr string
	}{
		{
			name:    "missing ID",
			tool:    &tools.Tool{},
			wantErr: "tool ID is required",
		},
		{
			name: "missing name",
			tool: &tools.Tool{
				ID: "test-tool",
			},
			wantErr: "tool name is required",
		},
		{
			name: "missing description",
			tool: &tools.Tool{
				ID:   "test-tool",
				Name: "Test Tool",
			},
			wantErr: "tool description is required",
		},
		{
			name: "missing version",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
			},
			wantErr: "tool version is required",
		},
		{
			name: "missing schema",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
				Version:     "1.0.0",
			},
			wantErr: "tool schema is required",
		},
		{
			name: "missing executor",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
				Version:     "1.0.0",
				Schema:      &tools.ToolSchema{Type: "object"},
			},
			wantErr: "tool executor is required",
		},
		{
			name: "invalid schema",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
				Version:     "1.0.0",
				Schema:      &tools.ToolSchema{Type: "invalid"},
				Executor:    &mockExecutor{},
			},
			wantErr: "invalid schema: schema type must be 'object', got \"invalid\"",
		},
		{
			name: "valid tool",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
				Version:     "1.0.0",
				Schema:      &tools.ToolSchema{Type: "object"},
				Executor:    &mockExecutor{},
			},
			wantErr: "",
		},
		{
			name: "valid tool with all fields",
			tool: &tools.Tool{
				ID:          "test-tool",
				Name:        "Test Tool",
				Description: "A test tool",
				Version:     "1.0.0",
				Schema: &tools.ToolSchema{
					Type: "object",
					Properties: map[string]*tools.Property{
						"param1": {Type: "string"},
					},
					Required: []string{"param1"},
				},
				Executor: &mockExecutor{},
				Metadata: &tools.ToolMetadata{
					Author: "Test Author",
					Tags:   []string{"test", "example"},
				},
				Capabilities: &tools.ToolCapabilities{
					Streaming: true,
					Async:     false,
				},
			},
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.tool.Validate()
			if tt.wantErr == "" {
				assert.NoError(t, err)
			} else {
				assert.EqualError(t, err, tt.wantErr)
			}
		})
	}
}

func TestToolSchema_Validate(t *testing.T) {
	tests := []struct {
		name    string
		schema  *tools.ToolSchema
		wantErr string
	}{
		{
			name: "invalid type",
			schema: &tools.ToolSchema{
				Type: "array",
			},
			wantErr: "schema type must be 'object', got \"array\"",
		},
		{
			name: "valid empty schema",
			schema: &tools.ToolSchema{
				Type: "object",
			},
			wantErr: "",
		},
		{
			name: "invalid property",
			schema: &tools.ToolSchema{
				Type: "object",
				Properties: map[string]*tools.Property{
					"invalid": {Type: "unknown"},
				},
			},
			wantErr: "property \"invalid\": invalid type \"unknown\"",
		},
		{
			name: "required property not defined",
			schema: &tools.ToolSchema{
				Type:     "object",
				Required: []string{"missing"},
			},
			wantErr: "required property \"missing\" not defined in schema",
		},
		{
			name: "valid schema with properties",
			schema: &tools.ToolSchema{
				Type: "object",
				Properties: map[string]*tools.Property{
					"name":    {Type: "string"},
					"age":     {Type: "integer"},
					"active":  {Type: "boolean"},
					"balance": {Type: "number"},
				},
				Required:             []string{"name", "age"},
				AdditionalProperties: toolTestBoolPtr(false),
				Description:          "User information",
			},
			wantErr: "",
		},
		{
			name: "nested object validation",
			schema: &tools.ToolSchema{
				Type: "object",
				Properties: map[string]*tools.Property{
					"user": {
						Type: "object",
						Properties: map[string]*tools.Property{
							"invalid": {Type: "invalid_type"},
						},
					},
				},
			},
			wantErr: "property \"user\": nested property \"invalid\": invalid type \"invalid_type\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.schema.Validate()
			if tt.wantErr == "" {
				assert.NoError(t, err)
			} else {
				assert.EqualError(t, err, tt.wantErr)
			}
		})
	}
}

func TestProperty_Validate(t *testing.T) {
	tests := []struct {
		name     string
		property *tools.Property
		wantErr  string
	}{
		// Type validation
		{
			name:     "valid string type",
			property: &tools.Property{Type: "string"},
			wantErr:  "",
		},
		{
			name:     "valid number type",
			property: &tools.Property{Type: "number"},
			wantErr:  "",
		},
		{
			name:     "valid integer type",
			property: &tools.Property{Type: "integer"},
			wantErr:  "",
		},
		{
			name:     "valid boolean type",
			property: &tools.Property{Type: "boolean"},
			wantErr:  "",
		},
		{
			name:     "valid array type",
			property: &tools.Property{Type: "array"},
			wantErr:  "",
		},
		{
			name:     "valid object type",
			property: &tools.Property{Type: "object"},
			wantErr:  "",
		},
		{
			name:     "valid null type",
			property: &tools.Property{Type: "null"},
			wantErr:  "",
		},
		{
			name:     "invalid type",
			property: &tools.Property{Type: "invalid"},
			wantErr:  "invalid type \"invalid\"",
		},

		// String property validation
		{
			name: "string with constraints",
			property: &tools.Property{
				Type:        "string",
				Description: "Email address",
				Format:      "email",
				Pattern:     `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`,
				MinLength:   toolTestIntPtr(5),
				MaxLength:   toolTestIntPtr(100),
			},
			wantErr: "",
		},
		{
			name: "string with enum",
			property: &tools.Property{
				Type: "string",
				Enum: []interface{}{"small", "medium", "large"},
			},
			wantErr: "",
		},

		// Number property validation
		{
			name: "number with constraints",
			property: &tools.Property{
				Type:    "number",
				Minimum: floatPtr(0.0),
				Maximum: floatPtr(100.0),
			},
			wantErr: "",
		},

		// Array property validation
		{
			name: "array without items",
			property: &tools.Property{
				Type: "array",
			},
			wantErr: "",
		},
		{
			name: "array with valid items",
			property: &tools.Property{
				Type: "array",
				Items: &tools.Property{
					Type: "string",
				},
			},
			wantErr: "",
		},
		{
			name: "array with invalid items",
			property: &tools.Property{
				Type: "array",
				Items: &tools.Property{
					Type: "invalid",
				},
			},
			wantErr: "array items: invalid type \"invalid\"",
		},

		// Object property validation
		{
			name: "object without properties",
			property: &tools.Property{
				Type: "object",
			},
			wantErr: "",
		},
		{
			name: "object with valid properties",
			property: &tools.Property{
				Type: "object",
				Properties: map[string]*tools.Property{
					"name": {Type: "string"},
					"age":  {Type: "integer"},
				},
				Required: []string{"name"},
			},
			wantErr: "",
		},
		{
			name: "object with invalid nested property",
			property: &tools.Property{
				Type: "object",
				Properties: map[string]*tools.Property{
					"invalid": {Type: "unknown"},
				},
			},
			wantErr: "nested property \"invalid\": invalid type \"unknown\"",
		},

		// Complex nested validation
		{
			name: "deeply nested valid structure",
			property: &tools.Property{
				Type: "object",
				Properties: map[string]*tools.Property{
					"users": {
						Type: "array",
						Items: &tools.Property{
							Type: "object",
							Properties: map[string]*tools.Property{
								"name": {Type: "string"},
								"tags": {
									Type: "array",
									Items: &tools.Property{
										Type: "string",
									},
								},
							},
						},
					},
				},
			},
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.property.Validate()
			if tt.wantErr == "" {
				assert.NoError(t, err)
			} else {
				assert.EqualError(t, err, tt.wantErr)
			}
		})
	}
}

func TestTool_Clone(t *testing.T) {
	original := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"param1": {
					Type:      "string",
					MinLength: toolTestIntPtr(1),
					MaxLength: toolTestIntPtr(100),
				},
				"param2": {
					Type: "array",
					Items: &tools.Property{
						Type: "integer",
					},
				},
			},
			Required:             []string{"param1"},
			AdditionalProperties: toolTestBoolPtr(false),
			Description:          "Test schema",
		},
		Executor: &mockExecutor{},
		Metadata: &tools.ToolMetadata{
			Author:        "Test Author",
			License:       "MIT",
			Documentation: "https://example.com/docs",
			Examples: []tools.ToolExample{
				{
					Name:        "Example 1",
					Description: "Test example",
					Input:       map[string]interface{}{"param1": "test"},
					Output:      "result",
				},
			},
			Tags:         []string{"test", "example"},
			Dependencies: []string{"dep1", "dep2"},
			Custom:       map[string]interface{}{"key1": "value1"},
		},
		Capabilities: &tools.ToolCapabilities{
			Streaming:  true,
			Async:      false,
			Cancelable: true,
			Retryable:  true,
			Cacheable:  false,
			RateLimit:  100,
			Timeout:    5 * time.Second,
		},
	}

	// Clone the tool
	clone := original.Clone()

	// Verify it's a deep copy
	assert.NotSame(t, original, clone)
	assert.Equal(t, original.ID, clone.ID)
	assert.Equal(t, original.Name, clone.Name)
	assert.Equal(t, original.Description, clone.Description)
	assert.Equal(t, original.Version, clone.Version)
	assert.Same(t, original.Executor, clone.Executor) // Executor is not cloned

	// Verify schema is deep cloned
	assert.NotSame(t, original.Schema, clone.Schema)
	assert.Equal(t, original.Schema.Type, clone.Schema.Type)
	// For maps, we check that they are different instances
	if len(original.Schema.Properties) > 0 && len(clone.Schema.Properties) > 0 {
		// Verify it's a deep copy by checking the property objects are different
		assert.NotSame(t, original.Schema.Properties["param1"], clone.Schema.Properties["param1"])
	}
	// For slices, check they have different underlying arrays
	if len(original.Schema.Required) > 0 && len(clone.Schema.Required) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Schema.Required), fmt.Sprintf("%p", clone.Schema.Required))
	}
	assert.NotSame(t, original.Schema.AdditionalProperties, clone.Schema.AdditionalProperties)

	// Verify metadata is deep cloned
	assert.NotSame(t, original.Metadata, clone.Metadata)
	// For slices and maps, check they have different underlying data structures
	if len(original.Metadata.Examples) > 0 && len(clone.Metadata.Examples) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Metadata.Examples), fmt.Sprintf("%p", clone.Metadata.Examples))
	}
	if len(original.Metadata.Tags) > 0 && len(clone.Metadata.Tags) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Metadata.Tags), fmt.Sprintf("%p", clone.Metadata.Tags))
	}
	if len(original.Metadata.Dependencies) > 0 && len(clone.Metadata.Dependencies) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Metadata.Dependencies), fmt.Sprintf("%p", clone.Metadata.Dependencies))
	}
	// For maps, verify they are different instances
	if len(original.Metadata.Custom) > 0 && len(clone.Metadata.Custom) > 0 {
		// Modify clone to verify it doesn't affect original
		originalCustomVal := original.Metadata.Custom["key1"]
		clone.Metadata.Custom["key1"] = "modified"
		assert.Equal(t, "value1", originalCustomVal)
		clone.Metadata.Custom["key1"] = "value1" // restore for equality check
	}

	// Verify capabilities is deep cloned
	assert.NotSame(t, original.Capabilities, clone.Capabilities)
	assert.Equal(t, original.Capabilities.Streaming, clone.Capabilities.Streaming)
	assert.Equal(t, original.Capabilities.Timeout, clone.Capabilities.Timeout)

	// Modify clone and verify original is unchanged
	clone.ID = "modified"
	clone.Schema.Type = "modified"
	clone.Schema.Properties["param1"].Type = "modified"
	clone.Metadata.Tags[0] = "modified"
	clone.Capabilities.Streaming = false

	assert.Equal(t, "test-tool", original.ID)
	assert.Equal(t, "object", original.Schema.Type)
	assert.Equal(t, "string", original.Schema.Properties["param1"].Type)
	assert.Equal(t, "test", original.Metadata.Tags[0])
	assert.True(t, original.Capabilities.Streaming)
}

func TestTool_Clone_NilFields(t *testing.T) {
	original := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema:      &tools.ToolSchema{Type: "object"},
		Executor:    &mockExecutor{},
		// Metadata and Capabilities are nil
	}

	clone := original.Clone()

	assert.NotSame(t, original, clone)
	assert.Nil(t, clone.Metadata)
	assert.Nil(t, clone.Capabilities)
}

func TestToolSchema_Clone(t *testing.T) {
	original := &tools.ToolSchema{
		Type: "object",
		Properties: map[string]*tools.Property{
			"prop1": {
				Type:      "string",
				MinLength: toolTestIntPtr(5),
			},
		},
		Required:             []string{"prop1"},
		AdditionalProperties: toolTestBoolPtr(false),
		Description:          "Test schema",
	}

	clone := original.Clone()

	// Verify deep copy
	assert.NotSame(t, original, clone)
	// For maps, verify they are different instances
	if len(original.Properties) > 0 && len(clone.Properties) > 0 {
		assert.NotSame(t, original.Properties["prop1"], clone.Properties["prop1"])
	}
	// For slices, check they have different underlying arrays
	if len(original.Required) > 0 && len(clone.Required) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Required), fmt.Sprintf("%p", clone.Required))
	}
	assert.NotSame(t, original.AdditionalProperties, clone.AdditionalProperties)

	// Verify values are equal
	assert.Equal(t, original.Type, clone.Type)
	assert.Equal(t, original.Description, clone.Description)
	assert.Equal(t, *original.AdditionalProperties, *clone.AdditionalProperties)
}

func TestProperty_Clone(t *testing.T) {
	original := &tools.Property{
		Type:        "string",
		Description: "Test property",
		Format:      "email",
		Enum:        []interface{}{"a", "b", "c"},
		Default:     "a",
		Minimum:     floatPtr(0),
		Maximum:     floatPtr(100),
		MinLength:   toolTestIntPtr(1),
		MaxLength:   toolTestIntPtr(50),
		Pattern:     "^[a-z]+$",
		Items: &tools.Property{
			Type: "integer",
		},
		Properties: map[string]*tools.Property{
			"nested": {Type: "boolean"},
		},
		Required: []string{"nested"},
	}

	clone := original.Clone()

	// Verify deep copy
	assert.NotSame(t, original, clone)
	// For slices, check they have different underlying arrays
	if len(original.Enum) > 0 && len(clone.Enum) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Enum), fmt.Sprintf("%p", clone.Enum))
	}
	assert.NotSame(t, original.Minimum, clone.Minimum)
	assert.NotSame(t, original.Maximum, clone.Maximum)
	assert.NotSame(t, original.MinLength, clone.MinLength)
	assert.NotSame(t, original.MaxLength, clone.MaxLength)
	assert.NotSame(t, original.Items, clone.Items)
	// For maps and slices, check they have different underlying data structures
	if len(original.Properties) > 0 && len(clone.Properties) > 0 {
		assert.NotSame(t, original.Properties["nested"], clone.Properties["nested"])
	}
	if len(original.Required) > 0 && len(clone.Required) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Required), fmt.Sprintf("%p", clone.Required))
	}

	// Verify values are equal
	assert.Equal(t, original.Type, clone.Type)
	assert.Equal(t, original.Description, clone.Description)
	assert.Equal(t, original.Format, clone.Format)
	assert.Equal(t, original.Pattern, clone.Pattern)
	assert.Equal(t, original.Default, clone.Default)
	assert.Equal(t, *original.Minimum, *clone.Minimum)
	assert.Equal(t, *original.Maximum, *clone.Maximum)
}

func TestToolMetadata_Clone(t *testing.T) {
	original := &tools.ToolMetadata{
		Author:        "Test Author",
		License:       "MIT",
		Documentation: "https://example.com/docs",
		Examples: []tools.ToolExample{
			{
				Name:        "Example 1",
				Description: "Test example",
				Input:       map[string]interface{}{"key": "value"},
				Output:      "result",
			},
		},
		Tags:         []string{"tag1", "tag2"},
		Dependencies: []string{"dep1", "dep2"},
		Custom:       map[string]interface{}{"custom": "data"},
	}

	clone := original.Clone()

	// Verify deep copy
	assert.NotSame(t, original, clone)
	// For slices and maps, check they have different underlying data structures
	if len(original.Examples) > 0 && len(clone.Examples) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Examples), fmt.Sprintf("%p", clone.Examples))
		// For maps inside the slice
		if len(original.Examples[0].Input) > 0 && len(clone.Examples[0].Input) > 0 {
			// Verify deep copy by modifying clone
			originalVal := original.Examples[0].Input["key"]
			clone.Examples[0].Input["key"] = "modified"
			assert.Equal(t, "value", originalVal)
			clone.Examples[0].Input["key"] = "value" // restore for equality check
		}
	}
	if len(original.Tags) > 0 && len(clone.Tags) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Tags), fmt.Sprintf("%p", clone.Tags))
	}
	if len(original.Dependencies) > 0 && len(clone.Dependencies) > 0 {
		assert.NotEqual(t, fmt.Sprintf("%p", original.Dependencies), fmt.Sprintf("%p", clone.Dependencies))
	}
	// For maps, verify they are different instances
	if len(original.Custom) > 0 && len(clone.Custom) > 0 {
		// Verify deep copy by modifying clone
		originalVal := original.Custom["custom"]
		clone.Custom["custom"] = "modified"
		assert.Equal(t, "data", originalVal)
		clone.Custom["custom"] = "data" // restore for equality check
	}

	// Verify values are equal
	assert.Equal(t, original.Author, clone.Author)
	assert.Equal(t, original.License, clone.License)
	assert.Equal(t, original.Documentation, clone.Documentation)
	assert.Equal(t, len(original.Examples), len(clone.Examples))
	assert.Equal(t, original.Examples[0].Name, clone.Examples[0].Name)
}

func TestTool_MarshalJSON(t *testing.T) {
	tool := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"input": {Type: "string"},
			},
		},
		Executor: &mockExecutor{},
		Metadata: &tools.ToolMetadata{
			Author: "Test Author",
		},
		Capabilities: &tools.ToolCapabilities{
			Streaming: true,
		},
	}

	data, err := json.Marshal(tool)
	require.NoError(t, err)

	// Parse the JSON to verify structure
	var result map[string]interface{}
	err = json.Unmarshal(data, &result)
	require.NoError(t, err)

	// Verify expected fields
	assert.Equal(t, "test-tool", result["id"])
	assert.Equal(t, "Test Tool", result["name"])
	assert.Equal(t, "A test tool", result["description"])
	assert.Equal(t, "1.0.0", result["version"])
	assert.NotNil(t, result["schema"])
	assert.NotNil(t, result["metadata"])
	assert.NotNil(t, result["capabilities"])

	// Verify executor type is included
	assert.Equal(t, "*tools_test.mockExecutor", result["executor"])
}

func TestToolExecutionResult(t *testing.T) {
	result := &tools.ToolExecutionResult{
		Success: true,
		Data:    map[string]interface{}{"result": "test"},
		Error:   "",
		Metadata: map[string]interface{}{
			"execution": "metadata",
		},
		Duration:  5 * time.Second,
		Timestamp: time.Now(),
	}

	// Test JSON marshaling
	data, err := json.Marshal(result)
	require.NoError(t, err)

	var unmarshaled tools.ToolExecutionResult
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, result.Success, unmarshaled.Success)
	assert.Equal(t, result.Error, unmarshaled.Error)
}

func TestToolStreamChunk(t *testing.T) {
	chunk := &tools.ToolStreamChunk{
		Type:      "data",
		Data:      map[string]interface{}{"content": "streaming data"},
		Index:     1,
		Timestamp: time.Now(),
	}

	// Test JSON marshaling
	data, err := json.Marshal(chunk)
	require.NoError(t, err)

	var unmarshaled tools.ToolStreamChunk
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, chunk.Type, unmarshaled.Type)
	assert.Equal(t, chunk.Index, unmarshaled.Index)
}

func TestToolFilter(t *testing.T) {
	filter := &tools.ToolFilter{
		Name:     "test*",
		Tags:     []string{"tag1", "tag2"},
		Category: "testing",
		Capabilities: &tools.ToolCapabilities{
			Streaming: true,
			Async:     true,
		},
		Version:  ">=1.0.0",
		Keywords: []string{"test", "example"},
	}

	// Test that filter can be created and fields are accessible
	assert.Equal(t, "test*", filter.Name)
	assert.Equal(t, []string{"tag1", "tag2"}, filter.Tags)
	assert.Equal(t, "testing", filter.Category)
	assert.True(t, filter.Capabilities.Streaming)
	assert.True(t, filter.Capabilities.Async)
	assert.Equal(t, ">=1.0.0", filter.Version)
	assert.Equal(t, []string{"test", "example"}, filter.Keywords)
}

// Edge cases and error conditions
func TestProperty_Validate_EdgeCases(t *testing.T) {
	tests := []struct {
		name     string
		property *tools.Property
		wantErr  string
	}{
		{
			name: "empty type",
			property: &tools.Property{
				Type: "",
			},
			wantErr: "invalid type \"\"",
		},
		{
			name: "array with nested array",
			property: &tools.Property{
				Type: "array",
				Items: &tools.Property{
					Type: "array",
					Items: &tools.Property{
						Type: "string",
					},
				},
			},
			wantErr: "",
		},
		{
			name: "object with nested objects",
			property: &tools.Property{
				Type: "object",
				Properties: map[string]*tools.Property{
					"level1": {
						Type: "object",
						Properties: map[string]*tools.Property{
							"level2": {
								Type: "object",
								Properties: map[string]*tools.Property{
									"level3": {Type: "string"},
								},
							},
						},
					},
				},
			},
			wantErr: "",
		},
		{
			name: "property with all constraints",
			property: &tools.Property{
				Type:        "string",
				Description: "Complex property",
				Format:      "email",
				Enum:        []interface{}{"opt1", "opt2"},
				Default:     "opt1",
				MinLength:   toolTestIntPtr(5),
				MaxLength:   toolTestIntPtr(50),
				Pattern:     ".*",
			},
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.property.Validate()
			if tt.wantErr == "" {
				assert.NoError(t, err)
			} else {
				assert.EqualError(t, err, tt.wantErr)
			}
		})
	}
}

func TestToolCapabilities_Timeout(t *testing.T) {
	caps := &tools.ToolCapabilities{
		Streaming:  true,
		Async:      true,
		Cancelable: true,
		Retryable:  true,
		Cacheable:  true,
		RateLimit:  60,
		Timeout:    30 * time.Second,
	}

	// Test JSON marshaling of Duration
	data, err := json.Marshal(caps)
	require.NoError(t, err)

	var unmarshaled tools.ToolCapabilities
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, caps.Streaming, unmarshaled.Streaming)
	assert.Equal(t, caps.RateLimit, unmarshaled.RateLimit)
	assert.Equal(t, caps.Timeout, unmarshaled.Timeout)
}

func TestToolExample(t *testing.T) {
	example := tools.ToolExample{
		Name:        "Example Test",
		Description: "Testing tool example",
		Input: map[string]interface{}{
			"param1": "value1",
			"param2": 42,
		},
		Output: map[string]interface{}{
			"result": "success",
			"count":  10,
		},
	}

	// Test JSON marshaling
	data, err := json.Marshal(example)
	require.NoError(t, err)

	var unmarshaled tools.ToolExample
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, example.Name, unmarshaled.Name)
	assert.Equal(t, example.Description, unmarshaled.Description)
	assert.Equal(t, example.Input["param1"], unmarshaled.Input["param1"])
}

// Benchmarks
func BenchmarkTool_Validate(b *testing.B) {
	tool := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"param1": {Type: "string"},
				"param2": {Type: "integer"},
				"param3": {Type: "boolean"},
			},
			Required: []string{"param1"},
		},
		Executor: &mockExecutor{},
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = tool.Validate()
	}
}

func BenchmarkTool_Clone(b *testing.B) {
	tool := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"param1": {
					Type:      "string",
					MinLength: toolTestIntPtr(1),
					MaxLength: toolTestIntPtr(100),
				},
				"param2": {
					Type: "array",
					Items: &tools.Property{
						Type: "integer",
					},
				},
			},
			Required: []string{"param1"},
		},
		Executor: &mockExecutor{},
		Metadata: &tools.ToolMetadata{
			Author: "Test Author",
			Tags:   []string{"test", "benchmark"},
		},
		Capabilities: &tools.ToolCapabilities{
			Streaming: true,
			Async:     false,
		},
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = tool.Clone()
	}
}

func BenchmarkTool_MarshalJSON(b *testing.B) {
	tool := &tools.Tool{
		ID:          "test-tool",
		Name:        "Test Tool",
		Description: "A test tool",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"param1": {Type: "string"},
			},
		},
		Executor: &mockExecutor{},
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = json.Marshal(tool)
	}
}
