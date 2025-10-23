/**
 * Input validation utilities for tool parameters and request data
 * Ensures data integrity and prevents errors from malformed inputs
 */

/**
 * Validation error with detailed context
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: any,
    public constraint: string
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Schema definition for validation
 */
export interface Schema {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: any[];
  pattern?: RegExp;
}

/**
 * Validate a value against a schema
 */
export function validate(
  value: any,
  schema: Schema,
  fieldPath: string = "root"
): ValidationResult {
  const errors: ValidationError[] = [];

  // Type validation
  const actualType = Array.isArray(value) ? "array" : typeof value;
  if (actualType !== schema.type && value !== null && value !== undefined) {
    errors.push(
      new ValidationError(
        `Expected type ${schema.type}, got ${actualType}`,
        fieldPath,
        value,
        "type"
      )
    );
    return { valid: false, errors };
  }

  // Null/undefined handling
  if (value === null || value === undefined) {
    return { valid: true, errors: [] };
  }

  // String validation
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(
        new ValidationError(
          `Expected string, got ${typeof value}`,
          fieldPath,
          value,
          "type"
        )
      );
    } else {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(
          new ValidationError(
            `String length ${value.length} is less than minimum ${schema.minLength}`,
            fieldPath,
            value,
            "minLength"
          )
        );
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(
          new ValidationError(
            `String length ${value.length} exceeds maximum ${schema.maxLength}`,
            fieldPath,
            value,
            "maxLength"
          )
        );
      }
      if (schema.pattern && !schema.pattern.test(value)) {
        errors.push(
          new ValidationError(
            `String does not match pattern ${schema.pattern}`,
            fieldPath,
            value,
            "pattern"
          )
        );
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(
          new ValidationError(
            `Value must be one of: ${schema.enum.join(", ")}`,
            fieldPath,
            value,
            "enum"
          )
        );
      }
    }
  }

  // Number validation
  if (schema.type === "number") {
    if (typeof value !== "number") {
      errors.push(
        new ValidationError(
          `Expected number, got ${typeof value}`,
          fieldPath,
          value,
          "type"
        )
      );
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(
          new ValidationError(
            `Value ${value} is less than minimum ${schema.minimum}`,
            fieldPath,
            value,
            "minimum"
          )
        );
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(
          new ValidationError(
            `Value ${value} exceeds maximum ${schema.maximum}`,
            fieldPath,
            value,
            "maximum"
          )
        );
      }
    }
  }

  // Object validation
  if (schema.type === "object" && schema.properties) {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(
        new ValidationError(
          `Expected object, got ${Array.isArray(value) ? "array" : typeof value}`,
          fieldPath,
          value,
          "type"
        )
      );
    } else {
      // Check required fields
      if (schema.required) {
        for (const requiredField of schema.required) {
          if (!(requiredField in value)) {
            errors.push(
              new ValidationError(
                `Required field missing`,
                `${fieldPath}.${requiredField}`,
                undefined,
                "required"
              )
            );
          }
        }
      }

      // Validate each property
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const result = validate(value[key], propSchema, `${fieldPath}.${key}`);
          errors.push(...result.errors);
        }
      }
    }
  }

  // Array validation
  if (schema.type === "array" && schema.items) {
    if (!Array.isArray(value)) {
      errors.push(
        new ValidationError(
          `Expected array, got ${typeof value}`,
          fieldPath,
          value,
          "type"
        )
      );
    } else {
      value.forEach((item, index) => {
        const result = validate(item, schema.items!, `${fieldPath}[${index}]`);
        errors.push(...result.errors);
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate tool parameters against tool definition
 */
export function validateToolParameters(
  toolName: string,
  parameters: any,
  toolDefinition: any
): ValidationResult {
  if (!toolDefinition.parameters) {
    return { valid: true, errors: [] };
  }

  const schema: Schema = {
    type: toolDefinition.parameters.type || "object",
    properties: toolDefinition.parameters.properties || {},
    required: toolDefinition.parameters.required || [],
  };

  const result = validate(parameters, schema, toolName);

  if (!result.valid) {
    console.warn(`Validation failed for tool "${toolName}":`, result.errors);
  }

  return result;
}

/**
 * Sanitize string input (remove null bytes, trim whitespace)
 */
export function sanitizeString(input: string): string {
  return input.replace(/\0/g, "").trim();
}

/**
 * Sanitize todo text specifically
 */
export function sanitizeTodoText(text: string): string {
  const sanitized = sanitizeString(text);

  // Limit length
  const maxLength = 500;
  if (sanitized.length > maxLength) {
    return sanitized.substring(0, maxLength);
  }

  return sanitized;
}

/**
 * Validate and sanitize todo item
 */
export function validateTodoItem(text: string): { valid: boolean; sanitized: string; error?: string } {
  if (!text || typeof text !== "string") {
    return { valid: false, sanitized: "", error: "Todo text must be a non-empty string" };
  }

  const sanitized = sanitizeTodoText(text);

  if (sanitized.length === 0) {
    return { valid: false, sanitized: "", error: "Todo text cannot be empty" };
  }

  if (sanitized.length < 1) {
    return { valid: false, sanitized, error: "Todo text must be at least 1 character" };
  }

  return { valid: true, sanitized };
}
