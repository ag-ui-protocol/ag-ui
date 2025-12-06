/**
 * Tool adapter: Converts AG-UI tools to Claude SDK format
 */

import { z } from 'zod';
import type { Tool } from '@ag-ui/client';
import type {
  SdkMcpToolDefinition,
  McpSdkServerConfigWithInstance,
  CallToolResult,
} from './types';

// Extended Tool type that includes runtime properties
type ExtendedTool = Tool & {
  client?: boolean;
  handler?: (args: any) => any | Promise<any>;
  longRunning?: boolean;
};

/**
 * ToolAdapter handles conversion of AG-UI tools to Claude SDK format
 */
export class ToolAdapter {
  /**
   * Convert AG-UI tools to Claude SDK MCP tool definitions
   */
  static convertAgUiToolsToSdk(tools: Tool[]): SdkMcpToolDefinition<any>[] {
    return tools.map((tool) => this.convertSingleTool(tool as ExtendedTool));
  }

  /**
   * Convert a single AG-UI tool to Claude SDK format
   */
  private static convertSingleTool(tool: ExtendedTool): SdkMcpToolDefinition<any> {
    const zodSchema = this.convertJsonSchemaToZod(tool.parameters || {});

    return {
      name: tool.name,
      description: tool.description || '',
      inputSchema: zodSchema,
      handler: async (args: any) => {
        // For client tools, we mark them as long-running
        // The actual execution will be handled by the client
        if (tool.client) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  toolName: tool.name,
                  args,
                  isClientTool: true,
                  isLongRunning: true,
                }),
              },
            ],
          };
        }

        // For backend tools, if there's a handler, execute it
        if (tool.handler) {
          try {
            const result = await tool.handler(args);
            return {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result),
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: 'text',
                  text: error.message || 'Tool execution failed',
                },
              ],
              isError: true,
            };
          }
        }

        // Default response for tools without handlers
        return {
          content: [
            {
              type: 'text',
              text: 'Tool executed (no handler)',
            },
          ],
        };
      },
    };
  }

  /**
   * Convert JSON Schema to Zod schema
   */
  private static convertJsonSchemaToZod(jsonSchema: any): z.ZodTypeAny {
    if (!jsonSchema || typeof jsonSchema !== 'object') {
      return z.object({});
    }

    const properties = jsonSchema.properties || {};
    const required = jsonSchema.required || [];

    const zodShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(properties)) {
      const propSchema = prop as any;
      let zodType = this.convertJsonSchemaTypeToZod(propSchema);

      // Make optional if not in required array
      if (!required.includes(key)) {
        zodType = zodType.optional();
      }

      zodShape[key] = zodType;
    }

    return z.object(zodShape);
  }

  /**
   * Convert a single JSON Schema type to Zod type
   */
  private static convertJsonSchemaTypeToZod(schema: any): z.ZodTypeAny {
    const type = schema.type;

    switch (type) {
      case 'string':
        if (schema.enum) {
          return z.enum(schema.enum as [string, ...string[]]);
        }
        return z.string();

      case 'number':
      case 'integer':
        let numType = type === 'integer' ? z.number().int() : z.number();
        if (schema.minimum !== undefined) {
          numType = numType.min(schema.minimum);
        }
        if (schema.maximum !== undefined) {
          numType = numType.max(schema.maximum);
        }
        return numType;

      case 'boolean':
        return z.boolean();

      case 'array':
        if (schema.items) {
          const itemType = this.convertJsonSchemaTypeToZod(schema.items);
          return z.array(itemType);
        }
        return z.array(z.any());

      case 'object':
        if (schema.properties) {
          return this.convertJsonSchemaToZod(schema);
        }
        return z.record(z.any());

      case 'null':
        return z.null();

      default:
        // For any other type or if type is not specified
        return z.any();
    }
  }

  /**
   * Create an MCP server configuration for AG-UI tools
   */
  static async createMcpServerForTools(tools: Tool[]): Promise<any> {
    const sdkTools = this.convertAgUiToolsToSdk(tools as ExtendedTool[]);

    // Import createSdkMcpServer from Claude Agent SDK
    const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    
    // Use the official SDK function to create a properly formatted MCP server
    return createSdkMcpServer({
      name: 'ag_ui_tools',
      version: '1.0.0',
      tools: sdkTools as any, // Cast to any to avoid type incompatibility
    });
  }

  /**
   * Extract tool calls from Claude SDK response
   */
  static extractToolCalls(message: any): Array<{
    id: string;
    name: string;
    input: Record<string, any>;
  }> {
    if (!message.content || !Array.isArray(message.content)) {
      return [];
    }

    return message.content
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));
  }

  /**
   * Check if a tool is a long-running client tool
   */
  static isClientTool(toolName: string, tools: Tool[]): boolean {
    const tool = tools.find((t) => t.name === toolName) as ExtendedTool | undefined;
    return tool?.client === true;
  }

  /**
   * Check if a tool is marked as long-running
   */
  static isLongRunningTool(toolName: string, tools: Tool[]): boolean {
    const tool = tools.find((t) => t.name === toolName) as ExtendedTool | undefined;
    return tool?.client === true || tool?.longRunning === true;
  }

  /**
   * Format tool names for Claude SDK (with MCP server prefix)
   */
  static formatToolNameForSdk(toolName: string, serverName: string = 'ag_ui_tools'): string {
    return `mcp__${serverName}__${toolName}`;
  }

  /**
   * Parse tool name from SDK format (remove MCP server prefix)
   */
  static parseToolNameFromSdk(sdkToolName: string): string {
    const parts = sdkToolName.split('__');
    if (parts.length >= 3 && parts[0] === 'mcp') {
      return parts.slice(2).join('__');
    }
    return sdkToolName;
  }

  /**
   * Get allowed tools list for SDK options
   */
  static getAllowedToolsList(tools: Tool[], serverName: string = 'ag_ui_tools'): string[] {
    return tools.map((tool) => this.formatToolNameForSdk(tool.name, serverName));
  }
}

