type envVars = {
  serverStarterUrl: string;
  mastraUrl: string;
  langgraphUrl: string;   
  agnoUrl: string;
  llamaIndexUrl: string;
  crewAiUrl: string;
}

export default function getEnvVars() {
    return {
        serverStarterUrl: process.env.SERVER_STARTER_URL || 'localhost:8000',
        mastraUrl: process.env.MASTRA_URL || 'localhost:4111',
        langgraphUrl: process.env.LANGGRAPH_URL || 'localhost:2024',
        agnoUrl: process.env.AGNO_URL || 'localhost:9001',
        llamaIndexUrl: process.env.LLAMA_INDEX_URL || 'localhost:9000',
        crewAiUrl: process.env.CREW_AI_URL || 'localhost:9002',
    }
}