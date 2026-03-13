import type { AbstractAgent, AgentConfig, BaseEvent, RunAgentInput } from '@ag-ui/client';
import type { MastraClient } from '@mastra/client-js';
import type { Mastra } from '@mastra/core';
import type { Agent as LocalMastraAgent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { ChunkFrom, ChunkType } from '@mastra/core/stream';
import type { Subscriber } from 'rxjs';
import type { AgentLogger } from './logger';
import type { ChunkHandlerRegistry } from './registry';

/** Union of stream chunk payloads for both remote and local Mastra responses. */
export type StreamChunk = ChunkType<undefined> | ChunkType<unknown>;

/** Discriminant field of stream chunks. */
export type StreamChunkName = StreamChunk['type'];

/** Narrows a stream chunk by its `type`. */
export type ChunkByType<T extends StreamChunkName> = Extract<StreamChunk, { type: T }>;

/** Handler signature used by the chunk registry. */
export type ChunkHandler<T extends StreamChunk = StreamChunk> = (
  chunk: T,
  context: StreamRunContext,
) => void;

/** Conflict policy when registering chunk handlers. */
export type RegisterMode = 'replace' | 'append' | 'skip';

/** Error behavior for chunk handler execution. */
export type HandlerErrorMode = 'fail-fast' | 'continue';

/** Options for constructing the default chunk-handler registry. */
export interface CreateDefaultRegistryOptions {
  /** Handler error strategy. */
  errorMode?: HandlerErrorMode;
  /** Callback invoked when a handler throws. */
  onHandlerError?: (error: Error, chunkType: StreamChunkName) => void;
  /** When true, registers a `start` handler that emits REASONING_START + REASONING_MESSAGE_START. */
  enableReasoning?: boolean;
}

/** Mutable runtime context shared across stream processing handlers. */
export interface StreamRunContext {
  /** Current assistant message ID in-flight. */
  messageId: string;
  /** Stable ID for the REASONING_START/END block of this run. */
  readonly reasoningId: string;
  /** Stable ID for the REASONING_MESSAGE_START/END of this run. */
  readonly reasoningMessageId: string;
  /** Whether the REASONING block is currently open (guards against double-close). */
  reasoningOpen: boolean;
  /** Whether text output has been emitted in current step. */
  hasEmittedText: boolean;
  /** Latest user message text extracted from AG-UI input, when available. */
  readonly latestUserMessageText: string | null;
  /** Whether the stream/run has been aborted. */
  aborted: boolean;
  /** Rx subscriber used to emit AG-UI events. */
  subscriber: Subscriber<BaseEvent>;
  /** CopilotKit thread identifier. */
  threadId: string;
  /** CopilotKit run identifier. */
  runId: string;
  /** Agent identifier from MastraAdapterConfig. */
  agentId: string;
  /** Resource identifier from MastraAdapterConfig (e.g. user email). */
  resourceId: string;
  /** Logger scoped to the adapter runtime. */
  logger: AgentLogger;
  /** Emits a stream event to subscribers. */
  emit: (event: BaseEvent) => void;
  /** Propagates stream failure to subscribers. */
  fail: (error: Error) => void;
  /** Rotates to a newly generated message ID. */
  rotateMessageId: () => void;
  /** Syncs message ID from server-provided step metadata. */
  syncMessageId: (messageId: string) => void;
  /** Marks the run as aborted. */
  markAborted: () => void;
}

/** Input model used to create a `StreamRunContext` instance. */
export type CreateRunContextOptions = {
  /** Rx subscriber receiving emitted AG-UI events. */
  subscriber: Subscriber<BaseEvent>;
  /** CopilotKit thread identifier. */
  threadId: string;
  /** CopilotKit run identifier. */
  runId: string;
  /** Adapter logger instance. */
  logger: AgentLogger;
  /** Latest user message text extracted from run input. */
  latestUserMessageText: string | null;
};

/** Runtime client-side agent proxy returned by `MastraClient#getAgent`. */
export type RemoteMastraAgent = ReturnType<MastraClient['getAgent']>;

/** Construction config for `MastraAgentAdapter`. */
export interface MastraAdapterConfig extends AgentConfig {
  /** Agent identifier (narrows AgentConfig.agentId from optional to required). */
  agentId: string;
  /** Local Mastra agent instance or remote agent proxy. */
  agent: LocalMastraAgent | RemoteMastraAgent;
  /** Resource identifier used by Mastra memory APIs. */
  resourceId: string;
  /** Optional request context for downstream tools/memory. */
  requestContext?: RequestContext;
}

/** Optional behavior overrides when creating adapter instances. */
export interface MastraAdapterOptions {
  /** Registry instance or registry mutator function. */
  registry?: ChunkHandlerRegistry | ((registry: ChunkHandlerRegistry) => ChunkHandlerRegistry);
  /** Override AgentConfig.debug to enable console logging. */
  debug?: boolean;
  /** Fully custom logger, or a factory resolved with the adapter config at construction time. Takes priority over debug flag. */
  logger?: AgentLogger | ((config: MastraAdapterConfig) => AgentLogger);
  /** Factory that produces a per-run AG-UI event sink; tapped into Observable<BaseEvent> inside run(). */
  eventLogger?: (config: MastraAdapterConfig) => (input: RunAgentInput, event: BaseEvent) => void;
  /** Error behavior for default registry handlers. */
  registryErrorMode?: HandlerErrorMode;
  /** When true, the default registry emits REASONING_START + REASONING_MESSAGE_START on stream start. */
  registryEnableReasoning?: boolean;
}

/** @deprecated Use `MastraAdapterConfig` instead. */
export type MastraAgentConfig = MastraAdapterConfig;

/** @deprecated Use `MastraAdapterOptions` instead. */
export type MastraAgentOptions = MastraAdapterOptions;

/**
 * Unified option shape for all adapter factory helpers.
 * Concrete helper option types are derived via utility types below.
 */
export interface AgentFactoryOptions {
  /** Resource identifier used by Mastra memory APIs. */
  resourceId: string;
  /** Optional request context propagated to agent calls. */
  requestContext?: RequestContext;
  /** Shorthand for adapterOptions.debug. */
  debug?: boolean;
  /** Optional adapter-level overrides. */
  adapterOptions?: MastraAdapterOptions;
  /** Local Mastra runtime instance (required by local factory methods). */
  mastra?: Mastra;
  /** Remote Mastra client (required by remote factory methods). */
  mastraClient?: MastraClient;
  /** Target agent identifier for single-agent lookup. */
  agentId?: string;
  /** Target network identifier for network lookup. */
  networkId?: string;
}

/** Shared option subset used by all static factory builders. */
export type AdapterCommonOptions = Pick<
  AgentFactoryOptions,
  'resourceId' | 'requestContext' | 'debug' | 'adapterOptions'
>;

/** Utility type that marks specific factory keys as required. */
type FactoryOptions<RequiredKeys extends keyof AgentFactoryOptions> = AdapterCommonOptions &
  Required<Pick<AgentFactoryOptions, RequiredKeys>>;

/** Options for creating adapters for all local agents. */
export type GetLocalAgentsOptions = FactoryOptions<'mastra'>;

/** Options for creating adapter for a single local agent. */
export type GetLocalAgentOptions = FactoryOptions<'mastra' | 'agentId'>;

/** Options for creating adapters for all remote agents. */
export type GetRemoteAgentsOptions = FactoryOptions<'mastraClient'>;

/** Options for creating adapter for a local network agent. */
export type GetNetworkOptions = FactoryOptions<'mastra' | 'networkId'>;

/** AG-UI agent registry keyed by agent ID. */
export type AGUIAgents = Record<string, AbstractAgent>;

/** Serialized client tool descriptor passed to Mastra stream calls. */
export interface ClientTool {
  /** Stable tool identifier/name. */
  id: string;
  /** Human-readable tool description. */
  description?: string;
  /** JSON schema describing tool input. */
  inputSchema: unknown;
}

/** Tool descriptors keyed by tool ID. */
export type ClientTools = Record<string, ClientTool>;

/**
 * 运行时 tool-output payload 的嵌套结构（来自 Mastra workflow / network 场景）。
 * 对应 @mastra/core 内部未导出的 NestedWorkflowOutput。
 */
export type NestedWorkflowOutput = {
  from: ChunkFrom;
  type: string;
  payload?: {
    output?: ChunkType | NestedWorkflowOutput;
    usage?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
