import type { AgentConfig } from "@ag-ui/client";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import type { CodexSessionStore } from "./sessions";

export interface CodexAgentAdapterConfig extends AgentConfig {
  codexOptions?: CodexOptions;
  threadOptions?: ThreadOptions;
  sessionStore?: CodexSessionStore;
  showReasoning?: boolean;
  maxInputBytes?: number;
  maxMessages?: number;
  maxTextBytes?: number;
  maxItems?: number;
  maxProgressBytes?: number;
  runTimeoutMs?: number;
  onError?: (error: unknown) => void;
}
