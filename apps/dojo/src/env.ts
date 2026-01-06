type envVars = {
  serverStarterUrl: string;
  serverStarterAllFeaturesUrl: string;
  mastraUrl: string;
  langgraphPythonUrl: string;
  langgraphFastApiUrl: string;
  langgraphTypescriptUrl: string;
  agnoUrl: string;
  springAiUrl: string;
  llamaIndexUrl: string;
  crewAiUrl: string;
  agentSpecUrl: string;
  pydanticAIUrl: string;
  adkMiddlewareUrl: string;
  agentFrameworkPythonUrl: string;
  a2aUrl: string;
  agentFrameworkDotnetUrl: string;
  a2aMiddlewareBuildingsManagementUrl: string;
  a2aMiddlewareFinanceUrl: string;
  a2aMiddlewareItUrl: string;
  a2aMiddlewareOrchestratorUrl: string;
  awsStrandsUrl: string;
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
    agentSpecUrl: process.env.AGENT_SPEC_URL || 'http://localhost:9003',
    pydanticAIUrl: process.env.PYDANTIC_AI_URL || 'http://localhost:9000',
    adkMiddlewareUrl: process.env.ADK_MIDDLEWARE_URL || 'http://localhost:8000',
    agentFrameworkPythonUrl: process.env.AGENT_FRAMEWORK_PYTHON_URL || 'http://localhost:8888',
    agentFrameworkDotnetUrl: process.env.AGENT_FRAMEWORK_DOTNET_URL || 'http://localhost:5018',
    springAiUrl: process.env.SPRING_AI_URL || 'http://localhost:8080',
    a2aUrl: process.env.A2A_URL || 'http://localhost:10002',
    a2aMiddlewareBuildingsManagementUrl: process.env.A2A_MIDDLEWARE_BUILDINGS_MANAGEMENT_URL || 'http://localhost:9001',
    a2aMiddlewareFinanceUrl: process.env.A2A_MIDDLEWARE_FINANCE_URL || 'http://localhost:9002',
    a2aMiddlewareItUrl: process.env.A2A_MIDDLEWARE_IT_URL || 'http://localhost:9003',
    a2aMiddlewareOrchestratorUrl: process.env.A2A_MIDDLEWARE_ORCHESTRATOR_URL || 'http://localhost:9000',
    awsStrandsUrl: process.env.AWS_STRANDS_URL || 'http://localhost:8000',
    customDomainTitle: customDomainTitle,
  }
}
