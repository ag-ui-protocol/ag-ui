/**
 * Example Express server using Claude Agent SDK
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { ClaudeAgent } from '@ag-ui/claude';
import type { RunAgentInput } from '@ag-ui/client';

// Load environment variables from .env.local or .env
// Try multiple locations in order of priority
dotenv.config({ path: resolve(__dirname, '../.env.local') }); // examples/.env.local (highest priority)
dotenv.config({ path: resolve(__dirname, '../../.env.local') }); // typescript/.env.local
dotenv.config({ path: resolve(__dirname, '../.env') }); // examples/.env
dotenv.config({ path: resolve(__dirname, '../../.env') }); // typescript/.env

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());

// Validate and log environment variables
console.log('=== Environment Variables ===');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET (' + process.env.ANTHROPIC_API_KEY.substring(0, 10) + '...)' : 'NOT SET');
console.log('ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'SET (' + process.env.ANTHROPIC_AUTH_TOKEN.substring(0, 10) + '...)' : 'NOT SET');
console.log('ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || 'NOT SET (will use default)');
console.log('PORT:', process.env.PORT || '8000 (default)');
console.log('PERMISSION_MODE:', process.env.PERMISSION_MODE || 'bypassPermissions (default)');
console.log('VERBOSE:', process.env.VERBOSE || 'false (default)');
console.log('=============================\n');

// SDK will automatically read ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
// Do NOT pass apiKey in config - let SDK handle it automatically
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ERROR: Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN found in environment variables.');
  console.error('SDK will not be able to authenticate. Please set one in .env.local or .env file.');
  process.exit(1);
}

// Initialize Claude Agent
// Do NOT pass apiKey or baseUrl - SDK reads from environment variables automatically
const agent = new ClaudeAgent({
  enablePersistentSessions: process.env.ENABLE_PERSISTENT_SESSIONS !== 'false',
  sessionTimeout: process.env.SESSION_TIMEOUT 
    ? parseInt(process.env.SESSION_TIMEOUT) 
    : 30 * 60 * 1000, // 30 minutes
  // Valid permission modes: 'default', 'acceptEdits', 'bypassPermissions', 'plan'
  permissionMode: (process.env.PERMISSION_MODE as any) || 'bypassPermissions',
  // Add stderr callback for debugging - CRITICAL for capturing CLI errors
  stderr: (data: string) => {
    // Log all stderr output from Claude CLI
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('[Claude CLI stderr]:', data);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Also log to file if needed for debugging
    if (process.env.LOG_TO_FILE === 'true') {
      const fs = require('fs');
      const timestamp = new Date().toISOString();
      fs.appendFileSync('/tmp/claude-cli-stderr.log', `[${timestamp}] ${data}\n`);
    }
  },
  // Enable verbose logging
  verbose: process.env.VERBOSE === 'true',
});

console.log('✓ Claude Agent initialized with stderr callback for error logging');

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Chat endpoint for CopilotKit compatibility
app.post('/chat', async (req: Request, res: Response) => {
  try {
    const input: RunAgentInput = req.body;

    // Validate input
    if (!input.messages || input.messages.length === 0) {
      return res.status(400).json({ error: 'Messages are required' });
    }

    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Run the agent and stream events
    agent.run(input).subscribe({
      next: (event: any) => {
        // Send event as SSE
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error: any) => {
        console.error('Agent error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      },
      complete: () => {
        res.end();
      },
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected');
    });
  } catch (error: any) {
    console.error('Request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main agent endpoint
app.post('/api/run-agent', async (req: Request, res: Response) => {
  try {
    const input: RunAgentInput = req.body;

    // Validate input
    if (!input.messages || input.messages.length === 0) {
      return res.status(400).json({ error: 'Messages are required' });
    }

    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Run the agent and stream events
    agent.run(input).subscribe({
      next: (event: any) => {
        // Send event as SSE
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error: any) => {
        console.error('Agent error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      },
      complete: () => {
        res.end();
      },
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected');
    });
  } catch (error: any) {
    console.error('Request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Example tools definition
const exampleTools = [
  {
    name: 'calculator',
    description: 'Performs basic arithmetic calculations',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
          description: 'The operation to perform',
        },
        a: {
          type: 'number',
          description: 'First number',
        },
        b: {
          type: 'number',
          description: 'Second number',
        },
      },
      required: ['operation', 'a', 'b'],
    },
    handler: async (args: { operation: string; a: number; b: number }) => {
      const { operation, a, b } = args;
      let result: number;

      switch (operation) {
        case 'add':
          result = a + b;
          break;
        case 'subtract':
          result = a - b;
          break;
        case 'multiply':
          result = a * b;
          break;
        case 'divide':
          if (b === 0) {
            throw new Error('Division by zero');
          }
          result = a / b;
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      return `The result of ${a} ${operation} ${b} is ${result}`;
    },
  },
  {
    name: 'get_weather',
    description: 'Gets the current weather for a location',
    client: true, // This tool runs on the client
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and country, e.g. "San Francisco, US"',
        },
      },
      required: ['location'],
    },
  },
];

// Example endpoint with tools
app.post('/api/run-agent-with-tools', async (req: Request, res: Response) => {
  try {
    const input: RunAgentInput = {
      ...req.body,
      context: {
        ...req.body.context,
        tools: exampleTools,
      },
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    agent.run(input).subscribe({
      next: (event: any) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error: any) => {
        console.error('Agent error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      },
      complete: () => {
        res.end();
      },
    });

    req.on('close', () => {
      console.log('Client disconnected');
    });
  } catch (error: any) {
    console.error('Request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cleanup endpoint
app.post('/api/cleanup', async (req: Request, res: Response) => {
  try {
    await agent.cleanup();
    res.json({ message: 'Cleanup successful' });
  } catch (error: any) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Claude Agent server listening on port ${port}`);
  console.log(`Chat endpoint: http://localhost:${port}/chat`);
  console.log(`API endpoint: http://localhost:${port}/api/run-agent`);
  console.log(`With tools: http://localhost:${port}/api/run-agent-with-tools`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await agent.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await agent.cleanup();
  process.exit(0);
});

