/**
 * Configuration for Dify client
 */
export interface DifyClientConfig {
  /** Dify API key */
  apiKey: string;
  /** Base URL for Dify API (defaults to https://api.dify.ai/v1) */
  baseUrl?: string;
}

/**
 * Response from Dify streaming API
 */
export interface DifyStreamResponse {
  /** Event type (e.g., "message", "message_end") */
  event: string;
  /** Conversation ID */
  conversation_id?: string;
  /** Message ID */
  message_id?: string;
  /** Answer content from the agent */
  answer?: string;
  /** Additional data */
  data?: unknown;
  /** Metadata */
  metadata?: unknown;
}

/**
 * Dify message format
 */
export interface DifyMessage {
  /** Message role (e.g., "user", "assistant") */
  role: string;
  /** Message content */
  content: string;
}
