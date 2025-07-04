package tools

import (
	"fmt"
	"strings"
	"sync"
)

// Registry manages the collection of available tools.
// It provides thread-safe registration, discovery, and management of tools.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]*Tool

	// categoryIndex maps categories to tool IDs for fast lookup
	categoryIndex map[string]map[string]bool

	// tagIndex maps tags to tool IDs for fast lookup
	tagIndex map[string]map[string]bool

	// nameIndex maps tool names to IDs for fast lookup
	nameIndex map[string]string

	// validators for custom validation rules
	validators []RegistryValidator
}

// RegistryValidator is a function that validates tools during registration.
type RegistryValidator func(tool *Tool) error

// NewRegistry creates a new tool registry.
func NewRegistry() *Registry {
	return &Registry{
		tools:         make(map[string]*Tool),
		categoryIndex: make(map[string]map[string]bool),
		tagIndex:      make(map[string]map[string]bool),
		nameIndex:     make(map[string]string),
		validators:    []RegistryValidator{},
	}
}

// Register adds a new tool to the registry.
// It returns an error if the tool is invalid or if a tool with the same ID already exists.
func (r *Registry) Register(tool *Tool) error {
	if tool == nil {
		return fmt.Errorf("tool cannot be nil")
	}

	// Validate the tool
	if err := tool.Validate(); err != nil {
		return fmt.Errorf("tool validation failed: %w", err)
	}

	// Run custom validators
	for _, validator := range r.validators {
		if err := validator(tool); err != nil {
			return fmt.Errorf("custom validation failed: %w", err)
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Check for ID conflicts
	if _, exists := r.tools[tool.ID]; exists {
		return fmt.Errorf("tool with ID %q already registered", tool.ID)
	}

	// Check for name conflicts
	if existingID, exists := r.nameIndex[tool.Name]; exists && existingID != tool.ID {
		return fmt.Errorf("tool with name %q already registered (ID: %s)", tool.Name, existingID)
	}

	// Store a clone to prevent external modifications
	r.tools[tool.ID] = tool.Clone()

	// Update indexes
	r.nameIndex[tool.Name] = tool.ID

	// Update category index if available
	if tool.Metadata != nil && len(tool.Metadata.Tags) > 0 {
		for _, tag := range tool.Metadata.Tags {
			if r.tagIndex[tag] == nil {
				r.tagIndex[tag] = make(map[string]bool)
			}
			r.tagIndex[tag][tool.ID] = true
		}
	}

	return nil
}

// Unregister removes a tool from the registry.
// It returns an error if the tool is not found.
func (r *Registry) Unregister(toolID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	tool, exists := r.tools[toolID]
	if !exists {
		return fmt.Errorf("tool with ID %q not found", toolID)
	}

	// Remove from main storage
	delete(r.tools, toolID)

	// Remove from name index
	delete(r.nameIndex, tool.Name)

	// Remove from tag index
	if tool.Metadata != nil && len(tool.Metadata.Tags) > 0 {
		for _, tag := range tool.Metadata.Tags {
			if tagMap := r.tagIndex[tag]; tagMap != nil {
				delete(tagMap, toolID)
				if len(tagMap) == 0 {
					delete(r.tagIndex, tag)
				}
			}
		}
	}

	return nil
}

// Get retrieves a tool by its ID.
// It returns nil if the tool is not found.
// This method returns a clone for backward compatibility.
func (r *Registry) Get(toolID string) (*Tool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tool, exists := r.tools[toolID]
	if !exists {
		return nil, fmt.Errorf("tool with ID %q not found", toolID)
	}

	// Return a clone to prevent external modifications
	return tool.Clone(), nil
}

// GetReadOnly retrieves a read-only view of a tool by its ID.
// This is more memory-efficient than Get() as it avoids cloning.
func (r *Registry) GetReadOnly(toolID string) (ReadOnlyTool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tool, exists := r.tools[toolID]
	if !exists {
		return nil, fmt.Errorf("tool with ID %q not found", toolID)
	}

	// Return a read-only view without cloning
	return NewReadOnlyTool(tool), nil
}

// GetByName retrieves a tool by its name.
// It returns nil if the tool is not found.
// This method returns a clone for backward compatibility.
func (r *Registry) GetByName(name string) (*Tool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	toolID, exists := r.nameIndex[name]
	if !exists {
		return nil, fmt.Errorf("tool with name %q not found", name)
	}

	tool := r.tools[toolID]
	return tool.Clone(), nil
}

// GetByNameReadOnly retrieves a read-only view of a tool by its name.
// This is more memory-efficient than GetByName() as it avoids cloning.
func (r *Registry) GetByNameReadOnly(name string) (ReadOnlyTool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	toolID, exists := r.nameIndex[name]
	if !exists {
		return nil, fmt.Errorf("tool with name %q not found", name)
	}

	tool := r.tools[toolID]
	return NewReadOnlyTool(tool), nil
}

// List returns all tools that match the given filter.
// If filter is nil, all tools are returned.
// This method returns clones for backward compatibility.
func (r *Registry) List(filter *ToolFilter) ([]*Tool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var results []*Tool

	for _, tool := range r.tools {
		if filter == nil || r.matchesFilter(tool, filter) {
			results = append(results, tool.Clone())
		}
	}

	return results, nil
}

// ListReadOnly returns read-only views of all tools that match the given filter.
// This is more memory-efficient than List() as it avoids cloning.
func (r *Registry) ListReadOnly(filter *ToolFilter) ([]ReadOnlyTool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var results []ReadOnlyTool

	for _, tool := range r.tools {
		if filter == nil || r.matchesFilter(tool, filter) {
			results = append(results, NewReadOnlyTool(tool))
		}
	}

	return results, nil
}

// ListAll returns all registered tools.
func (r *Registry) ListAll() ([]*Tool, error) {
	return r.List(nil)
}

// Count returns the number of registered tools.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.tools)
}

// Clear removes all tools from the registry.
func (r *Registry) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.tools = make(map[string]*Tool)
	r.categoryIndex = make(map[string]map[string]bool)
	r.tagIndex = make(map[string]map[string]bool)
	r.nameIndex = make(map[string]string)
}

// AddValidator adds a custom validation function that will be run
// during tool registration.
func (r *Registry) AddValidator(validator RegistryValidator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.validators = append(r.validators, validator)
}

// Validate runs validation on all registered tools.
// This is useful for ensuring registry consistency.
func (r *Registry) Validate() error {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for id, tool := range r.tools {
		if err := tool.Validate(); err != nil {
			return fmt.Errorf("tool %q validation failed: %w", id, err)
		}

		for _, validator := range r.validators {
			if err := validator(tool); err != nil {
				return fmt.Errorf("tool %q custom validation failed: %w", id, err)
			}
		}
	}

	return nil
}

// matchesFilter checks if a tool matches the given filter criteria.
func (r *Registry) matchesFilter(tool *Tool, filter *ToolFilter) bool {
	// Check name filter (supports wildcards with *)
	if filter.Name != "" {
		if strings.Contains(filter.Name, "*") {
			pattern := strings.ReplaceAll(filter.Name, "*", "")
			if !strings.Contains(tool.Name, pattern) {
				return false
			}
		} else if tool.Name != filter.Name {
			return false
		}
	}

	// Check tags filter (tool must have all specified tags)
	if len(filter.Tags) > 0 && tool.Metadata != nil {
		toolTags := make(map[string]bool)
		for _, tag := range tool.Metadata.Tags {
			toolTags[tag] = true
		}

		for _, requiredTag := range filter.Tags {
			if !toolTags[requiredTag] {
				return false
			}
		}
	} else if len(filter.Tags) > 0 {
		// Tool has no metadata/tags but filter requires tags
		return false
	}

	// Check capabilities filter
	if filter.Capabilities != nil && tool.Capabilities != nil {
		caps := filter.Capabilities
		toolCaps := tool.Capabilities

		if caps.Streaming && !toolCaps.Streaming {
			return false
		}
		if caps.Async && !toolCaps.Async {
			return false
		}
		if caps.Cancellable && !toolCaps.Cancellable {
			return false
		}
		if caps.Retryable && !toolCaps.Retryable {
			return false
		}
		if caps.Cacheable && !toolCaps.Cacheable {
			return false
		}
	} else if filter.Capabilities != nil {
		// Tool has no capabilities but filter requires them
		return false
	}

	// Check keywords in name and description
	if len(filter.Keywords) > 0 {
		searchText := strings.ToLower(tool.Name + " " + tool.Description)
		for _, keyword := range filter.Keywords {
			if !strings.Contains(searchText, strings.ToLower(keyword)) {
				return false
			}
		}
	}

	// TODO: Add version constraint matching when version parsing is implemented

	return true
}

// GetDependencies returns all tools that the specified tool depends on.
func (r *Registry) GetDependencies(toolID string) ([]*Tool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tool, exists := r.tools[toolID]
	if !exists {
		return nil, fmt.Errorf("tool with ID %q not found", toolID)
	}

	if tool.Metadata == nil || len(tool.Metadata.Dependencies) == 0 {
		return []*Tool{}, nil
	}

	var dependencies []*Tool
	for _, depID := range tool.Metadata.Dependencies {
		dep, exists := r.tools[depID]
		if !exists {
			return nil, fmt.Errorf("dependency %q not found for tool %q", depID, toolID)
		}
		dependencies = append(dependencies, dep.Clone())
	}

	return dependencies, nil
}

// HasCircularDependency checks if registering a tool would create a circular dependency.
func (r *Registry) HasCircularDependency(tool *Tool) bool {
	if tool.Metadata == nil || len(tool.Metadata.Dependencies) == 0 {
		return false
	}

	visited := make(map[string]bool)
	stack := make(map[string]bool)

	var hasCycle func(toolID string) bool
	hasCycle = func(toolID string) bool {
		visited[toolID] = true
		stack[toolID] = true

		t, exists := r.tools[toolID]
		if !exists && toolID == tool.ID {
			t = tool // Check the tool being registered
		}

		if t != nil && t.Metadata != nil {
			for _, depID := range t.Metadata.Dependencies {
				if stack[depID] {
					return true // Cycle detected
				}

				if !visited[depID] && hasCycle(depID) {
					return true
				}
			}
		}

		stack[toolID] = false
		return false
	}

	return hasCycle(tool.ID)
}

// ExportTools returns all tools in a format suitable for serialization.
func (r *Registry) ExportTools() map[string]*Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	export := make(map[string]*Tool, len(r.tools))
	for id, tool := range r.tools {
		export[id] = tool.Clone()
	}
	return export
}

// ImportTools bulk imports tools into the registry.
// It returns a slice of errors for any tools that failed to import.
func (r *Registry) ImportTools(tools map[string]*Tool) []error {
	var errors []error

	for _, tool := range tools {
		if err := r.Register(tool); err != nil {
			errors = append(errors, fmt.Errorf("failed to import tool %q: %w", tool.ID, err))
		}
	}

	return errors
}