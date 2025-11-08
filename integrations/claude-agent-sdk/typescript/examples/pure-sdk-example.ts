/**
 * Pure Claude Agent SDK Example
 * 
 * Directly calls @anthropic-ai/claude-agent-sdk without ag-ui
 * 
 * Environment variables (in .env.local):
 * - ANTHROPIC_AUTH_TOKEN: Claude API authentication token
 * - ANTHROPIC_BASE_URL: API base URL (optional)
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get current file directory in ESM mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local environment variables (try multiple paths)
const envPath1 = resolve(__dirname, '.env.local');
const envPath2 = resolve(process.cwd(), '.env.local');

console.log('Attempting to load environment variables:');
console.log('  Path 1:', envPath1);
console.log('  Path 2:', envPath2);
console.log('  Current directory:', process.cwd());
console.log('');

dotenv.config({ path: envPath1 });
dotenv.config({ path: envPath2 });

// Validate environment variables
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Error: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY not found');
  console.error('Please set ANTHROPIC_AUTH_TOKEN in .env.local file');
  console.error('');
  console.error('Current environment variables:');
  console.error('  ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN);
  console.error('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY);
  process.exit(1);
}

console.log('✅ Environment variables loaded');
console.log('   - ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'Set' : 'Not set');
console.log('   - ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || 'Using default');
console.log('');

async function main() {
  try {
    // Dynamically import Claude Agent SDK
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    console.log('🚀 Starting Claude Agent SDK call...\n');

    // SDK configuration options
    const options: any = {
      // SDK automatically reads ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
      // Also automatically reads ANTHROPIC_BASE_URL if set
      permissionMode: 'bypassPermissions' as const, // Allowed values: acceptEdits, bypassPermissions, default, plan
      verbose: true, // Enable verbose logging
      
      // Add stderr callback for debugging
      stderr: (data: string) => {
        console.error('[Claude CLI Debug]:', data);
      },
    };

    // If base URL is set, pass it explicitly (some third-party APIs may require this)
    if (process.env.ANTHROPIC_BASE_URL) {
      options.baseUrl = process.env.ANTHROPIC_BASE_URL;
      console.log('  Using custom Base URL:', options.baseUrl);
    }

    // If API Key is set, pass it explicitly
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log('  Using AUTH_TOKEN');
    } else if (process.env.ANTHROPIC_API_KEY) {
      options.apiKey = process.env.ANTHROPIC_API_KEY;
      console.log('  Using API_KEY');
    }

    options.env = process.env;

    console.log('');

    // Call SDK's query function
    const result = query({
      prompt: 'Hello! Please introduce yourself in one sentence.',
      options,
    });

    console.log('💬 AI Response:\n');

    // Iterate through response stream
    for await (const message of result) {
      // Handle different message types
      switch (message.type) {
        case 'assistant':
          // Assistant message - contains text content
          if (message.content) {
            for (const block of message.content) {
              if (block.type === 'text') {
                console.log(block.text);
              } else if (block.type === 'thinking') {
                console.log('🤔 [Thinking]:', block.thinking);
              }
            }
          }
          break;

        case 'partial_assistant':
          // Streaming assistant message (partial content)
          if (message.content) {
            for (const block of message.content) {
              if (block.type === 'text') {
                process.stdout.write(block.text);
              }
            }
          }
          break;

        case 'result':
          // Final result message
          if (message.subtype === 'success') {
            console.log('\n\n✅ Conversation completed');
          } else if (message.subtype === 'error') {
            console.error('\n\n❌ Error:', message.error);
          }
          break;

        case 'compact_boundary':
          // Compact boundary message (used to separate messages)
          console.log('\n--- Message Boundary ---');
          break;

        default:
          // Other message types
          console.log('\n[Message Type]:', message.type);
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
