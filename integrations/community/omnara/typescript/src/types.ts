import type { AgentConfig } from "@ag-ui/client";

/**
 * The end user a request acts for. Set it on the server from your own auth,
 * never from the request body: it picks the user's Omnara agent for a thread,
 * and becomes the Omnara actor on every message, answer and cancel.
 */
export interface OmnaraUser {
  id: string;
  /** Namespace for `id` when user ids are only unique per tenant. */
  tenant?: string;
  /** Shown in Omnara as the actor's name. */
  name?: string;
}

/** A tool the agent may call that this server runs. */
export interface BackendTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters?: Record<string, unknown>;
  /**
   * Runs the call. Must be safe to run twice for the same `toolCallId`: two
   * servers following one agent can both pick up a call before either
   * result is recorded (Omnara keeps the first result).
   */
  handler: (
    input: unknown,
    context: { toolCallId: string },
  ) => unknown | Promise<unknown>;
}

/** An agent definition passed inline instead of a profile. */
export interface OmnaraAgentDefinition {
  /** Omnara agent config source: a YAML or JSON string, or an object. */
  source: string | Record<string, unknown>;
  /** Defaults to `json` for an object and `yaml` for a string. */
  format?: "yaml" | "json";
}

export type OmnaraErrorContext = {
  /** Stable identifier for what failed, e.g. `"run_failed"`. */
  operation: string;
  threadId?: string;
  agentId?: string;
};

/**
 * Receives failures that are absorbed or reported to the client only as a
 * stable code, with the full upstream detail. Nothing it does can fail a run.
 */
export type OmnaraErrorHandler = (
  error: unknown,
  context: OmnaraErrorContext,
) => void | Promise<void>;

export interface OmnaraAgentConfig extends AgentConfig {
  /** Org API key with the developer role on the project. Defaults to `OMNARA_API_KEY`. */
  apiKey?: string;
  orgId: string;
  projectId: string;
  /** Defaults to hosted Omnara (`https://api.omnara.com/v1`). */
  baseUrl?: string;
  /** Profile id (`aprf_...`) or name. Give exactly one of `profile` and `definition`. */
  profile?: string;
  /** Inline agent definition. Give exactly one of `profile` and `definition`. */
  definition?: OmnaraAgentDefinition;
  /** The end user, or `"anonymous"` to opt out of per-user threads (demos only). */
  user: OmnaraUser | "anonymous";
  backendTools?: BackendTool[];
  onError?: OmnaraErrorHandler;
}
