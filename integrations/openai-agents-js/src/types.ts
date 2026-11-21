/**
 * Type definitions for the AG-UI OpenAI Agents JS integration.
 *
 * Only types specific to this adapter are defined here. SDK types are imported
 * directly from `@openai/agents`.
 */

import type { AgentConfig } from "@ag-ui/client";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  MessagesSnapshotEvent,
  CustomEvent,
} from "@ag-ui/core";

import type { RunStateStore } from "./state";

/**
 * Configuration for `OpenAIAgentsAdapter`.
 *
 * The adapter is a thin protocol translator — it does not own the OpenAI API
 * client lifecycle. Configure the endpoint via `apiKey`/`baseURL` (or pass a
 * preconfigured `openAIClient`), and the adapter will wire an
 * OpenAI-compatible client at that base URL.
 *
 * `baseURL` and `openAIClient` are mutually exclusive (SDK constraint).
 *
 * @example
 * ```typescript
 * const adapter = new OpenAIAgentsAdapter({
 *   model: "gpt-5",
 *   apiKey: process.env.OPENAI_API_KEY,
 *   baseURL: process.env.OPENAI_BASE_URL, // LiteLLM proxy
 * });
 * ```
 */
export type OpenAIAgentsAdapterConfig = AgentConfig & {
  /** Model name. Defaults to `gpt-5`. */
  model?: string;

  /** OpenAI API key. Falls back to `OPENAI_API_KEY` env var. */
  apiKey?: string;

  /**
   * Custom base URL for an OpenAI-compatible endpoint (e.g. a LiteLLM proxy).
   * When set, the adapter uses Chat Completions mode and disables tracing,
   * since most OpenAI-compatible proxies do not support the Responses API.
   * Cannot be combined with `openAIClient`.
   */
  baseURL?: string;

  /**
   * Preconfigured OpenAI client instance. Cannot be combined with `apiKey`
   * or `baseURL`.
   */
  openAIClient?: unknown;

  /** System prompt / instructions for the agent. */
  instructions?: string;

  /**
   * SDK-native backend tools (e.g. built with `@openai/agents`'s `tool()`) the
   * agent may call and that execute server-side. These are distinct from AG-UI
   * *frontend* tools (provided per-run via `RunAgentInput.tools`, which halt
   * for client-side execution). Backend tools are merged into the agent
   * alongside any frontend tools + the injected state tool.
   */
  tools?: unknown[];

  /** Set false for frontend tools that execute without an explicit resume (e.g. followUp: false). */
  interruptOnFrontendToolCall?: boolean;

  /** Max concurrent idle RunState entries kept for pause/resume. Default: 1000. */
  maxStates?: number;

  /** TTL in ms for idle RunState entries. Default: 30 minutes. */
  stateTtlMs?: number;

  /**
   * Custom RunState persistence for the shared `currentState` across a HITL
   * pause/resume. Defaults to an in-memory store (TTL + LRU). Implement the
   * `RunStateStore` interface over DynamoDB / S3 / Redis / etc. and inject it
   * here to durable-persist paused-run state across processes.
   */
  runStateStore?: RunStateStore;
};

/**
 * Union of all AG-UI event types this adapter can emit.
 */
export type ProcessedEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent;
