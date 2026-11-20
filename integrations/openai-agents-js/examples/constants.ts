/**
 * Shared constants for the OpenAI Agents JS example agents.
 *
 * These configure the demos to run against a LiteLLM-compatible endpoint by
 * default (the target inference path for this integration), while still
 * allowing the standard OpenAI cloud when no `OPENAI_BASE_URL` is set.
 */

/**
 * Default model for the examples. Override per-adapter or via `OPENAI_MODEL`.
 *
 * LiteLLM proxies usually route by a model prefix (e.g. `openai/gpt-4o`); set
 * `OPENAI_MODEL` to whatever your proxy expects.
 */
export const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

/**
 * Shared base config every example agent uses: model + (optionally) a
 * LiteLLM-compatible endpoint. `baseURL` and `apiKey` fall back to env vars,
 * so examples run unchanged once `OPENAI_API_KEY` / `OPENAI_BASE_URL` are set.
 */
export const baseConfig = {
  model: DEFAULT_MODEL,
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
  ...(process.env.OPENAI_API_KEY
    ? { apiKey: process.env.OPENAI_API_KEY }
    : {}),
} as const;
