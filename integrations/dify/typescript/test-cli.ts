/**
 * CLI test for DifyAgent - run with: npx tsx test-cli.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, 'test/.env') });

const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_API_BASE_URL = process.env.DIFY_API_BASE_URL;

console.log('Environment variables:', {
  DIFY_API_KEY: DIFY_API_KEY ? `${DIFY_API_KEY.substring(0, 8)}...` : 'NOT SET',
  DIFY_API_BASE_URL: DIFY_API_BASE_URL || 'NOT SET',
});

if (!DIFY_API_KEY || !DIFY_API_BASE_URL) {
  console.error('Missing required environment variables');
  process.exit(1);
}

// First, let's test the DifyClient directly (not using the built package)
class DifyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.dify.ai/v1";
    console.log("DifyClient instance created:", {
      baseUrl: this.baseUrl,
      apiKeyLength: this.apiKey?.length || 0,
      hasApiKey: !!this.apiKey,
    });
  }

  async streamChat(
    params: { messages: any[]; tools?: any[] },
    onEvent: (event: any) => void,
    onError: (error: Error) => void,
    onComplete: () => void
  ): Promise<void> {
    const url = `${this.baseUrl}/chat-messages`;
    
    const lastUserMessage = [...params.messages].reverse().find((msg) => msg.role === 'user');
    const body = {
      inputs: {},
      query: lastUserMessage?.content || '',
      response_mode: "streaming",
      conversation_id: "",
      user: "ag-ui-user",
    };
    
    console.log("Dify API request:", { url, query: body.query });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Dify API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response reader");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          try {
            const data = JSON.parse(line.slice(6));
            onEvent(data);
          } catch (e) {
            console.error("Failed to parse:", line);
          }
        }
      }

      onComplete();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Test 1: Direct DifyClient test
async function testDifyClient() {
  console.log('\n=== Test 1: Direct DifyClient Test ===\n');
  
  const client = new DifyClient({
    apiKey: DIFY_API_KEY!,
    baseUrl: DIFY_API_BASE_URL!,
  });

  console.log('Client created, calling streamChat...');
  console.log('Client instance check:', {
    hasStreamChat: typeof client.streamChat === 'function',
    clientType: typeof client,
  });

  return new Promise<void>((resolve, reject) => {
    let fullResponse = '';
    
    client.streamChat(
      { messages: [{ role: 'user', content: 'Say hello in one word' }] },
      (event) => {
        if (event.event === 'message' && event.answer) {
          process.stdout.write(event.answer);
          fullResponse += event.answer;
        } else if (event.event === 'message_end') {
          console.log('\n[Message ended]');
        } else if (event.event === 'workflow_finished') {
          console.log('[Workflow finished]');
        }
      },
      (error) => {
        console.error('Error:', error.message);
        reject(error);
      },
      () => {
        console.log('\n[Stream complete]');
        console.log('Full response:', fullResponse);
        resolve();
      }
    );
  });
}

// Test 2: Test the built DifyAgent from dist
async function testBuiltDifyAgent() {
  console.log('\n=== Test 2: Built DifyAgent Test ===\n');
  
  try {
    // Import the built package
    const { DifyAgent } = await import('./dist/index.mjs');
    
    console.log('DifyAgent imported successfully');
    console.log('DifyAgent type:', typeof DifyAgent);
    
    const agent = new DifyAgent({
      apiKey: DIFY_API_KEY!,
      baseUrl: DIFY_API_BASE_URL!,
    });
    
    console.log('Agent created:', {
      agentType: typeof agent,
      hasRun: typeof agent.run === 'function',
      hasClient: !!(agent as any).client,
      clientType: typeof (agent as any).client,
    });

    // Check internal state
    const internalClient = (agent as any).client;
    console.log('Internal client check:', {
      exists: !!internalClient,
      hasStreamChat: internalClient ? typeof internalClient.streamChat === 'function' : 'N/A',
    });

    const observable = agent.run({
      threadId: 'test-thread',
      runId: 'test-run',
      messages: [{ id: '1', role: 'user', content: 'Say hello in one word' }],
      tools: [],
    });

    console.log('Observable created:', typeof observable);

    return new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (event: any) => {
          console.log('Event:', event.type, event.delta || event.messageId || '');
        },
        error: (err: Error) => {
          console.error('Observable error:', err.message);
          reject(err);
        },
        complete: () => {
          console.log('Observable complete');
          resolve();
        },
      });
    });
  } catch (error) {
    console.error('Failed to test built agent:', error);
    throw error;
  }
}

// Run tests
async function main() {
  try {
    await testDifyClient();
    await testBuiltDifyAgent();
    console.log('\n✅ All tests passed!\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
