package tools

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// SchemaValidator provides JSON Schema validation for tool parameters.
type SchemaValidator struct {
	// schema is the tool's parameter schema
	schema *ToolSchema
}

// NewSchemaValidator creates a new schema validator for the given tool schema.
func NewSchemaValidator(schema *ToolSchema) *SchemaValidator {
	return &SchemaValidator{
		schema: schema,
	}
}

// Validate checks if the given parameters match the tool's schema.
// It returns a detailed error if validation fails.
func (v *SchemaValidator) Validate(params map[string]interface{}) error {
	if v.schema == nil {
		return nil // No schema means any parameters are valid
	}

	// Validate the top-level object
	return v.validateObject(v.schema, params, "")
}

// validateObject validates an object against a schema.
func (v *SchemaValidator) validateObject(schema *ToolSchema, value map[string]interface{}, path string) error {
	// Check for additional properties
	if schema.AdditionalProperties != nil && !*schema.AdditionalProperties {
		for key := range value {
			if _, defined := schema.Properties[key]; !defined {
				return newValidationError(path, fmt.Sprintf("additional property %q is not allowed", key))
			}
		}
	}

	// Check required properties
	for _, required := range schema.Required {
		if _, exists := value[required]; !exists {
			return newValidationError(joinPath(path, required), "required property is missing")
		}
	}

	// Validate each property
	for name, prop := range schema.Properties {
		propPath := joinPath(path, name)
		propValue, exists := value[name]

		if !exists {
			// Check if property is required
			for _, req := range schema.Required {
				if req == name {
					return newValidationError(propPath, "required property is missing")
				}
			}
			// Property is optional and not provided
			continue
		}

		if err := v.validateValue(prop, propValue, propPath); err != nil {
			return err
		}
	}

	return nil
}

// validateValue validates a single value against a property schema.
func (v *SchemaValidator) validateValue(prop *Property, value interface{}, path string) error {
	// Handle null values
	if value == nil {
		if prop.Type != "null" {
			// Check if property is in a oneOf/anyOf that includes null
			// For now, we'll just reject nulls unless type is explicitly "null"
			return newValidationError(path, "value cannot be null")
		}
		return nil
	}

	switch prop.Type {
	case "string":
		return v.validateString(prop, value, path)
	case "number":
		return v.validateNumber(prop, value, path)
	case "integer":
		return v.validateInteger(prop, value, path)
	case "boolean":
		return v.validateBoolean(prop, value, path)
	case "array":
		return v.validateArray(prop, value, path)
	case "object":
		return v.validateObjectProperty(prop, value, path)
	case "null":
		if value != nil {
			return newValidationError(path, "value must be null")
		}
		return nil
	default:
		return newValidationError(path, fmt.Sprintf("unknown type %q", prop.Type))
	}
}

// validateString validates a string value.
func (v *SchemaValidator) validateString(prop *Property, value interface{}, path string) error {
	str, ok := value.(string)
	if !ok {
		return newValidationError(path, fmt.Sprintf("expected string, got %T", value))
	}

	// Check enum
	if len(prop.Enum) > 0 {
		found := false
		for _, allowed := range prop.Enum {
			if allowedStr, ok := allowed.(string); ok && allowedStr == str {
				found = true
				break
			}
		}
		if !found {
			return newValidationError(path, fmt.Sprintf("value %q is not in enum %v", str, prop.Enum))
		}
	}

	// Check length constraints
	if prop.MinLength != nil && len(str) < *prop.MinLength {
		return newValidationError(path, fmt.Sprintf("string length %d is less than minimum %d", len(str), *prop.MinLength))
	}
	if prop.MaxLength != nil && len(str) > *prop.MaxLength {
		return newValidationError(path, fmt.Sprintf("string length %d is greater than maximum %d", len(str), *prop.MaxLength))
	}

	// Check pattern
	if prop.Pattern != "" {
		matched, err := regexp.MatchString(prop.Pattern, str)
		if err != nil {
			return newValidationError(path, fmt.Sprintf("invalid pattern: %v", err))
		}
		if !matched {
			return newValidationError(path, fmt.Sprintf("string %q does not match pattern %q", str, prop.Pattern))
		}
	}

	// Check format
	if prop.Format != "" {
		if err := v.validateFormat(prop.Format, str, path); err != nil {
			return err
		}
	}

	return nil
}

// validateNumber validates a numeric value.
func (v *SchemaValidator) validateNumber(prop *Property, value interface{}, path string) error {
	var num float64

	switch val := value.(type) {
	case float64:
		num = val
	case float32:
		num = float64(val)
	case int:
		num = float64(val)
	case int32:
		num = float64(val)
	case int64:
		num = float64(val)
	case json.Number:
		f, err := val.Float64()
		if err != nil {
			return newValidationError(path, fmt.Sprintf("invalid number: %v", err))
		}
		num = f
	default:
		return newValidationError(path, fmt.Sprintf("expected number, got %T", value))
	}

	// Check enum
	if len(prop.Enum) > 0 {
		found := false
		for _, allowed := range prop.Enum {
			if allowedNum, ok := toFloat64(allowed); ok && allowedNum == num {
				found = true
				break
			}
		}
		if !found {
			return newValidationError(path, fmt.Sprintf("value %v is not in enum %v", num, prop.Enum))
		}
	}

	// Check range constraints
	if prop.Minimum != nil && num < *prop.Minimum {
		return newValidationError(path, fmt.Sprintf("value %v is less than minimum %v", num, *prop.Minimum))
	}
	if prop.Maximum != nil && num > *prop.Maximum {
		return newValidationError(path, fmt.Sprintf("value %v is greater than maximum %v", num, *prop.Maximum))
	}

	return nil
}

// validateInteger validates an integer value.
func (v *SchemaValidator) validateInteger(prop *Property, value interface{}, path string) error {
	var num int64

	switch v := value.(type) {
	case int:
		num = int64(v)
	case int32:
		num = int64(v)
	case int64:
		num = v
	case float64:
		if v != float64(int64(v)) {
			return newValidationError(path, fmt.Sprintf("expected integer, got float %v", v))
		}
		num = int64(v)
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			return newValidationError(path, fmt.Sprintf("invalid integer: %v", err))
		}
		num = i
	default:
		return newValidationError(path, fmt.Sprintf("expected integer, got %T", value))
	}

	// Check enum
	if len(prop.Enum) > 0 {
		found := false
		for _, allowed := range prop.Enum {
			if allowedInt, ok := toInt64(allowed); ok && allowedInt == num {
				found = true
				break
			}
		}
		if !found {
			return newValidationError(path, fmt.Sprintf("value %v is not in enum %v", num, prop.Enum))
		}
	}

	// Check range constraints
	if prop.Minimum != nil && float64(num) < *prop.Minimum {
		return newValidationError(path, fmt.Sprintf("value %v is less than minimum %v", num, *prop.Minimum))
	}
	if prop.Maximum != nil && float64(num) > *prop.Maximum {
		return newValidationError(path, fmt.Sprintf("value %v is greater than maximum %v", num, *prop.Maximum))
	}

	return nil
}

// validateBoolean validates a boolean value.
func (v *SchemaValidator) validateBoolean(prop *Property, value interface{}, path string) error {
	_, ok := value.(bool)
	if !ok {
		return newValidationError(path, fmt.Sprintf("expected boolean, got %T", value))
	}
	return nil
}

// validateArray validates an array value.
func (v *SchemaValidator) validateArray(prop *Property, value interface{}, path string) error {
	arr, ok := value.([]interface{})
	if !ok {
		return newValidationError(path, fmt.Sprintf("expected array, got %T", value))
	}

	// Check length constraints
	if prop.MinLength != nil && len(arr) < *prop.MinLength {
		return newValidationError(path, fmt.Sprintf("array length %d is less than minimum %d", len(arr), *prop.MinLength))
	}
	if prop.MaxLength != nil && len(arr) > *prop.MaxLength {
		return newValidationError(path, fmt.Sprintf("array length %d is greater than maximum %d", len(arr), *prop.MaxLength))
	}

	// Validate items
	if prop.Items != nil {
		for i, item := range arr {
			itemPath := fmt.Sprintf("%s[%d]", path, i)
			if err := v.validateValue(prop.Items, item, itemPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// validateObjectProperty validates an object property value.
func (v *SchemaValidator) validateObjectProperty(prop *Property, value interface{}, path string) error {
	obj, ok := value.(map[string]interface{})
	if !ok {
		return newValidationError(path, fmt.Sprintf("expected object, got %T", value))
	}

	// Create a temporary schema for the nested object
	tempSchema := &ToolSchema{
		Type:       "object",
		Properties: prop.Properties,
		Required:   prop.Required,
	}

	return v.validateObject(tempSchema, obj, path)
}

// validateFormat validates string format constraints.
func (v *SchemaValidator) validateFormat(format, value, path string) error {
	switch format {
	case "email":
		if !isValidEmail(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid email address", value))
		}
	case "uri", "url":
		if !isValidURL(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid URL", value))
		}
	case "date-time":
		if !isValidDateTime(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid date-time", value))
		}
	case "date":
		if !isValidDate(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid date", value))
		}
	case "time":
		if !isValidTime(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid time", value))
		}
	case "uuid":
		if !isValidUUID(value) {
			return newValidationError(path, fmt.Sprintf("%q is not a valid UUID", value))
		}
	// Add more format validators as needed
	}
	return nil
}

// ValidationError represents a schema validation error.
type ValidationError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (e *ValidationError) Error() string {
	if e.Path == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Path, e.Message)
}

// newValidationError creates a new validation error.
func newValidationError(path, message string) error {
	return &ValidationError{
		Path:    path,
		Message: message,
	}
}

// joinPath joins path segments for error reporting.
func joinPath(base, segment string) string {
	if base == "" {
		return segment
	}
	return base + "." + segment
}

// Helper functions for type conversion
func toFloat64(v interface{}) (float64, bool) {
	switch val := v.(type) {
	case float64:
		return val, true
	case float32:
		return float64(val), true
	case int:
		return float64(val), true
	case int32:
		return float64(val), true
	case int64:
		return float64(val), true
	default:
		return 0, false
	}
}

func toInt64(v interface{}) (int64, bool) {
	switch val := v.(type) {
	case int:
		return int64(val), true
	case int32:
		return int64(val), true
	case int64:
		return val, true
	case float64:
		if val == float64(int64(val)) {
			return int64(val), true
		}
		return 0, false
	default:
		return 0, false
	}
}

// Format validation helpers
func isValidEmail(email string) bool {
	// Simple email validation
	parts := strings.Split(email, "@")
	if len(parts) != 2 || len(parts[0]) == 0 || len(parts[1]) == 0 {
		return false
	}
	return strings.Contains(parts[1], ".")
}

func isValidURL(url string) bool {
	// Simple URL validation
	return strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://")
}

func isValidDateTime(dt string) bool {
	// ISO 8601 date-time format validation
	matched, _ := regexp.MatchString(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`, dt)
	return matched
}

func isValidDate(date string) bool {
	// ISO 8601 date format validation
	matched, _ := regexp.MatchString(`^\d{4}-\d{2}-\d{2}$`, date)
	return matched
}

func isValidTime(time string) bool {
	// ISO 8601 time format validation
	matched, _ := regexp.MatchString(`^\d{2}:\d{2}:\d{2}`, time)
	return matched
}

func isValidUUID(uuid string) bool {
	// UUID format validation
	matched, _ := regexp.MatchString(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`, strings.ToLower(uuid))
	return matched
}