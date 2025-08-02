import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";

import { agenticChatAgent } from "./agents/weather-agent";

export const mastra = new Mastra({
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 4111,
  },
  agents: { agentic_chat: agenticChatAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});
