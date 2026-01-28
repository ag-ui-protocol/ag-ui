/**
 * Direct Anthropic API Example
 * 
 * Does not use Agent SDK, directly uses @anthropic-ai/sdk
 * This method is compatible with third-party API proxies (e.g., Zhipu)
 * 
 * Environment variables (in .env.local):
 * - ANTHROPIC_AUTH_TOKEN: Claude API authentication token
 * - ANTHROPIC_BASE_URL: API base URL (optional)
 */

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

// Get current file directory in ESM mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local environment variables
const envPath1 = resolve(__dirname, '.env.local');
const envPath2 = resolve(process.cwd(), '.env.local');

dotenv.config({ path: envPath1 });
dotenv.config({ path: envPath2 });

// Validate environment variables
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Error: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY not found');
  process.exit(1);
}

console.log('✅ Environment variables loaded');
console.log('   - ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'Set' : 'Not set');
console.log('   - ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || 'Using default');
console.log('');

async function main() {
  try {
    // Initialize Anthropic client
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });

    console.log('🚀 Starting Claude API call...\n');
    console.log('💬 AI Response:\n');

    // Call API (streaming response)
    const stream = await client.messages.stream({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'Hello! Please introduce yourself in one sentence.',
        },
      ],
    });

    // Listen to streaming events
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          process.stdout.write(event.delta.text);
        }
      }
    }

    console.log('\n\n✅ Conversation completed');
    console.log('🎉 Done!\n');

  } catch (error: any) {
    console.error('\n❌ Error occurred:', error.message);
    if (error.status) {
      console.error('HTTP Status Code:', error.status);
    }
    if (error.error) {
      console.error('Error details:', JSON.stringify(error.error, null, 2));
    }
    process.exit(1);
  }
}

// Run main function
main();
