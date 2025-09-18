import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { createTool } from "@mastra/core";
import z from "zod";

export const toolBasedGenerativeUIAgent = new Agent({
  name: "Haiku Agent",
  instructions: `
      You are a helpful haiku assistant that provides the user with a haiku.
`,
  model: openai("gpt-4o-mini"),
  memory: new Memory({
    storage: new LibSQLStore({
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
  }),
});
