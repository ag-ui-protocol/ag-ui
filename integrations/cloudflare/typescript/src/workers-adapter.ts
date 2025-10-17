/**
 * Cloudflare Workers Runtime Adapter
 *
 * Adapts AG-UI to work natively with Cloudflare Workers fetch API
 * instead of Node.js Request/Response objects.
 */

import { CloudflareAGUIAdapter, CloudflareAGUIAdapterOptions } from "./adapter";
import {
  normalizeRequest,
  createResponseHeaders,
  isWebSocketUpgrade,
  validateWebSocketUpgrade,
} from "./cloudflare-utils";
import type { AGUIEvent } from "./events";

export interface WorkersAdapterOptions extends CloudflareAGUIAdapterOptions {
  /** Enable CORS for cross-origin requests */
  cors?: boolean;
  /** Custom CORS origin (default: *) */
  corsOrigin?: string;
  /** Handle WebSocket upgrades (requires Durable Objects) */
  websocket?: {
    /** Durable Object namespace for WebSocket handling */
    durableObject?: DurableObjectNamespace;
    /** Path to handle WebSocket connections */
    path?: string;
  };
}

/**
 * Cloudflare Workers Environment bindings
 */
export interface WorkersEnv {
  /** Cloudflare Account ID */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Cloudflare API Token */
  CLOUDFLARE_API_TOKEN?: string;
  /** AI Gateway ID */
  AI_GATEWAY_ID?: string;
  /** Durable Object binding for WebSockets */
  WEBSOCKET_DO?: DurableObjectNamespace;
  /** KV namespace for session storage */
  SESSIONS_KV?: KVNamespace;
}

/**
 * Main entry point for Cloudflare Workers
 *
 * @example
 * ```typescript
 * export default {
 *   async fetch(request, env, ctx) {
 *     return handleCloudflareWorker(request, env, {
 *       model: '@cf/meta/llama-3.1-8b-instruct'
 *     });
 *   }
 * };
 * ```
 */
export async function handleCloudflareWorker(
  request: Request,
  env: WorkersEnv,
  options?: Partial<WorkersAdapterOptions>,
): Promise<Response> {
  // Normalize request with Cloudflare headers
  const normalized = normalizeRequest(request);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: createResponseHeaders({
        cors: options?.cors ?? true,
        corsOrigin: options?.corsOrigin,
      }),
    });
  }

  // Handle WebSocket upgrade
  if (isWebSocketUpgrade(normalized.headers)) {
    const validationError = validateWebSocketUpgrade(normalized.headers);
    if (validationError) {
      return new Response(validationError, { status: 400 });
    }

    if (options?.websocket?.durableObject) {
      return handleWebSocketUpgrade(request, options.websocket.durableObject);
    }

    return new Response("WebSocket support not configured", { status: 501 });
  }

  // Handle regular AG-UI requests
  if (request.method === "POST") {
    return handleAGUIRequest(request, env, options);
  }

  return new Response("Method not allowed", { status: 405 });
}

/**
 * Handle standard AG-UI chat completion requests
 */
async function handleAGUIRequest(
  request: Request,
  env: WorkersEnv,
  options?: Partial<WorkersAdapterOptions>,
): Promise<Response> {
  try {
    // Parse request body
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: string }>;
      model?: string;
      tools?: any[];
    };

    // Create adapter with environment variables
    const adapter = new CloudflareAGUIAdapter({
      accountId: env.CLOUDFLARE_ACCOUNT_ID!,
      apiToken: env.CLOUDFLARE_API_TOKEN!,
      model: (options?.model || body.model || "@cf/meta/llama-3.1-8b-instruct") as any,
      gatewayId: env.AI_GATEWAY_ID,
      tools: options?.tools || body.tools,
      ...options,
    });

    // Create response headers for SSE
    const headers = createResponseHeaders({
      cors: options?.cors ?? true,
      corsOrigin: options?.corsOrigin,
    });

    // Stream AG-UI events as Server-Sent Events
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Start streaming in background
    (async () => {
      try {
        for await (const event of adapter.execute(body.messages as any)) {
          await writer.write(encoder.encode(formatSSE(event)));
        }
      } catch (error) {
        console.error("Error streaming AG-UI events:", error);
        await writer.write(
          encoder.encode(
            formatSSE({
              type: "RUN_ERROR",
              runId: "error",
              data: {
                error: error instanceof Error ? error.message : "Unknown error",
              },
            } as AGUIEvent),
          ),
        );
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error handling AG-UI request:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle WebSocket upgrade with Durable Objects
 */
async function handleWebSocketUpgrade(
  request: Request,
  durableObject: DurableObjectNamespace,
): Promise<Response> {
  // Get or create Durable Object for this connection
  const id = durableObject.idFromName("websocket-session");
  const stub = durableObject.get(id);

  // Forward upgrade request to Durable Object
  return stub.fetch(request);
}

/**
 * Format AG-UI event as Server-Sent Event
 */
function formatSSE(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Create a Cloudflare Worker handler with AG-UI support
 *
 * @example
 * ```typescript
 * export default createCloudflareWorkerHandler({
 *   model: '@cf/meta/llama-3.1-8b-instruct',
 *   cors: true,
 * });
 * ```
 */
export function createCloudflareWorkerHandler(options?: Partial<WorkersAdapterOptions>): {
  fetch: (request: Request, env: WorkersEnv, ctx: ExecutionContext) => Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      return handleCloudflareWorker(request, env, options);
    },
  };
}

/**
 * Durable Object for WebSocket handling
 *
 * @example
 * ```typescript
 * export class WebSocketDO {
 *   constructor(state: DurableObjectState, env: WorkersEnv) {
 *     // Initialize
 *   }
 *
 *   async fetch(request: Request) {
 *     return handleWebSocketConnection(request, this.state, this.env);
 *   }
 * }
 * ```
 */
export async function handleWebSocketConnection(
  request: Request,
  state: DurableObjectState,
  env: WorkersEnv,
  options?: Partial<WorkersAdapterOptions>,
): Promise<Response> {
  // Create WebSocket pair
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  // Accept the connection
  (server as any).accept();

  // Handle messages
  server.addEventListener("message", async (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data as string);

      // Create adapter
      const adapter = new CloudflareAGUIAdapter({
        accountId: env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: env.CLOUDFLARE_API_TOKEN!,
        model: options?.model || "@cf/meta/llama-3.1-8b-instruct",
        gatewayId: env.AI_GATEWAY_ID,
        ...options,
      });

      // Stream events back over WebSocket
      for await (const aguiEvent of adapter.execute(message.messages || [])) {
        server.send(JSON.stringify(aguiEvent));
      }
    } catch (error) {
      server.send(
        JSON.stringify({
          type: "RUN_ERROR",
          data: { error: error instanceof Error ? error.message : "Unknown error" },
        }),
      );
    }
  });

  server.addEventListener("close", () => {
    // Cleanup
  });

  return new Response(null, {
    status: 101,
    webSocket: client as any,
  } as any);
}
