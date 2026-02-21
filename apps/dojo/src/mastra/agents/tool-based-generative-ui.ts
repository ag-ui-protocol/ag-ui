import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const toolBasedGenerativeUIAgent = new Agent({
  id: 'tool_based_generative_ui',
  name: "tool_based_generative_ui",
  instructions: `
    You are a helpful assistant for creating haikus.
  `,
  model: "openai/gpt-4.1-mini",
  tools: {
    generate_haiku: createTool({
      id: "generate_haiku",
      description:
        "Generate a haiku in Japanese and its English translation. Also select exactly 3 relevant images from the provided list based on the haiku's theme.",
      inputSchema: z.object({
        japanese: z
          .array(z.string())
          .describe("An array of three lines of the haiku in Japanese"),
        english: z
          .array(z.string())
          .describe("An array of three lines of the haiku in English"),
      }),
      outputSchema: z.string(),
      execute: async () => {
        return "Haiku generated.";
      },
    }),
  },
});
