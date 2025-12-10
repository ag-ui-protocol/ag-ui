export const cloudAgents = [
  {
    id: "agno",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_AGNO_COPILOT_API_KEY,
  },
  {
    id: "crewai",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_CREWAI_COPILOT_API_KEY,
  },
  {
    id: "langgraph",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_LANGGRAPH_COPILOT_API_KEY,
  },
  {
    id: "langgraph-fastapi",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_LANGGRAPH_FASTAPI_COPILOT_API_KEY,
  },
  {
    id: "langgraph-typescript",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_LANGGRAPH_TYPESCRIPT_COPILOT_API_KEY,
  },
  {
    id: "llama-index",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_LLAMA_INDEX_COPILOT_API_KEY,
  },
  {
    id: "mastra",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_MASTRA_COPILOT_API_KEY,
  },
  {
    id: "pydantic-ai",
    runtimeUrl: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    publicApiKey: process.env.NEXT_PUBLIC_PYDANTIC_AI_COPILOT_API_KEY,
  },
];
