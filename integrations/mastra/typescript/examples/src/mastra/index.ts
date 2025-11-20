import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";

import { agenticChatAgent } from "./agents/agentic-chat";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";

export const mastra = new Mastra({
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 4111,
    host: "0.0.0.0",
  },
  agents: {
    agentic_chat: agenticChatAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
    backend_tool_rendering: backendToolRenderingAgent,
  },
  storage: new LibSQLStore({
    url: ":memory:",
    id: "libsql_store",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});
