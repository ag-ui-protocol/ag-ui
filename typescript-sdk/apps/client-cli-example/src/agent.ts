import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { MastraAgent } from "@ag-ui/mastra";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { weatherTool } from "./tools/weather.tool";
import { browserTool } from "./tools/browser.tool";

export const agent = new MastraAgent({
  // @ts-ignore
  agent: new Agent({
    name: "AG-UI Agent",
    instructions: `
        You are a helpful assistant that runs a CLI application.
  
        When helping users get weather details for specific locations, respond:
        - Always ask for a location if none is provided.
        - If the location name isn’t in English, please translate it
        - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
        - Include relevant details like humidity, wind conditions, and precipitation
        - Keep responses concise but informative
  
        Use the weatherTool to fetch current weather data.

        When helping users browse the web, always use a full URL, for example: "https://www.google.com"
        Use the browserTool to browse the web.

  `,
    model: openai("gpt-4o-mini"),
    tools: { weatherTool, browserTool },
    memory: new Memory({
      storage: new LibSQLStore({
        url: "file:./mastra.db",
      }),
    }),
  }),
  threadId: "1",
});
