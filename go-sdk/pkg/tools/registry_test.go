package tools_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/ag-ui/go-sdk/pkg/tools"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockRegistryExecutor is a test implementation of ToolExecutor for registry tests
type mockRegistryExecutor struct {
	name string
}

func (m *mockRegistryExecutor) Execute(ctx context.Context, params map[string]interface{}) (*tools.ToolExecutionResult, error) {
	return &tools.ToolExecutionResult{
		Success:   true,
		Data:      fmt.Sprintf("executed %s", m.name),
		Timestamp: time.Now(),
	}, nil
}

// Helper function to create a test tool
func createTestTool(id, name string) *tools.Tool {
	return &tools.Tool{
		ID:          id,
		Name:        name,
		Description: fmt.Sprintf("Test tool %s", name),
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type:       "object",
			Properties: map[string]*tools.Property{},
		},
		Executor: &mockRegistryExecutor{name: name},
	}
}

// Helper function to create a test tool with metadata
func createTestToolWithMetadata(id, name string, tags []string, deps []string) *tools.Tool {
	tool := createTestTool(id, name)
	tool.Metadata = &tools.ToolMetadata{
		Tags:         tags,
		Dependencies: deps,
		Author:       "Test Author",
	}
	return tool
}

// Helper function to create a test tool with capabilities
func createTestToolWithCapabilities(id, name string, caps *tools.ToolCapabilities) *tools.Tool {
	tool := createTestTool(id, name)
	tool.Capabilities = caps
	return tool
}

func TestRegistry_Creation(t *testing.T) {
	reg := tools.NewRegistry()
	assert.NotNil(t, reg)
	assert.Equal(t, 0, reg.Count())
	// Note: Cannot test internal fields when using external test package
}

func TestRegistry_Register(t *testing.T) {
	tests := []struct {
		name    string
		tool    *tools.Tool
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid tool",
			tool:    createTestTool("tool1", "Tool One"),
			wantErr: false,
		},
		{
			name:    "nil tool",
			tool:    nil,
			wantErr: true,
			errMsg:  "tool cannot be nil",
		},
		{
			name: "invalid tool - no ID",
			tool: &tools.Tool{
				Name:        "No ID",
				Description: "Missing ID",
				Version:     "1.0.0",
				Schema:      &tools.ToolSchema{Type: "object"},
				Executor:    &mockRegistryExecutor{},
			},
			wantErr: true,
			errMsg:  "tool ID is required",
		},
		{
			name: "tool with metadata",
			tool: createTestToolWithMetadata("tool2", "Tool Two",
				[]string{"tag1", "tag2"}, []string{"dep1"}),
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := tools.NewRegistry()
			err := reg.Register(tt.tool)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				assert.NoError(t, err)
				if tt.tool != nil {
					registered, err := reg.Get(tt.tool.ID)
					assert.NoError(t, err)
					assert.Equal(t, tt.tool.ID, registered.ID)
				}
			}
		})
	}
}

func TestRegistry_RegisterDuplicate(t *testing.T) {
	reg := tools.NewRegistry()
	tool1 := createTestTool("tool1", "Tool One")
	tool2 := createTestTool("tool1", "Tool One Duplicate")
	tool3 := createTestTool("tool2", "Tool One") // Same name, different ID

	// First registration should succeed
	err := reg.Register(tool1)
	assert.NoError(t, err)

	// Duplicate ID should fail
	err = reg.Register(tool2)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already registered")

	// Same name with different ID should fail
	err = reg.Register(tool3)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "name")
}

func TestRegistry_Unregister(t *testing.T) {
	reg := tools.NewRegistry()
	tool := createTestToolWithMetadata("tool1", "Tool One",
		[]string{"tag1", "tag2"}, nil)

	// Register tool
	err := reg.Register(tool)
	require.NoError(t, err)

	// Verify it exists
	_, err = reg.Get("tool1")
	assert.NoError(t, err)

	// Unregister
	err = reg.Unregister("tool1")
	assert.NoError(t, err)

	// Verify it's gone
	_, err = reg.Get("tool1")
	assert.Error(t, err)

	// Note: Cannot verify internal indexes when using external test package

	// Unregister non-existent tool
	err = reg.Unregister("nonexistent")
	assert.Error(t, err)
}

func TestRegistry_Get(t *testing.T) {
	reg := tools.NewRegistry()
	tool := createTestTool("tool1", "Tool One")

	err := reg.Register(tool)
	require.NoError(t, err)

	// Get existing tool
	retrieved, err := reg.Get("tool1")
	assert.NoError(t, err)
	assert.Equal(t, tool.ID, retrieved.ID)
	assert.Equal(t, tool.Name, retrieved.Name)

	// Get non-existent tool
	_, err = reg.Get("nonexistent")
	assert.Error(t, err)
}

func TestRegistry_GetByName(t *testing.T) {
	reg := tools.NewRegistry()
	tool := createTestTool("tool1", "Tool One")

	err := reg.Register(tool)
	require.NoError(t, err)

	// Get by name
	retrieved, err := reg.GetByName("Tool One")
	assert.NoError(t, err)
	assert.Equal(t, tool.ID, retrieved.ID)

	// Get non-existent name
	_, err = reg.GetByName("Unknown Tool")
	assert.Error(t, err)
}

func TestRegistry_List(t *testing.T) {
	reg := tools.NewRegistry()

	// Register multiple tools
	tool1 := createTestToolWithMetadata("tool1", "Search Tool",
		[]string{"search", "utility"}, nil)
	tool2 := createTestToolWithMetadata("tool2", "Calculator",
		[]string{"math", "utility"}, nil)
	tool3 := createTestToolWithCapabilities("tool3", "Streaming Tool",
		&tools.ToolCapabilities{Streaming: true, Async: true})

	for _, tool := range []*tools.Tool{tool1, tool2, tool3} {
		err := reg.Register(tool)
		require.NoError(t, err)
	}

	// Test list all
	all, err := reg.ListAll()
	assert.NoError(t, err)
	assert.Len(t, all, 3)

	// Test filter by name
	filtered, err := reg.List(&tools.ToolFilter{Name: "Calculator"})
	assert.NoError(t, err)
	assert.Len(t, filtered, 1)
	assert.Equal(t, "tool2", filtered[0].ID)

	// Test filter by name with wildcard
	filtered, err = reg.List(&tools.ToolFilter{Name: "*Tool"})
	assert.NoError(t, err)
	assert.Len(t, filtered, 2)

	// Test filter by tags
	filtered, err = reg.List(&tools.ToolFilter{Tags: []string{"utility"}})
	assert.NoError(t, err)
	assert.Len(t, filtered, 2)

	// Test filter by multiple tags
	filtered, err = reg.List(&tools.ToolFilter{Tags: []string{"math", "utility"}})
	assert.NoError(t, err)
	assert.Len(t, filtered, 1)
	assert.Equal(t, "tool2", filtered[0].ID)

	// Test filter by capabilities
	filtered, err = reg.List(&tools.ToolFilter{
		Capabilities: &tools.ToolCapabilities{Streaming: true},
	})
	assert.NoError(t, err)
	assert.Len(t, filtered, 1)
	assert.Equal(t, "tool3", filtered[0].ID)

	// Test filter by keywords
	filtered, err = reg.List(&tools.ToolFilter{
		Keywords: []string{"search"},
	})
	assert.NoError(t, err)
	assert.Len(t, filtered, 1)
	assert.Equal(t, "tool1", filtered[0].ID)
}

func TestRegistry_ConcurrentAccess(t *testing.T) {
	reg := tools.NewRegistry()
	numGoroutines := 100
	toolsPerGoroutine := 10

	var wg sync.WaitGroup
	errors := make(chan error, numGoroutines*toolsPerGoroutine)

	// Concurrent writes
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(routineID int) {
			defer wg.Done()
			for j := 0; j < toolsPerGoroutine; j++ {
				tool := createTestTool(
					fmt.Sprintf("tool-%d-%d", routineID, j),
					fmt.Sprintf("Tool %d-%d", routineID, j),
				)
				if err := reg.Register(tool); err != nil {
					errors <- err
				}
			}
		}(i)
	}

	// Concurrent reads
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Perform various read operations
			reg.Count()
			reg.ListAll()
			reg.List(&tools.ToolFilter{Name: "*Tool*"})
		}()
	}

	wg.Wait()
	close(errors)

	// Check for errors
	for err := range errors {
		t.Errorf("Concurrent operation error: %v", err)
	}

	// Verify all tools were registered
	assert.Equal(t, numGoroutines*toolsPerGoroutine, reg.Count())
}

func TestRegistry_CustomValidators(t *testing.T) {
	reg := tools.NewRegistry()

	// Add custom validator that requires tools to have author metadata
	reg.AddValidator(func(tool *tools.Tool) error {
		if tool.Metadata == nil || tool.Metadata.Author == "" {
			return fmt.Errorf("tool must have author metadata")
		}
		return nil
	})

	// Tool without author should fail
	tool1 := createTestTool("tool1", "Tool One")
	err := reg.Register(tool1)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "author")

	// Tool with author should succeed
	tool2 := createTestToolWithMetadata("tool2", "Tool Two", nil, nil)
	err = reg.Register(tool2)
	assert.NoError(t, err)
}

func TestRegistry_Dependencies(t *testing.T) {
	reg := tools.NewRegistry()

	// Register base tools
	tool1 := createTestTool("base1", "Base Tool 1")
	tool2 := createTestTool("base2", "Base Tool 2")
	err := reg.Register(tool1)
	require.NoError(t, err)
	err = reg.Register(tool2)
	require.NoError(t, err)

	// Register tool with dependencies
	toolWithDeps := createTestToolWithMetadata("dependent", "Dependent Tool",
		nil, []string{"base1", "base2"})
	err = reg.Register(toolWithDeps)
	assert.NoError(t, err)

	// Get dependencies
	deps, err := reg.GetDependencies("dependent")
	assert.NoError(t, err)
	assert.Len(t, deps, 2)

	// Get dependencies for non-existent tool
	_, err = reg.GetDependencies("nonexistent")
	assert.Error(t, err)

	// Get dependencies for tool without dependencies
	deps, err = reg.GetDependencies("base1")
	assert.NoError(t, err)
	assert.Len(t, deps, 0)
}

func TestRegistry_CircularDependency(t *testing.T) {
	reg := tools.NewRegistry()

	// Create tools with circular dependency
	tool1 := createTestToolWithMetadata("tool1", "Tool 1", nil, []string{"tool2"})
	tool2 := createTestToolWithMetadata("tool2", "Tool 2", nil, []string{"tool3"})
	tool3 := createTestToolWithMetadata("tool3", "Tool 3", nil, []string{"tool1"})

	// Register first two tools
	err := reg.Register(tool1)
	require.NoError(t, err)
	err = reg.Register(tool2)
	require.NoError(t, err)

	// Check that registering tool3 would create a circular dependency
	hasCycle := reg.HasCircularDependency(tool3)
	assert.True(t, hasCycle)

	// Tool without circular dependency
	tool4 := createTestToolWithMetadata("tool4", "Tool 4", nil, []string{"tool1"})
	hasCycle = reg.HasCircularDependency(tool4)
	assert.False(t, hasCycle)
}

func TestRegistry_ImportExport(t *testing.T) {
	reg1 := tools.NewRegistry()

	// Create and register tools
	testTools := map[string]*tools.Tool{
		"tool1": createTestToolWithMetadata("tool1", "Tool One",
			[]string{"tag1"}, nil),
		"tool2": createTestToolWithMetadata("tool2", "Tool Two",
			[]string{"tag2"}, []string{"tool1"}),
		"tool3": createTestToolWithCapabilities("tool3", "Tool Three",
			&tools.ToolCapabilities{Streaming: true}),
	}

	for _, tool := range testTools {
		err := reg1.Register(tool)
		require.NoError(t, err)
	}

	// Export tools
	exported := reg1.ExportTools()
	assert.Len(t, exported, 3)

	// Import into new registry
	reg2 := tools.NewRegistry()
	errors := reg2.ImportTools(exported)
	assert.Len(t, errors, 0)
	assert.Equal(t, reg1.Count(), reg2.Count())

	// Verify all tools were imported correctly
	for id := range testTools {
		tool1, err1 := reg1.Get(id)
		tool2, err2 := reg2.Get(id)
		assert.NoError(t, err1)
		assert.NoError(t, err2)
		assert.Equal(t, tool1.ID, tool2.ID)
		assert.Equal(t, tool1.Name, tool2.Name)
	}
}

func TestRegistry_ImportWithErrors(t *testing.T) {
	reg := tools.NewRegistry()

	// Create tools with some invalid ones
	testTools := map[string]*tools.Tool{
		"valid1": createTestTool("valid1", "Valid Tool 1"),
		"invalid1": {
			ID:   "invalid1",
			Name: "", // Missing name
		},
		"valid2": createTestTool("valid2", "Valid Tool 2"),
	}

	errors := reg.ImportTools(testTools)
	assert.Len(t, errors, 1)
	assert.Equal(t, 2, reg.Count()) // Only valid tools imported
}

func TestRegistry_Clear(t *testing.T) {
	reg := tools.NewRegistry()

	// Add multiple tools
	for i := 0; i < 5; i++ {
		tool := createTestToolWithMetadata(
			fmt.Sprintf("tool%d", i),
			fmt.Sprintf("Tool %d", i),
			[]string{fmt.Sprintf("tag%d", i)},
			nil,
		)
		err := reg.Register(tool)
		require.NoError(t, err)
	}

	assert.Equal(t, 5, reg.Count())
	// Note: Cannot verify internal indexes when using external test package

	// Clear registry
	reg.Clear()

	assert.Equal(t, 0, reg.Count())
	// Note: Cannot verify internal indexes when using external test package
}

func TestRegistry_Validate(t *testing.T) {
	reg := tools.NewRegistry()

	// Add valid tools
	tool1 := createTestTool("tool1", "Tool One")
	err := reg.Register(tool1)
	require.NoError(t, err)

	// Validate should pass
	err = reg.Validate()
	assert.NoError(t, err)

	// Add custom validator
	reg.AddValidator(func(tool *tools.Tool) error {
		if tool.Version != "2.0.0" {
			return fmt.Errorf("all tools must be version 2.0.0")
		}
		return nil
	})

	// Validate should now fail
	err = reg.Validate()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "version")
}

func TestRegistry_CloneIsolation(t *testing.T) {
	reg := tools.NewRegistry()
	tool := createTestTool("tool1", "Tool One")

	err := reg.Register(tool)
	require.NoError(t, err)

	// Get tool and modify it
	retrieved, err := reg.Get("tool1")
	require.NoError(t, err)
	retrieved.Name = "Modified Name"

	// Original should be unchanged
	original, err := reg.Get("tool1")
	require.NoError(t, err)
	assert.Equal(t, "Tool One", original.Name)
}

func TestRegistry_EdgeCases(t *testing.T) {
	reg := tools.NewRegistry()

	t.Run("empty filter returns all", func(t *testing.T) {
		tool := createTestTool("tool1", "Tool One")
		err := reg.Register(tool)
		require.NoError(t, err)

		results, err := reg.List(&tools.ToolFilter{})
		assert.NoError(t, err)
		assert.Len(t, results, 1)
	})

	t.Run("filter with no matches", func(t *testing.T) {
		results, err := reg.List(&tools.ToolFilter{Name: "NonExistent"})
		assert.NoError(t, err)
		assert.Len(t, results, 0)
	})

	t.Run("tool with empty tag list", func(t *testing.T) {
		tool := createTestToolWithMetadata("tool2", "Tool Two", []string{}, nil)
		err := reg.Register(tool)
		assert.NoError(t, err)
		// Note: Cannot verify internal tagIndex when using external test package
	})

	t.Run("unregister tool with missing dependencies", func(t *testing.T) {
		tool := createTestToolWithMetadata("tool3", "Tool Three", nil, []string{"missing"})
		err := reg.Register(tool)
		require.NoError(t, err)

		_, err = reg.GetDependencies("tool3")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing")
	})
}

func TestRegistry_FilterComplexCases(t *testing.T) {
	reg := tools.NewRegistry()

	// Setup complex tool set
	testTools := []*tools.Tool{
		createTestToolWithMetadata("search1", "Search Engine Tool",
			[]string{"search", "web", "api"}, nil),
		createTestToolWithMetadata("search2", "Database Search Tool",
			[]string{"search", "database", "sql"}, nil),
		createTestToolWithCapabilities("stream1", "Streaming Search API",
			&tools.ToolCapabilities{Streaming: true, Async: true}),
	}

	testTools[2].Metadata = &tools.ToolMetadata{Tags: []string{"search", "stream"}}

	for _, tool := range testTools {
		err := reg.Register(tool)
		require.NoError(t, err)
	}

	t.Run("multiple filter criteria", func(t *testing.T) {
		results, err := reg.List(&tools.ToolFilter{
			Tags:     []string{"search"},
			Keywords: []string{"database"},
		})
		assert.NoError(t, err)
		assert.Len(t, results, 1)
		assert.Equal(t, "search2", results[0].ID)
	})

	t.Run("capabilities and tags", func(t *testing.T) {
		results, err := reg.List(&tools.ToolFilter{
			Tags:         []string{"search"},
			Capabilities: &tools.ToolCapabilities{Streaming: true},
		})
		assert.NoError(t, err)
		assert.Len(t, results, 1)
		assert.Equal(t, "stream1", results[0].ID)
	})
}

// Benchmark tests
func BenchmarkRegistry_Register(b *testing.B) {
	reg := tools.NewRegistry()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		tool := createTestTool(fmt.Sprintf("tool%d", i), fmt.Sprintf("Tool %d", i))
		reg.Register(tool)
	}
}

func BenchmarkRegistry_Get(b *testing.B) {
	reg := tools.NewRegistry()
	// Pre-populate registry
	for i := 0; i < 1000; i++ {
		tool := createTestTool(fmt.Sprintf("tool%d", i), fmt.Sprintf("Tool %d", i))
		reg.Register(tool)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reg.Get(fmt.Sprintf("tool%d", i%1000))
	}
}

func BenchmarkRegistry_List(b *testing.B) {
	reg := tools.NewRegistry()
	// Pre-populate registry with various tools
	for i := 0; i < 1000; i++ {
		tags := []string{fmt.Sprintf("tag%d", i%10)}
		tool := createTestToolWithMetadata(
			fmt.Sprintf("tool%d", i),
			fmt.Sprintf("Tool %d", i),
			tags,
			nil,
		)
		reg.Register(tool)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reg.List(&tools.ToolFilter{Tags: []string{fmt.Sprintf("tag%d", i%10)}})
	}
}

func BenchmarkRegistry_GetReadOnly(b *testing.B) {
	reg := tools.NewRegistry()
	// Pre-populate registry
	for i := 0; i < 1000; i++ {
		tool := createTestTool(fmt.Sprintf("tool%d", i), fmt.Sprintf("Tool %d", i))
		reg.Register(tool)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reg.GetReadOnly(fmt.Sprintf("tool%d", i%1000))
	}
}

func TestMemoryOptimization_ReadOnlyVsCloning(t *testing.T) {
	registry := tools.NewRegistry()

	// Create a tool with substantial metadata to show memory differences
	tool := &tools.Tool{
		ID:          "memory-test-tool",
		Name:        "Memory Test Tool",
		Description: "Tool for testing memory optimization",
		Version:     "1.0.0",
		Schema: &tools.ToolSchema{
			Type: "object",
			Properties: map[string]*tools.Property{
				"data": {Type: "string", Description: "Large data field"},
				"config": {
					Type: "object",
					Properties: map[string]*tools.Property{
						"nested1": {Type: "string", Description: "Nested field 1"},
						"nested2": {Type: "string", Description: "Nested field 2"},
						"nested3": {Type: "string", Description: "Nested field 3"},
					},
				},
			},
			Required: []string{"data"},
		},
		Metadata: &tools.ToolMetadata{
			Author:        "Test Author",
			Documentation: "https://example.com/docs/memory-test-tool",
			Tags:          []string{"test", "memory", "optimization", "benchmark", "performance"},
			Examples: []tools.ToolExample{
				{
					Input:       map[string]interface{}{"data": "example1", "config": map[string]interface{}{"nested1": "value1"}},
					Output:      "Example output 1",
					Description: "Example 1 for testing memory usage",
				},
				{
					Input:       map[string]interface{}{"data": "example2", "config": map[string]interface{}{"nested2": "value2"}},
					Output:      "Example output 2",
					Description: "Example 2 for testing memory usage",
				},
			},
		},
		Executor: &mockRegistryExecutor{name: "test"},
		Capabilities: &tools.ToolCapabilities{
			Streaming:  false,
			Timeout:    30 * time.Second,
			Retryable:  true,
			Cancelable: true,
		},
	}

	require.NoError(t, registry.Register(tool))

	t.Run("read-only access does not clone", func(t *testing.T) {
		// Get read-only view
		readOnlyTool, err := registry.GetReadOnly("memory-test-tool")
		require.NoError(t, err)

		// Verify we can access all properties
		assert.Equal(t, "memory-test-tool", readOnlyTool.GetID())
		assert.Equal(t, "Memory Test Tool", readOnlyTool.GetName())
		assert.Equal(t, "Tool for testing memory optimization", readOnlyTool.GetDescription())
		assert.Equal(t, "1.0.0", readOnlyTool.GetVersion())
		assert.NotNil(t, readOnlyTool.GetSchema())
		assert.NotNil(t, readOnlyTool.GetMetadata())
		assert.NotNil(t, readOnlyTool.GetExecutor())
		assert.NotNil(t, readOnlyTool.GetCapabilities())

		// Verify schema access
		schema := readOnlyTool.GetSchema()
		assert.Equal(t, "object", schema.Type)
		assert.Contains(t, schema.Properties, "data")
		assert.Contains(t, schema.Properties, "config")

		// Verify metadata access
		metadata := readOnlyTool.GetMetadata()
		assert.Equal(t, "Test Author", metadata.Author)
		assert.Equal(t, "https://example.com/docs/memory-test-tool", metadata.Documentation)
		assert.Len(t, metadata.Tags, 5)
		assert.Len(t, metadata.Examples, 2)
	})

	t.Run("can clone when modification needed", func(t *testing.T) {
		// Get read-only view
		readOnlyTool, err := registry.GetReadOnly("memory-test-tool")
		require.NoError(t, err)

		// Clone when modification is needed
		clonedTool := readOnlyTool.Clone()
		require.NotNil(t, clonedTool)

		// Verify cloned tool has same content
		assert.Equal(t, readOnlyTool.GetID(), clonedTool.ID)
		assert.Equal(t, readOnlyTool.GetName(), clonedTool.Name)
		assert.Equal(t, readOnlyTool.GetDescription(), clonedTool.Description)

		// Modification of clone should not affect original
		clonedTool.Description = "Modified description"
		assert.NotEqual(t, readOnlyTool.GetDescription(), clonedTool.Description)
	})
}
