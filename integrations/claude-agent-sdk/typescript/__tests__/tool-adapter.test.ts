/**
 * Tool adapter tests
 */

import { z } from 'zod';
import { ToolAdapter } from '../src/tool-adapter';
import type { Tool } from '@ag-ui/client';

describe('ToolAdapter', () => {
  describe('convertAgUiToolsToSdk', () => {
    it('should convert AG-UI tools to SDK format', () => {
      const tools: Tool[] = [
        {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              count: { type: 'number' },
            },
            required: ['query'],
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);

      expect(sdkTools).toHaveLength(1);
      expect(sdkTools[0].name).toBe('test_tool');
      expect(sdkTools[0].description).toBe('A test tool');
      expect(sdkTools[0].inputSchema).toBeDefined();
      expect(sdkTools[0].handler).toBeDefined();
    });

    it('should handle tools without parameters', () => {
      const tools: Tool[] = [
        {
          name: 'simple_tool',
          description: 'A simple tool',
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);

      expect(sdkTools).toHaveLength(1);
      expect(sdkTools[0].name).toBe('simple_tool');
    });
  });

  describe('convertJsonSchemaToZod', () => {
    it('should convert string type', () => {
      const tools: Tool[] = [
        {
          name: 'string_tool',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);
      expect(sdkTools[0].inputSchema).toBeDefined();
    });

    it('should convert number type', () => {
      const tools: Tool[] = [
        {
          name: 'number_tool',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              count: { type: 'number', minimum: 0, maximum: 100 },
            },
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);
      expect(sdkTools[0].inputSchema).toBeDefined();
    });

    it('should convert boolean type', () => {
      const tools: Tool[] = [
        {
          name: 'boolean_tool',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);
      expect(sdkTools[0].inputSchema).toBeDefined();
    });

    it('should convert array type', () => {
      const tools: Tool[] = [
        {
          name: 'array_tool',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);
      expect(sdkTools[0].inputSchema).toBeDefined();
    });

    it('should handle required fields', () => {
      const tools: Tool[] = [
        {
          name: 'required_tool',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              required_field: { type: 'string' },
              optional_field: { type: 'string' },
            },
            required: ['required_field'],
          },
        },
      ];

      const sdkTools = ToolAdapter.convertAgUiToolsToSdk(tools);
      expect(sdkTools[0].inputSchema).toBeDefined();
    });
  });

  describe('createMcpServerForTools', () => {
    it('should create MCP server configuration', () => {
      const tools: Tool[] = [
        {
          name: 'tool1',
          description: 'Tool 1',
        },
        {
          name: 'tool2',
          description: 'Tool 2',
        },
      ];

      const mcpServer = ToolAdapter.createMcpServerForTools(tools);

      expect(mcpServer.name).toBe('ag_ui_tools');
      expect(mcpServer.version).toBe('1.0.0');
      expect(mcpServer.tools).toHaveLength(2);
    });
  });

  describe('extractToolCalls', () => {
    it('should extract tool calls from message', () => {
      const message = {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tool_1', name: 'search', input: { query: 'test' } },
        ],
      };

      const toolCalls = ToolAdapter.extractToolCalls(message);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe('tool_1');
      expect(toolCalls[0].name).toBe('search');
      expect(toolCalls[0].input).toEqual({ query: 'test' });
    });

    it('should return empty array for non-tool messages', () => {
      const message = {
        content: [{ type: 'text', text: 'Hello' }],
      };

      const toolCalls = ToolAdapter.extractToolCalls(message);

      expect(toolCalls).toHaveLength(0);
    });
  });

  describe('isClientTool', () => {
    it('should identify client tools', () => {
      const tools: Tool[] = [
        { name: 'client_tool', description: 'Test', client: true },
        { name: 'backend_tool', description: 'Test', client: false },
      ];

      expect(ToolAdapter.isClientTool('client_tool', tools)).toBe(true);
      expect(ToolAdapter.isClientTool('backend_tool', tools)).toBe(false);
      expect(ToolAdapter.isClientTool('unknown_tool', tools)).toBe(false);
    });
  });

  describe('isLongRunningTool', () => {
    it('should identify long-running tools', () => {
      const tools: Tool[] = [
        { name: 'client_tool', description: 'Test', client: true },
        { name: 'long_tool', description: 'Test', longRunning: true },
        { name: 'normal_tool', description: 'Test' },
      ];

      expect(ToolAdapter.isLongRunningTool('client_tool', tools)).toBe(true);
      expect(ToolAdapter.isLongRunningTool('long_tool', tools)).toBe(true);
      expect(ToolAdapter.isLongRunningTool('normal_tool', tools)).toBe(false);
    });
  });

  describe('formatToolNameForSdk', () => {
    it('should format tool name with MCP prefix', () => {
      expect(ToolAdapter.formatToolNameForSdk('my_tool')).toBe('mcp__ag_ui_tools__my_tool');
      expect(ToolAdapter.formatToolNameForSdk('my_tool', 'custom_server')).toBe(
        'mcp__custom_server__my_tool'
      );
    });
  });

  describe('parseToolNameFromSdk', () => {
    it('should parse tool name from SDK format', () => {
      expect(ToolAdapter.parseToolNameFromSdk('mcp__ag_ui_tools__my_tool')).toBe('my_tool');
      expect(ToolAdapter.parseToolNameFromSdk('mcp__custom__nested__tool')).toBe('nested__tool');
      expect(ToolAdapter.parseToolNameFromSdk('plain_tool')).toBe('plain_tool');
    });
  });

  describe('getAllowedToolsList', () => {
    it('should generate allowed tools list', () => {
      const tools: Tool[] = [
        { name: 'tool1', description: 'Tool 1' },
        { name: 'tool2', description: 'Tool 2' },
      ];

      const allowedTools = ToolAdapter.getAllowedToolsList(tools);

      expect(allowedTools).toHaveLength(2);
      expect(allowedTools).toContain('mcp__ag_ui_tools__tool1');
      expect(allowedTools).toContain('mcp__ag_ui_tools__tool2');
    });
  });
});

