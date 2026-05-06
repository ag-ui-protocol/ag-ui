// Hand-written equivalents of the z.infer<...> capability types in capabilities.ts.
// This file will replace capabilities.ts once zod is removed from @ag-ui/core
// (Task 8 of the zod-extraction plan). Until then, both files coexist and
// equality is verified via expectTypeOf assertions in __tests__/types-static.test.ts.

import type { Tool } from "./types-static";

export interface SubAgentInfo {
  name: string;
  description?: string;
}

export interface IdentityCapabilities {
  name?: string;
  type?: string;
  description?: string;
  version?: string;
  provider?: string;
  documentationUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface TransportCapabilities {
  streaming?: boolean;
  websocket?: boolean;
  httpBinary?: boolean;
  pushNotifications?: boolean;
  resumable?: boolean;
}

export interface ToolsCapabilities {
  supported?: boolean;
  items?: Tool[];
  parallelCalls?: boolean;
  clientProvided?: boolean;
}

export interface OutputCapabilities {
  structuredOutput?: boolean;
  supportedMimeTypes?: string[];
}

export interface StateCapabilities {
  snapshots?: boolean;
  deltas?: boolean;
  memory?: boolean;
  persistentState?: boolean;
}

export interface MultiAgentCapabilities {
  supported?: boolean;
  delegation?: boolean;
  handoffs?: boolean;
  subAgents?: SubAgentInfo[];
}

export interface ReasoningCapabilities {
  supported?: boolean;
  streaming?: boolean;
  encrypted?: boolean;
}

export interface MultimodalInputCapabilities {
  image?: boolean;
  audio?: boolean;
  video?: boolean;
  pdf?: boolean;
  file?: boolean;
}

export interface MultimodalOutputCapabilities {
  image?: boolean;
  audio?: boolean;
}

export interface MultimodalCapabilities {
  input?: MultimodalInputCapabilities;
  output?: MultimodalOutputCapabilities;
}

export interface ExecutionCapabilities {
  codeExecution?: boolean;
  sandboxed?: boolean;
  maxIterations?: number;
  maxExecutionTime?: number;
}

export interface HumanInTheLoopCapabilities {
  supported?: boolean;
  approvals?: boolean;
  interventions?: boolean;
  feedback?: boolean;
  interrupts?: boolean;
  approveWithEdits?: boolean;
}

export interface AgentCapabilities {
  identity?: IdentityCapabilities;
  transport?: TransportCapabilities;
  tools?: ToolsCapabilities;
  output?: OutputCapabilities;
  state?: StateCapabilities;
  multiAgent?: MultiAgentCapabilities;
  reasoning?: ReasoningCapabilities;
  multimodal?: MultimodalCapabilities;
  execution?: ExecutionCapabilities;
  humanInTheLoop?: HumanInTheLoopCapabilities;
  custom?: Record<string, unknown>;
}
