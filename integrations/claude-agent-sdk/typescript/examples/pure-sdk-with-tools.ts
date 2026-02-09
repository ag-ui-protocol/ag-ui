/**
 * Pure Claude Agent SDK Example - With Tools
 * 
 * Demonstrates how to use tool() and createSdkMcpServer() to define and use tools
 * Reference: https://docs.claude.com/docs/agent-sdk/typescript#tool
 * 
 * Environment variables (in .env.local):
 * - ANTHROPIC_AUTH_TOKEN: Claude API authentication token
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

// Get current file directory in ESM mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local environment variables (try multiple paths)
dotenv.config({ path: resolve(__dirname, '.env.local') });
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

// Validate environment variables
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Error: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY not found');
  process.exit(1);
}

console.log('✅ Environment variables loaded\n');

async function main() {
  try {
    // Dynamically import Claude Agent SDK
    const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    
    console.log('🚀 Starting Claude Agent SDK call (with tools)...\n');

    // Create addition tool using tool()
    const addTool = tool(
      'add',
      'Adds two numbers',
      {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
      async (args) => {
        const result = args.a + args.b;
        console.log(`\n🔧 [Tool Execution] add(${args.a}, ${args.b}) = ${result}`);
        return {
          content: [
            {
              type: 'text',
              text: `Calculation result: ${args.a} + ${args.b} = ${result}`,
            },
          ],
        };
      }
    );

    // Create multiplication tool using tool()
    const multiplyTool = tool(
      'multiply',
      'Multiplies two numbers',
      {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
      async (args) => {
        const result = args.a * args.b;
        console.log(`\n🔧 [Tool Execution] multiply(${args.a}, ${args.b}) = ${result}`);
        return {
          content: [
            {
              type: 'text',
              text: `Calculation result: ${args.a} × ${args.b} = ${result}`,
            },
          ],
        };
      }
    );

    // Create MCP server using createSdkMcpServer()
    const calculatorServer = createSdkMcpServer({
      name: 'calculator',
      version: '1.0.0',
      tools: [addTool, multiplyTool],
    });

    // SDK configuration options
    const options: any = {
      permissionMode: 'bypassPermissions' as const,
      mcpServers: {
        calculator: calculatorServer, // Use the created MCP server
      },
      verbose: true,
      
      // Add stderr callback for debugging
      stderr: (data: string) => {
        console.error('[Claude CLI Debug]:', data);
      },
    };

    // Call SDK
    const result = query({
      prompt: 'Please help me calculate: (15 + 27) × 2',
      options,
    });

    console.log('💬 AI Response:\n');

    // Iterate through response stream
    for await (const message of result) {
      switch (message.type) {
        case 'assistant':
          // SDKAssistantMessage contains message.message.content
          if (message.message?.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                console.log(block.text);
              } else if (block.type === 'tool_use') {
                console.log(`\n🔧 [Tool Call] ${block.name}`, block.input);
              }
            }
          }
          break;

        case 'stream_event':
          // Streaming events
          if (message.event?.type === 'content_block_delta') {
            const delta = (message.event as any).delta;
            if (delta?.type === 'text_delta') {
              process.stdout.write(delta.text);
            }
          }
          break;

        case 'result':
          if (message.subtype === 'success') {
            console.log('\n\n✅ Conversation completed');
          } else {
            // error_during_execution | error_max_turns | error_max_budget_usd
            console.error('\n\n❌ Error:', message.subtype);
            if ('errors' in message && message.errors) {
              console.error('Detailed errors:', message.errors);
            }
          }
          break;
      }
    }

    console.log('\n🎉 Done!\n');

  } catch (error: any) {
    console.error('\n❌ Error occurred:', error.message);
    if (error.stack) {
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run main function
main();
