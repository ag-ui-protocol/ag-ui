import type {
  MessageSendConfiguration,
  MessageSendParams,
  Message as A2AMessage,
  Part as A2APart,
  TextPart as A2ATextPart,
  DataPart as A2ADataPart,
  FilePart as A2AFilePart,
  Task as A2ATask,
  TaskStatusUpdateEvent as A2ATaskStatusUpdateEvent,
  TaskArtifactUpdateEvent as A2ATaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import type { Context, Message as AGUIMessage } from "@ag-ui/client";
import type { Operation as JsonPatchOperation } from "fast-json-patch";

export type { JsonPatchOperation };

export type {
  A2AMessage,
  A2APart,
  A2ATextPart,
  A2ADataPart,
  A2AFilePart,
  MessageSendParams,
  MessageSendConfiguration,
  AGUIMessage as AGUIConversationMessage,
};

export type A2ARunMode = "send" | "stream";

export interface InputResumePayload {
  interruptId: string;
  payload: unknown;
}

export interface EngramKey {
  key: string;
}

export interface EngramRecord {
  key: EngramKey;
  value: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  labels?: Record<string, string>;
}

export interface EngramConfig {
  enabled?: boolean;
  extensionUri?: string;
}

export interface EngramUpdate {
  scope?: "task" | "context" | "agent";
  path?: string;
  update: unknown;
}

export interface A2ARunOptions {
  mode?: A2ARunMode;
  taskId?: string;
  contextId?: string;
  historyLength?: number;
  includeToolMessages?: boolean;
  includeSystemMessages?: boolean;
  includeDeveloperMessages?: boolean;
  acceptedOutputModes?: string[];
  engramUpdate?: EngramUpdate;
  artifactBasePath?: string;
  subscribeOnly?: boolean;
  resume?: InputResumePayload;
  /**
   * Whether Engram features are enabled for this agent instance.
   * Activation is intended to be controlled at construction time, not per-run.
   */
  engram?: boolean;
  engramExtensionUri?: string;
}

export interface SurfaceTracker {
  has(surfaceId: string): boolean;
  add(surfaceId: string): void;
}

export interface SharedStateTracker {
  state: Record<string, unknown>;
  emittedSnapshot?: boolean;
}

export type A2AStreamEvent =
  | A2AMessage
  | A2ATask
  | A2ATaskStatusUpdateEvent
  | A2ATaskArtifactUpdateEvent;

export interface ConvertAGUIMessagesOptions {
  contextId?: string;
  taskId?: string;
  includeToolMessages?: boolean;
  includeSystemMessages?: boolean;
  includeDeveloperMessages?: boolean;
  engramUpdate?: EngramUpdate;
  engramExtensionUri?: string;
  engramEnabled?: boolean;
  context?: Context[];
  resume?: InputResumePayload;
}

export interface ConvertedA2AMessages {
  contextId?: string;
  taskId?: string;
  history: A2AMessage[];
  latestUserMessage?: A2AMessage;
  targetMessage?: A2AMessage;
  metadata?: Record<string, unknown>;
}

export interface ConvertA2AEventOptions {
  role?: "assistant" | "user";
  messageIdMap: Map<string, string>;
  onTextDelta?: (payload: { messageId: string; delta: string }) => void;
  source?: string;
  getCurrentText?: (messageId: string) => string | undefined;
  onContextId?: (contextId: string) => void;
  surfaceTracker?: SurfaceTracker;
  sharedStateTracker?: SharedStateTracker;
  artifactBasePath?: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  contextId?: string;
}

export interface A2AAgentRunResultSummary {
  messages: Array<{ messageId: string; text: string }>;
  rawEvents: A2AStreamEvent[];
  finishedEarly?: boolean;
}

export type EngramEvent =
  | {
      kind: "snapshot";
      key: EngramKey;
      record: EngramRecord;
      version: number;
      sequence?: string;
      updatedAt: string;
    }
  | {
      kind: "delta";
      key: EngramKey;
      patch: JsonPatchOperation[];
      record?: EngramRecord;
      version: number;
      sequence?: string;
      updatedAt: string;
    }
  | {
      kind: "delete";
      key: EngramKey;
      version: number;
      sequence?: string;
      updatedAt: string;
    };

export interface EngramRequestOptions {
  engram?: boolean;
  extensionUri?: string;
}

export interface EngramGetParams {
  key?: EngramKey;
  contextId?: string;
}

export interface EngramListParams {
  filter?: { keyPrefix?: string; tags?: string[]; labels?: Record<string, string> };
  contextId?: string;
}

export interface EngramSetParams {
  key: EngramKey;
  value: unknown;
  expectedVersion?: number;
  tags?: string[];
  labels?: Record<string, string>;
  contextId?: string;
}

export interface EngramPatchParams {
  key: EngramKey;
  patch: JsonPatchOperation[];
  expectedVersion?: number;
  contextId?: string;
}

export interface EngramDeleteParams {
  key: EngramKey;
  expectedVersion?: number;
  contextId?: string;
}

export interface EngramGetResult {
  records: EngramRecord[];
}

export interface EngramListResult {
  records: EngramRecord[];
}

export interface EngramSetResult {
  record: EngramRecord;
}

export interface EngramPatchResult {
  record: EngramRecord;
}

export interface EngramDeleteResult {
  deleted: boolean;
  previousVersion?: number;
}

export interface EngramSubscribeParams {
  filter?: { keyPrefix?: string; key?: EngramKey };
  includeSnapshot?: boolean;
  fromSequence?: string;
  contextId?: string;
}

export interface EngramSubscribeResult {
  taskId: string;
}

export interface EngramSubscriptionOptions {
  filter?: { keyPrefix?: string; key?: EngramKey };
  taskId?: string;
  fromSequence?: string;
  includeSnapshot?: boolean;
  initialState?: Record<string, unknown>;
  sharedStateTracker?: SharedStateTracker;
  artifactBasePath?: string;
  contextId?: string;
  engram?: boolean;
  extensionUri?: string;
}
