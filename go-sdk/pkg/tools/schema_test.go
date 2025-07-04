package tools

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewSchemaValidator(t *testing.T) {
	schema := &ToolSchema{
		Type: "object",
		Properties: map[string]*Property{
			"name": {Type: "string"},
		},
	}

	validator := NewSchemaValidator(schema)
	assert.NotNil(t, validator)
	assert.Equal(t, schema, validator.schema)
}

func TestSchemaValidator_ValidateString(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid string",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
			},
			params:  map[string]interface{}{"name": "John"},
			wantErr: false,
		},
		{
			name: "invalid type for string",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
			},
			params:  map[string]interface{}{"name": 123},
			wantErr: true,
			errMsg:  "name: expected string, got int",
		},
		{
			name: "string with minLength valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string", MinLength: intPtr2(3)},
				},
			},
			params:  map[string]interface{}{"name": "John"},
			wantErr: false,
		},
		{
			name: "string with minLength invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string", MinLength: intPtr2(5)},
				},
			},
			params:  map[string]interface{}{"name": "John"},
			wantErr: true,
			errMsg:  "name: string length 4 is less than minimum 5",
		},
		{
			name: "string with maxLength valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string", MaxLength: intPtr2(10)},
				},
			},
			params:  map[string]interface{}{"name": "John"},
			wantErr: false,
		},
		{
			name: "string with maxLength invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string", MaxLength: intPtr2(3)},
				},
			},
			params:  map[string]interface{}{"name": "John"},
			wantErr: true,
			errMsg:  "name: string length 4 is greater than maximum 3",
		},
		{
			name: "string with pattern valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"code": {Type: "string", Pattern: "^[A-Z]{3}$"},
				},
			},
			params:  map[string]interface{}{"code": "ABC"},
			wantErr: false,
		},
		{
			name: "string with pattern invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"code": {Type: "string", Pattern: "^[A-Z]{3}$"},
				},
			},
			params:  map[string]interface{}{"code": "abc"},
			wantErr: true,
			errMsg:  "code: string \"abc\" does not match pattern \"^[A-Z]{3}$\"",
		},
		{
			name: "string with enum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"status": {Type: "string", Enum: []interface{}{"active", "inactive", "pending"}},
				},
			},
			params:  map[string]interface{}{"status": "active"},
			wantErr: false,
		},
		{
			name: "string with enum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"status": {Type: "string", Enum: []interface{}{"active", "inactive", "pending"}},
				},
			},
			params:  map[string]interface{}{"status": "deleted"},
			wantErr: true,
			errMsg:  "status: value \"deleted\" is not in enum [active inactive pending]",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateStringFormats(t *testing.T) {
	tests := []struct {
		name    string
		format  string
		value   string
		valid   bool
		errMsg  string
	}{
		// Email format
		{
			name:   "valid email",
			format: "email",
			value:  "user@example.com",
			valid:  true,
		},
		{
			name:   "invalid email - no @",
			format: "email",
			value:  "userexample.com",
			valid:  false,
			errMsg: "email: \"userexample.com\" is not a valid email address",
		},
		{
			name:   "invalid email - no domain",
			format: "email",
			value:  "user@",
			valid:  false,
			errMsg: "email: \"user@\" is not a valid email address",
		},
		{
			name:   "invalid email - no dot in domain",
			format: "email",
			value:  "user@example",
			valid:  false,
			errMsg: "email: \"user@example\" is not a valid email address",
		},
		// URL format
		{
			name:   "valid http URL",
			format: "url",
			value:  "http://example.com",
			valid:  true,
		},
		{
			name:   "valid https URL",
			format: "url",
			value:  "https://example.com",
			valid:  true,
		},
		{
			name:   "invalid URL - no protocol",
			format: "url",
			value:  "example.com",
			valid:  false,
			errMsg: "url: \"example.com\" is not a valid URL",
		},
		// Date-time format
		{
			name:   "valid date-time",
			format: "date-time",
			value:  "2023-12-25T10:30:00Z",
			valid:  true,
		},
		{
			name:   "invalid date-time",
			format: "date-time",
			value:  "2023-12-25",
			valid:  false,
			errMsg: "date-time: \"2023-12-25\" is not a valid date-time",
		},
		// Date format
		{
			name:   "valid date",
			format: "date",
			value:  "2023-12-25",
			valid:  true,
		},
		{
			name:   "invalid date",
			format: "date",
			value:  "12-25-2023",
			valid:  false,
			errMsg: "date: \"12-25-2023\" is not a valid date",
		},
		// Time format
		{
			name:   "valid time",
			format: "time",
			value:  "10:30:00",
			valid:  true,
		},
		{
			name:   "invalid time",
			format: "time",
			value:  "10:30",
			valid:  false,
			errMsg: "time: \"10:30\" is not a valid time",
		},
		// UUID format
		{
			name:   "valid UUID",
			format: "uuid",
			value:  "550e8400-e29b-41d4-a716-446655440000",
			valid:  true,
		},
		{
			name:   "valid UUID uppercase",
			format: "uuid",
			value:  "550E8400-E29B-41D4-A716-446655440000",
			valid:  true,
		},
		{
			name:   "invalid UUID - wrong format",
			format: "uuid",
			value:  "550e8400-e29b-41d4-a716",
			valid:  false,
			errMsg: "uuid: \"550e8400-e29b-41d4-a716\" is not a valid UUID",
		},
		{
			name:   "invalid UUID - wrong characters",
			format: "uuid",
			value:  "550e8400-e29b-41d4-a716-44665544000g",
			valid:  false,
			errMsg: "uuid: \"550e8400-e29b-41d4-a716-44665544000g\" is not a valid UUID",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			schema := &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					tt.format: {Type: "string", Format: tt.format},
				},
			}
			validator := NewSchemaValidator(schema)
			err := validator.Validate(map[string]interface{}{tt.format: tt.value})
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			}
		})
	}
}

func TestSchemaValidator_ValidateNumber(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid float64 number",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"price": {Type: "number"},
				},
			},
			params:  map[string]interface{}{"price": 99.99},
			wantErr: false,
		},
		{
			name: "valid int as number",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"price": {Type: "number"},
				},
			},
			params:  map[string]interface{}{"price": 100},
			wantErr: false,
		},
		{
			name: "invalid type for number",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"price": {Type: "number"},
				},
			},
			params:  map[string]interface{}{"price": "100"},
			wantErr: true,
			errMsg:  "price: expected number, got string",
		},
		{
			name: "number with minimum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"age": {Type: "number", Minimum: float64Ptr2(18)},
				},
			},
			params:  map[string]interface{}{"age": 25},
			wantErr: false,
		},
		{
			name: "number with minimum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"age": {Type: "number", Minimum: float64Ptr2(18)},
				},
			},
			params:  map[string]interface{}{"age": 17},
			wantErr: true,
			errMsg:  "age: value 17 is less than minimum 18",
		},
		{
			name: "number with maximum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"discount": {Type: "number", Maximum: float64Ptr2(100)},
				},
			},
			params:  map[string]interface{}{"discount": 50},
			wantErr: false,
		},
		{
			name: "number with maximum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"discount": {Type: "number", Maximum: float64Ptr2(100)},
				},
			},
			params:  map[string]interface{}{"discount": 150},
			wantErr: true,
			errMsg:  "discount: value 150 is greater than maximum 100",
		},
		{
			name: "number with enum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"rating": {Type: "number", Enum: []interface{}{1.0, 1.5, 2.0, 2.5, 3.0}},
				},
			},
			params:  map[string]interface{}{"rating": 2.5},
			wantErr: false,
		},
		{
			name: "number with enum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"rating": {Type: "number", Enum: []interface{}{1.0, 1.5, 2.0, 2.5, 3.0}},
				},
			},
			params:  map[string]interface{}{"rating": 3.5},
			wantErr: true,
			errMsg:  "rating: value 3.5 is not in enum [1 1.5 2 2.5 3]",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateInteger(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid integer",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"count": {Type: "integer"},
				},
			},
			params:  map[string]interface{}{"count": 42},
			wantErr: false,
		},
		{
			name: "float as integer - whole number",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"count": {Type: "integer"},
				},
			},
			params:  map[string]interface{}{"count": 42.0},
			wantErr: false,
		},
		{
			name: "float as integer - decimal",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"count": {Type: "integer"},
				},
			},
			params:  map[string]interface{}{"count": 42.5},
			wantErr: true,
			errMsg:  "count: expected integer, got float 42.5",
		},
		{
			name: "string as integer",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"count": {Type: "integer"},
				},
			},
			params:  map[string]interface{}{"count": "42"},
			wantErr: true,
			errMsg:  "count: expected integer, got string",
		},
		{
			name: "integer with minimum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"quantity": {Type: "integer", Minimum: float64Ptr2(1)},
				},
			},
			params:  map[string]interface{}{"quantity": 5},
			wantErr: false,
		},
		{
			name: "integer with minimum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"quantity": {Type: "integer", Minimum: float64Ptr2(1)},
				},
			},
			params:  map[string]interface{}{"quantity": 0},
			wantErr: true,
			errMsg:  "quantity: value 0 is less than minimum 1",
		},
		{
			name: "integer with enum valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"level": {Type: "integer", Enum: []interface{}{1, 2, 3, 4, 5}},
				},
			},
			params:  map[string]interface{}{"level": 3},
			wantErr: false,
		},
		{
			name: "integer with enum invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"level": {Type: "integer", Enum: []interface{}{1, 2, 3, 4, 5}},
				},
			},
			params:  map[string]interface{}{"level": 6},
			wantErr: true,
			errMsg:  "level: value 6 is not in enum [1 2 3 4 5]",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateBoolean(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid boolean true",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"active": {Type: "boolean"},
				},
			},
			params:  map[string]interface{}{"active": true},
			wantErr: false,
		},
		{
			name: "valid boolean false",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"active": {Type: "boolean"},
				},
			},
			params:  map[string]interface{}{"active": false},
			wantErr: false,
		},
		{
			name: "invalid type for boolean",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"active": {Type: "boolean"},
				},
			},
			params:  map[string]interface{}{"active": "true"},
			wantErr: true,
			errMsg:  "active: expected boolean, got string",
		},
		{
			name: "invalid type for boolean - number",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"active": {Type: "boolean"},
				},
			},
			params:  map[string]interface{}{"active": 1},
			wantErr: true,
			errMsg:  "active: expected boolean, got int",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateArray(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid array of strings",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"tags": {
						Type:  "array",
						Items: &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"tags": []interface{}{"tag1", "tag2", "tag3"}},
			wantErr: false,
		},
		{
			name: "valid empty array",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"tags": {
						Type:  "array",
						Items: &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"tags": []interface{}{}},
			wantErr: false,
		},
		{
			name: "invalid type for array",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"tags": {
						Type:  "array",
						Items: &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"tags": "not-an-array"},
			wantErr: true,
			errMsg:  "tags: expected array, got string",
		},
		{
			name: "array with minLength valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"items": {
						Type:      "array",
						MinLength: intPtr2(2),
						Items:     &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"items": []interface{}{"a", "b", "c"}},
			wantErr: false,
		},
		{
			name: "array with minLength invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"items": {
						Type:      "array",
						MinLength: intPtr2(2),
						Items:     &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"items": []interface{}{"a"}},
			wantErr: true,
			errMsg:  "items: array length 1 is less than minimum 2",
		},
		{
			name: "array with maxLength valid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"items": {
						Type:      "array",
						MaxLength: intPtr2(3),
						Items:     &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"items": []interface{}{"a", "b"}},
			wantErr: false,
		},
		{
			name: "array with maxLength invalid",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"items": {
						Type:      "array",
						MaxLength: intPtr2(2),
						Items:     &Property{Type: "string"},
					},
				},
			},
			params:  map[string]interface{}{"items": []interface{}{"a", "b", "c"}},
			wantErr: true,
			errMsg:  "items: array length 3 is greater than maximum 2",
		},
		{
			name: "array with invalid item type",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"numbers": {
						Type:  "array",
						Items: &Property{Type: "number"},
					},
				},
			},
			params:  map[string]interface{}{"numbers": []interface{}{1, 2, "three"}},
			wantErr: true,
			errMsg:  "numbers[2]: expected number, got string",
		},
		{
			name: "array of objects",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"users": {
						Type: "array",
						Items: &Property{
							Type: "object",
							Properties: map[string]*Property{
								"name": {Type: "string"},
								"age":  {Type: "integer"},
							},
							Required: []string{"name"},
						},
					},
				},
			},
			params: map[string]interface{}{
				"users": []interface{}{
					map[string]interface{}{"name": "Alice", "age": 30},
					map[string]interface{}{"name": "Bob", "age": 25},
				},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateObject(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid nested object",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"address": {
						Type: "object",
						Properties: map[string]*Property{
							"street": {Type: "string"},
							"city":   {Type: "string"},
							"zip":    {Type: "string"},
						},
						Required: []string{"city"},
					},
				},
			},
			params: map[string]interface{}{
				"address": map[string]interface{}{
					"street": "123 Main St",
					"city":   "New York",
					"zip":    "10001",
				},
			},
			wantErr: false,
		},
		{
			name: "nested object missing required field",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"address": {
						Type: "object",
						Properties: map[string]*Property{
							"street": {Type: "string"},
							"city":   {Type: "string"},
						},
						Required: []string{"city"},
					},
				},
			},
			params: map[string]interface{}{
				"address": map[string]interface{}{
					"street": "123 Main St",
				},
			},
			wantErr: true,
			errMsg:  "address.city: required property is missing",
		},
		{
			name: "invalid type for object",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"config": {Type: "object"},
				},
			},
			params:  map[string]interface{}{"config": "not-an-object"},
			wantErr: true,
			errMsg:  "config: expected object, got string",
		},
		{
			name: "deeply nested objects",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"level1": {
						Type: "object",
						Properties: map[string]*Property{
							"level2": {
								Type: "object",
								Properties: map[string]*Property{
									"level3": {
										Type: "object",
										Properties: map[string]*Property{
											"value": {Type: "string"},
										},
									},
								},
							},
						},
					},
				},
			},
			params: map[string]interface{}{
				"level1": map[string]interface{}{
					"level2": map[string]interface{}{
						"level3": map[string]interface{}{
							"value": "deep",
						},
					},
				},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ValidateNull(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid null value",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"optional": {Type: "null"},
				},
			},
			params:  map[string]interface{}{"optional": nil},
			wantErr: false,
		},
		{
			name: "invalid non-null for null type",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"mustBeNull": {Type: "null"},
				},
			},
			params:  map[string]interface{}{"mustBeNull": "not null"},
			wantErr: true,
			errMsg:  "mustBeNull: value must be null",
		},
		{
			name: "null value for non-null type",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"required": {Type: "string"},
				},
			},
			params:  map[string]interface{}{"required": nil},
			wantErr: true,
			errMsg:  "required: value cannot be null",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_RequiredProperties(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "all required properties present",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name":  {Type: "string"},
					"email": {Type: "string"},
					"age":   {Type: "integer"},
				},
				Required: []string{"name", "email"},
			},
			params: map[string]interface{}{
				"name":  "John",
				"email": "john@example.com",
				"age":   30,
			},
			wantErr: false,
		},
		{
			name: "missing required property",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name":  {Type: "string"},
					"email": {Type: "string"},
				},
				Required: []string{"name", "email"},
			},
			params: map[string]interface{}{
				"name": "John",
			},
			wantErr: true,
			errMsg:  "email: required property is missing",
		},
		{
			name: "optional property can be omitted",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name":     {Type: "string"},
					"nickname": {Type: "string"},
				},
				Required: []string{"name"},
			},
			params: map[string]interface{}{
				"name": "John",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_AdditionalProperties(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "additional properties allowed by default",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
			},
			params: map[string]interface{}{
				"name":  "John",
				"extra": "allowed",
			},
			wantErr: false,
		},
		{
			name: "additional properties explicitly allowed",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
				AdditionalProperties: boolPtr2(true),
			},
			params: map[string]interface{}{
				"name":  "John",
				"extra": "allowed",
			},
			wantErr: false,
		},
		{
			name: "additional properties not allowed",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
				AdditionalProperties: boolPtr2(false),
			},
			params: map[string]interface{}{
				"name":  "John",
				"extra": "not allowed",
			},
			wantErr: true,
			errMsg:  ": additional property \"extra\" is not allowed",
		},
		{
			name: "multiple additional properties not allowed",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"name": {Type: "string"},
				},
				AdditionalProperties: boolPtr2(false),
			},
			params: map[string]interface{}{
				"name":   "John",
				"extra1": "not allowed",
				"extra2": "also not allowed",
			},
			wantErr: true,
			// Note: The error will report the first additional property found
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					// For additional properties, we just check that it's an error
					// The exact property reported may vary due to map iteration order
					assert.Contains(t, err.Error(), "additional property")
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_ComplexScenarios(t *testing.T) {
	tests := []struct {
		name    string
		schema  *ToolSchema
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "complex nested structure with arrays and objects",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"users": {
						Type: "array",
						Items: &Property{
							Type: "object",
							Properties: map[string]*Property{
								"name": {
									Type:      "string",
									MinLength: intPtr2(2),
									MaxLength: intPtr2(50),
								},
								"email": {
									Type:   "string",
									Format: "email",
								},
								"age": {
									Type:    "integer",
									Minimum: float64Ptr2(0),
									Maximum: float64Ptr2(120),
								},
								"roles": {
									Type: "array",
									Items: &Property{
										Type: "string",
										Enum: []interface{}{"admin", "user", "guest"},
									},
								},
								"preferences": {
									Type: "object",
									Properties: map[string]*Property{
										"theme": {
											Type: "string",
											Enum: []interface{}{"light", "dark"},
										},
										"notifications": {
											Type: "boolean",
										},
									},
								},
							},
							Required: []string{"name", "email"},
						},
					},
				},
				Required: []string{"users"},
			},
			params: map[string]interface{}{
				"users": []interface{}{
					map[string]interface{}{
						"name":  "Alice Smith",
						"email": "alice@example.com",
						"age":   30,
						"roles": []interface{}{"admin", "user"},
						"preferences": map[string]interface{}{
							"theme":         "dark",
							"notifications": true,
						},
					},
					map[string]interface{}{
						"name":  "Bob Johnson",
						"email": "bob@example.com",
						"age":   25,
						"roles": []interface{}{"user"},
						"preferences": map[string]interface{}{
							"theme":         "light",
							"notifications": false,
						},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "complex validation failure in nested array",
			schema: &ToolSchema{
				Type: "object",
				Properties: map[string]*Property{
					"data": {
						Type: "array",
						Items: &Property{
							Type: "object",
							Properties: map[string]*Property{
								"id": {
									Type:    "integer",
									Minimum: float64Ptr2(1),
								},
								"value": {
									Type:    "string",
									Pattern: "^[A-Z]+$",
								},
							},
							Required: []string{"id", "value"},
						},
					},
				},
			},
			params: map[string]interface{}{
				"data": []interface{}{
					map[string]interface{}{
						"id":    1,
						"value": "ABC",
					},
					map[string]interface{}{
						"id":    2,
						"value": "abc", // This should fail the pattern
					},
				},
			},
			wantErr: true,
			errMsg:  "data[1].value: string \"abc\" does not match pattern \"^[A-Z]+$\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := NewSchemaValidator(tt.schema)
			err := validator.Validate(tt.params)
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Equal(t, tt.errMsg, err.Error())
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestSchemaValidator_EdgeCases(t *testing.T) {
	t.Run("nil schema", func(t *testing.T) {
		validator := NewSchemaValidator(nil)
		err := validator.Validate(map[string]interface{}{"any": "data"})
		assert.NoError(t, err, "nil schema should accept any data")
	})

	t.Run("empty parameters", func(t *testing.T) {
		schema := &ToolSchema{
			Type:     "object",
			Required: []string{"name"},
			Properties: map[string]*Property{
				"name": {Type: "string"},
			},
		}
		validator := NewSchemaValidator(schema)
		err := validator.Validate(map[string]interface{}{})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "required property is missing")
	})

	t.Run("unknown property type", func(t *testing.T) {
		schema := &ToolSchema{
			Type: "object",
			Properties: map[string]*Property{
				"unknown": {Type: "unknownType"},
			},
		}
		validator := NewSchemaValidator(schema)
		err := validator.Validate(map[string]interface{}{"unknown": "value"})
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "unknown type")
	})
}

// Helper functions for creating pointers
func intPtr2(i int) *int {
	return &i
}

func float64Ptr2(f float64) *float64 {
	return &f
}

func boolPtr2(b bool) *bool {
	return &b
}