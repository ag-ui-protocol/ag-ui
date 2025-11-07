/**
 * Example Express server using Claude Agent SDK
 */

import express from 'express';
import cors from 'cors';
import { ClaudeAgent } from '@ag-ui/claude';
import type { RunAgentInput } from '@ag-ui/client';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Claude Agent
const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  enablePersistentSessions: true,
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
  permissionMode: 'ask', // or 'auto' or 'none'
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main agent endpoint
app.post('/api/run-agent', async (req, res) => {
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
      next: (event) => {
        // Send event as SSE
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error) => {
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
app.post('/api/run-agent-with-tools', async (req, res) => {
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
      next: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error) => {
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
app.post('/api/cleanup', async (req, res) => {
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

