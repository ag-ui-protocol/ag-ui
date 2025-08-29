type envVars = {
  serverStarterUrl: string;
  serverStarterAllFeaturesUrl: string;
  mastraUrl: string;
  langgraphPythonUrl: string;
  langgraphFastApiUrl: string;
  langgraphTypescriptUrl: string;
  agnoUrl: string;
  llamaIndexUrl: string;
  crewAiUrl: string;
  pydanticAIUrl: string;
  adkMiddlewareUrl: string;
  customDomainTitle: Record<string, string>;
}

export default function getEnvVars(): envVars {
  const customDomainTitle: Record<string, string> = {};
  if (process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE) {
    const [domain, title] = process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE.split('___');
    if (domain && title) {
      customDomainTitle[domain] = title;
    }
  }

  return {
    serverStarterUrl: process.env.SERVER_STARTER_URL || 'http://localhost:8000',
    serverStarterAllFeaturesUrl: process.env.SERVER_STARTER_ALL_FEATURES_URL || 'http://localhost:8000',
    mastraUrl: process.env.MASTRA_URL || 'http://localhost:4111',
    langgraphPythonUrl: process.env.LANGGRAPH_PYTHON_URL || 'http://localhost:2024',
    langgraphFastApiUrl: process.env.LANGGRAPH_FAST_API_URL || 'http://localhost:8000',
    langgraphTypescriptUrl: process.env.LANGGRAPH_TYPESCRIPT_URL || 'http://localhost:2024',
    agnoUrl: process.env.AGNO_URL || 'http://localhost:9001',
    llamaIndexUrl: process.env.LLAMA_INDEX_URL || 'http://localhost:9000',
    crewAiUrl: process.env.CREW_AI_URL || 'http://localhost:9002',
    pydanticAIUrl: process.env.PYDANTIC_AI_URL || 'http://localhost:9000',
    adkMiddlewareUrl: process.env.ADK_MIDDLEWARE_URL || 'http://localhost:8000',
    customDomainTitle: customDomainTitle,
  }
}