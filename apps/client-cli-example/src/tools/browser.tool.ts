import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import open from "open";

export const browserTool = createTool({
  id: "browser",
  description: "Browse the web",
  inputSchema: z.object({
    url: z.string().describe("URL to browse"),
  }),
  outputSchema: z.string(),
  execute: async (inputData) => {
    open(inputData.url);
    return `Browsed ${inputData.url}`;
  },
});
