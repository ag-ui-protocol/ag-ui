import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * JSON Schema type definition
 */
interface JsonSchema {
  type: "object" | "string" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

/**
 * AG-UI Tool definition
 */
interface AGUITool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * Converts JSON Schema to Zod schema
 */
function convertJsonSchemaToZod(jsonSchema: JsonSchema, required: boolean): z.ZodSchema {
  if (jsonSchema.type === "object") {
    const spec: { [key: string]: z.ZodSchema } = {};

    if (!jsonSchema.properties || !Object.keys(jsonSchema.properties).length) {
      return !required ? z.object(spec).optional() : z.object(spec);
    }

    for (const [key, value] of Object.entries(jsonSchema.properties)) {
      spec[key] = convertJsonSchemaToZod(
        value,
        jsonSchema.required ? jsonSchema.required.includes(key) : false
      );
    }
    let schema = z.object(spec).describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "string") {
    let schema = z.string().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "number") {
    let schema = z.number().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "boolean") {
    let schema = z.boolean().describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "array") {
    if (!jsonSchema.items) {
      throw new Error("Array type must have items property");
    }
    let itemSchema = convertJsonSchemaToZod(jsonSchema.items, true);
    let schema = z.array(itemSchema).describe(jsonSchema.description ?? "");
    return required ? schema : schema.optional();
  }
  throw new Error("Invalid JSON schema");
}

export type LangChainToolWithName = {
  type: "function";
  name?: string;
  function: {
    name: string;
    description: string;
    parameters: any;
  },
}

/**
 * Converts AG-UI Tool to LangChain DynamicStructuredTool
 */
export function convertAGUIToolToLangChain(tool: AGUITool): DynamicStructuredTool {
  const schema = convertJsonSchemaToZod(tool.parameters, true) as z.ZodTypeAny;

  // Use explicit type annotation to avoid TS2589 "Type instantiation is excessively deep"
  // caused by DynamicStructuredTool's complex generic inference
  const toolInstance: DynamicStructuredTool = new (DynamicStructuredTool as any)({
    name: tool.name,
    description: tool.description,
    schema: schema,
    func: async () => {
      return "";
    },
  });
  return toolInstance;
}

/**
 * Converts array of AG-UI Tools to LangChain DynamicStructuredTools
 */
export function convertAGUIToolsToLangChain(tools: AGUITool[]): DynamicStructuredTool[] {
  return tools.map(convertAGUIToolToLangChain);
}
