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
}

export interface SurfaceTracker {
  has(surfaceId: string): boolean;
  add(surfaceId: string): void;
}

export interface SharedStateTracker {
  state: Record<string, unknown>;
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
  context?: Context[];
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
  surfaceTracker?: SurfaceTracker;
  sharedStateTracker?: SharedStateTracker;
  artifactBasePath?: string;
}

export interface A2AAgentRunResultSummary {
  messages: Array<{ messageId: string; text: string }>;
  rawEvents: A2AStreamEvent[];
}
