type envVars = {
  serverStarterUrl: string;
  serverStarterAllFeaturesUrl: string;
  mastraUrl: string;
  langgraphUrl: string;
  langgraphFastApiUrl: string;
  agnoUrl: string;
  llamaIndexUrl: string;
  crewAiUrl: string;
  pydanticAIUrl: string;
}

export default function getEnvVars(): envVars {
    return {
        serverStarterUrl: process.env.SERVER_STARTER_URL || 'http://localhost:8000',
        serverStarterAllFeaturesUrl: process.env.SERVER_STARTER_ALL_FEATURES_URL || 'http://localhost:8000',
        mastraUrl: process.env.MASTRA_URL || 'http://localhost:4111',
        langgraphUrl: process.env.LANGGRAPH_URL || 'http://localhost:2024',
        langgraphFastApiUrl: process.env.LANGGRAPH_FAST_API_URL || 'http://localhost:8000',
        agnoUrl: process.env.AGNO_URL || 'http://localhost:9001',
        llamaIndexUrl: process.env.LLAMA_INDEX_URL || 'http://localhost:9000',
        crewAiUrl: process.env.CREW_AI_URL || 'http://localhost:9002',
        pydanticAIUrl: process.env.PYDANTIC_AI_URL || 'http://localhost:9000',
    }
}