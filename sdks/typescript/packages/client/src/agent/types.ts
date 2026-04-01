import { TransformHttpEventStreamHandlers } from "@/transform/base-type";
import { Message, RunAgentInput, State } from "@ag-ui/core";

export interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: boolean;
}

export interface HttpAgentConfig extends AgentConfig {
  url: string;
  headers?: Record<string, string>;
  streamHandlers?: TransformHttpEventStreamHandlers[];
}

export type RunAgentParameters = Partial<
  Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">
>;
