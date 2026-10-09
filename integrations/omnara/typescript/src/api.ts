import {
  ApiError,
  bearerToken,
  createOmnaraClient,
  openAgentEventStream,
  sdk,
  type Actor,
  type Agent,
  type AgentConfig,
  type AgentEvent,
  type AgentEventStreamFrame,
  type AgentInteraction,
  type CreateAgentInputContentBlock,
  type ExternalActorParams,
  type InteractionAnswer,
  type SubmitToolResultContentBlock,
  type ToolCall,
} from "@omnara/sdk";

export type {
  Actor,
  Agent,
  AgentEvent,
  AgentEventStreamFrame,
  AgentInteraction,
  CreateAgentInputContentBlock,
  ExternalActorParams,
  InteractionAnswer,
  SubmitToolResultContentBlock,
  ToolCall,
};

/**
 * The Omnara calls the adapter makes. A narrow seam over `@omnara/sdk` so the
 * run logic can be tested against a fake.
 */
export interface OmnaraApi {
  createConfig(
    source: string,
    format: "yaml" | "json",
  ): Promise<{ id: string }>;
  getConfig(configId: string): Promise<AgentConfig>;
  getProfile(
    idOrName: string,
  ): Promise<{ id: string; current_config_id: string }>;
  /** `created` is false when the idempotency key replayed an existing agent. */
  launch(
    body: { config: string; profile?: string; name: string },
    idempotencyKey: string,
  ): Promise<{ agent: Agent; created: boolean }>;
  listChildren(agentId: string): Promise<Agent[]>;
  setConfig(
    agentId: string,
    source: string,
    format: "yaml" | "json",
    expectedCurrentConfigId: string,
  ): Promise<void>;
  /** The whole log, oldest first. */
  listEvents(agentId: string): Promise<AgentEvent[]>;
  /** Whether the log has events after `sequence`. */
  hasEventsAfter(agentId: string, sequence: number): Promise<boolean>;
  /** Inputs stored but not yet started (queued messages, undelivered subagent reports). */
  listBacklog(
    agentId: string,
  ): Promise<Array<{ id: string; input_idempotency_key?: string }>>;
  postInput(
    agentId: string,
    body: {
      content_blocks: CreateAgentInputContentBlock[];
      actor?: ExternalActorParams;
    },
    idempotencyKey: string,
  ): Promise<void>;
  stream(
    agentId: string,
    afterSequence: number,
    signal: AbortSignal,
    onConnected: () => void,
  ): AsyncIterable<AgentEventStreamFrame>;
  /** Ready custom calls on the agent and its subagents. */
  readyCustomCalls(agentId: string): Promise<ToolCall[]>;
  /** Open interactions on the agent and its subagents. */
  openInteractions(agentId: string): Promise<AgentInteraction[]>;
  submitResult(
    agentId: string,
    toolCallId: string,
    outcome: "succeeded" | "failed",
    content: SubmitToolResultContentBlock[],
  ): Promise<void>;
  resolveInteraction(
    agentId: string,
    interactionId: string,
    answers: InteractionAnswer[],
    actor?: ExternalActorParams,
  ): Promise<void>;
  cancel(agentId: string, actor?: ExternalActorParams): Promise<void>;
  getActor(actorId: string): Promise<Actor>;
}

/** HTTP status of an Omnara API failure, if it was one. */
export function statusOf(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Omnara's error code (e.g. `state_transition_conflict`), if it was an API failure. */
export function codeOf(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const CALL_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

export function createOmnaraApi(options: {
  apiKey: string;
  orgId: string;
  projectId: string;
  baseUrl?: string;
}): OmnaraApi {
  const client = createOmnaraClient({
    baseUrl: options.baseUrl,
    auth: bearerToken(options.apiKey),
    // Every call is bounded, except the event stream, which is meant to stay open.
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/events/stream")) return fetch(input, init);
      const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      return fetch(input, { ...init, signal });
    },
  });
  const project = { orgID: options.orgId, projectID: options.projectId };
  const agent = (agentID: string) => ({ ...project, agentID });

  return {
    async createConfig(source, format) {
      const { data } = await sdk.createAgentConfig({
        client,
        path: project,
        body: { source, source_format: format },
      });
      return { id: data.id };
    },
    async getConfig(configId) {
      const { data } = await sdk.getAgentConfig({
        client,
        path: { ...project, agentConfigID: configId },
      });
      return data;
    },
    async getProfile(idOrName) {
      if (idOrName.startsWith("aprf_")) {
        const { data } = await sdk.getAgentProfile({
          client,
          path: { ...project, agentProfileID: idOrName },
        });
        return data;
      }
      // The filter is a case-insensitive glob, but names are unique only as
      // written: escape the wildcards and pick the exact name.
      const { data } = await sdk.listAgentProfiles({
        client,
        path: project,
        query: { name: idOrName.replace(/[\\*?]/g, "\\$&"), limit: PAGE_LIMIT },
      });
      const found = data.data.find((p) => p.name === idOrName);
      if (!found) throw new Error(`Omnara profile "${idOrName}" not found`);
      return found;
    },
    async launch(body, idempotencyKey) {
      const { data, response } = await sdk.createAgent({
        client,
        path: project,
        body,
        headers: { "Idempotency-Key": idempotencyKey },
      });
      return { agent: data.agent, created: response.status === 201 };
    },
    async listChildren(agentId) {
      const { data } = await sdk.listAgents({
        client,
        path: project,
        query: { parent_agent_id: agentId, limit: PAGE_LIMIT },
      });
      return data.data;
    },
    async setConfig(agentId, source, format, expectedCurrentConfigId) {
      await sdk.updateAgentConfig({
        client,
        path: agent(agentId),
        body: {
          source,
          source_format: format,
          expected_current_config_id: expectedCurrentConfigId,
        },
      });
    },
    async listEvents(agentId) {
      const events: AgentEvent[] = [];
      let after = 0;
      for (;;) {
        const { data } = await sdk.listEvents({
          client,
          path: agent(agentId),
          query: { after_sequence: after, limit: PAGE_LIMIT },
        });
        events.push(...data.data);
        if (!data.has_more || data.data.length === 0) return events;
        after = data.next_after_sequence;
      }
    },
    async hasEventsAfter(agentId, sequence) {
      const { data } = await sdk.listEvents({
        client,
        path: agent(agentId),
        query: { after_sequence: sequence, limit: 1 },
      });
      return data.data.length > 0;
    },
    async listBacklog(agentId) {
      const { data } = await sdk.listQueuedBacklogInputs({
        client,
        path: agent(agentId),
        query: { limit: PAGE_LIMIT },
      });
      return data.data;
    },
    async postInput(agentId, body, idempotencyKey) {
      await sdk.createAgentInput({
        client,
        path: agent(agentId),
        body: { ...body, delivery_mode: "queued" },
        headers: { "Idempotency-Key": idempotencyKey },
      });
    },
    stream(agentId, afterSequence, signal, onConnected) {
      return openAgentEventStream({
        client,
        path: agent(agentId),
        query: { after_sequence: afterSequence, stream_deltas: true },
        signal,
        onConnectionStateChange: (state) => {
          if (state.state === "connected") onConnected();
        },
      });
    },
    async readyCustomCalls(agentId) {
      const { data } = await sdk.listToolCalls({
        client,
        path: agent(agentId),
        query: {
          state: "ready",
          type: "custom",
          include_subagents: true,
          limit: PAGE_LIMIT,
        },
      });
      return data.data;
    },
    async openInteractions(agentId) {
      const { data } = await sdk.listAgentInteractions({
        client,
        path: agent(agentId),
        query: { state: "open", include_subagents: true, limit: PAGE_LIMIT },
      });
      return data.data;
    },
    async submitResult(agentId, toolCallId, outcome, content) {
      await sdk.submitToolCallResult({
        client,
        path: { ...agent(agentId), toolCallID: toolCallId },
        body: { outcome, content_blocks: content },
      });
    },
    async resolveInteraction(agentId, interactionId, answers, actor) {
      await sdk.resolveAgentInteraction({
        client,
        path: { ...agent(agentId), interactionID: interactionId },
        body: { answers, actor },
      });
    },
    async cancel(agentId, actor) {
      await sdk.cancelAgent({ client, path: agent(agentId), body: { actor } });
    },
    async getActor(actorId) {
      const { data } = await sdk.getActor({
        client,
        path: { ...project, actorID: actorId },
      });
      return data;
    },
  };
}
