/**
 * Configuration constants for the OpenAI Agents JS adapter.
 */

/** Special tool name for state management (mirrors claude-agent-sdk pattern). */
export const STATE_MANAGEMENT_TOOL_NAME = "ag_ui_update_state";

/**
 * Default model family. The OpenAI Agents JS SDK defaults to the Responses API;
 * when pointing at a LiteLLM proxy (which is OpenAI-compatible but does not
 * support the Responses API), the adapter switches to Chat Completions mode.
 */
export const DEFAULT_MODEL = "gpt-5";

/** Environment variable names the adapter reads. */
export const ENV = {
  API_KEY: "OPENAI_API_KEY",
  BASE_URL: "OPENAI_BASE_URL",
  MODEL: "OPENAI_MODEL",
} as const;
