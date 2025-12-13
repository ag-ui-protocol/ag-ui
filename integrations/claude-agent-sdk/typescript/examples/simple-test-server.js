/**
 * Simplified test server - for quick testing of Claude Agent SDK TypeScript integration
 * Does not depend on complex workspace dependencies
 */

const http = require('http');
const { ClaudeAgent } = require('../dist/index.js');

// Get configuration from environment variables
require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env' });

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('❌ Error: ANTHROPIC_API_KEY environment variable not set');
  console.error('Please set ANTHROPIC_API_KEY in .env.local or .env file');
  process.exit(1);
}

// Initialize Claude Agent
const agent = new ClaudeAgent({
  apiKey: API_KEY,
  enablePersistentSessions: true,
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
  permissionMode: 'ask',
  claudeOptions: {
    systemPrompt: process.env.SYSTEM_PROMPT || 'You are a helpful assistant',
    appName: process.env.APP_NAME || 'simple-test-server',
  },
});

console.log('✓ Claude Agent initialized successfully');

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Chat endpoint
  if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        
        console.log('📨 Received request:', {
          agentId: input.agentId,
          threadId: input.threadId,
          messageCount: input.messages?.length || 0
        });

        // Set SSE response headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // Run agent and stream results
        const subscription = agent.run(input).subscribe({
          next: (event) => {
            // Send SSE event
            const eventData = JSON.stringify(event);
            res.write(`data: ${eventData}\n\n`);
            
            // Logging
            if (event.type === 'text_message_content') {
              process.stdout.write(event.text || '');
            } else if (event.type === 'run_started') {
              console.log('\n🚀 Execution started, runId:', event.runId);
            } else if (event.type === 'run_finished') {
              console.log('\n✓ Execution completed');
            }
          },
          error: (error) => {
            console.error('\n❌ Error:', error.message);
            const errorEvent = JSON.stringify({ 
              type: 'error', 
              error: error.message 
            });
            res.write(`data: ${errorEvent}\n\n`);
            res.end();
          },
          complete: () => {
            res.end();
          },
        });

        // Handle client disconnect
        req.on('close', () => {
          subscription.unsubscribe();
          console.log('🔌 Client disconnected');
        });

      } catch (error) {
        console.error('❌ Request processing error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// Start server
server.listen(PORT, () => {
  console.log('\n🎉 Simplified test server started!');
  console.log(`📍 Address: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/api/chat`);
  console.log('\nPress Ctrl+C to stop the server\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down server...');
  await agent.cleanup();
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n\n👋 Shutting down server...');
  await agent.cleanup();
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});
