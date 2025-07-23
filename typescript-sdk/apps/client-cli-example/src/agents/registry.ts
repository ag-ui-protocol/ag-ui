import { LangGraphAgent } from "@ag-ui/langgraph";
import { CrewAIAgent } from "@ag-ui/crewai";
import { AgnoAgent } from "@ag-ui/agno";
import { LlamaIndexAgent } from "@ag-ui/llamaindex";
import { MastraAgent } from "@ag-ui/mastra";
import { PydanticAIAgent } from "@ag-ui/pydantic-ai";
// import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";

// Type for agent registry entries
export interface AgentRegistryEntry {
  label: string;
  AgentClass: any;
  required: string[];
  optional?: string[];
  description: string;
}

export const agentRegistry: Record<string, AgentRegistryEntry> = {
  langgraph: {
    label: "LangGraph",
    AgentClass: LangGraphAgent,
    required: ["graphId", "deploymentUrl"],
    optional: ["langsmithApiKey"],
    description: "Connects to a LangGraph deployment.",
  },
  crewai: {
    label: "CrewAI",
    AgentClass: CrewAIAgent,
    required: ["url"],
    optional: ["headers"],
    description: "Connects to a CrewAI FastAPI server.",
  },
  agno: {
    label: "Agno",
    AgentClass: AgnoAgent,
    required: ["url"],
    optional: ["headers"],
    description: "Connects to an Agno agent server.",
  },
  llamaindex: {
    label: "LlamaIndex",
    AgentClass: LlamaIndexAgent,
    required: ["url"],
    optional: ["headers"],
    description: "Connects to a LlamaIndex FastAPI server.",
  },
  mastra: {
    label: "Mastra",
    AgentClass: MastraAgent,
    required: ["agent"],
    optional: ["resourceId"],
    description: "Connects to a local or remote Mastra agent.",
  },
  pydanticai: {
    label: "PydanticAI",
    AgentClass: PydanticAIAgent,
    required: ["model"],
    optional: ["maxSteps", "toolChoice"],
    description: "Connects to a PydanticAI model.",
  },
  // vercelai: {
  //   label: "Vercel AI SDK",
  //   AgentClass: VercelAISDKAgent,
  //   required: ["model"],
  //   optional: ["maxSteps", "toolChoice"],
  //   description: "Connects to a Vercel AI SDK model.",
  // },
}; 