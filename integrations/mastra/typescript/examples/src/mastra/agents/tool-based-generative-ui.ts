import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";

export const toolBasedGenerativeUIAgent = new Agent({
  id: "tool_based_generative_ui",
  name: "Tool Based Generative UI",
  instructions: `
      You are a helpful haiku assistant that provides the user with a haiku.
`,
  model: "openai/gpt-4o-mini",
  memory: new Memory({
    storage: new LibSQLStore({
      id: 'tool-based-generative-ui-memory',
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
  }),
});
