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
  tools: {
    generate_haiku: createTool({
      id: "generate_haiku",
      description:
        "Generate a haiku in Japanese and its English translation. Also select exactly 3 relevant images from the provided list based on the haiku's theme.",
      inputSchema: z.object({
        japanese: z.array(z.string()).describe("An array of three lines of the haiku in Japanese"),
        english: z.array(z.string()).describe("An array of three lines of the haiku in English"),
      }),
      outputSchema: z.string(),
      execute: async ({ context }) => {
        return "Haiku generated.";
      },
    }),
  },
  memory: new Memory({
    storage: new LibSQLStore({
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
  }),
});
