import { Agent, tool } from "@strands-agents/sdk";
import {
  StrandsAgent,
  createStrandsServer,
  type RunAgentInput,
  type StrandsAgentConfig,
  type ToolCallContext,
} from "@ag-ui/strands-server";
import { z } from "zod";

const proverbsListSchema = z.object({
  proverbs: z
    .array(z.string())
    .describe(
      "The complete list of proverbs that should replace the current state"
    ),
});

const getWeather = tool({
  name: "get_weather",
  description: "Get the weather for a provided location.",
  inputSchema: z.object({
    location: z
      .string()
      .describe("The location to get weather information for"),
  }),
  callback: async () => {
    return JSON.stringify({ location: "70 degrees" });
  },
});

const setThemeColor = tool({
  name: "set_theme_color",
  description:
    "Change the theme color of the UI. The actual execution happens in the frontend via useFrontendTool.",
  inputSchema: z.object({
    theme_color: z
      .string()
      .describe("The color that should become the UI theme"),
  }),
  callback: async () => null,
});

const updateProverbs = tool({
  name: "update_proverbs",
  description:
    "Replace the entire list of proverbs. Always include the full list, never just incremental changes.",
  inputSchema: z.object({
    proverbs_list: proverbsListSchema,
  }),
  callback: async () => {
    return "Proverbs updated successfully";
  },
});

function normalizeProverbs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function buildProverbsPrompt(
  inputData: RunAgentInput,
  userMessage: string
): string {
  const state = inputData.state;
  if (state && typeof state === "object" && "proverbs" in state) {
    const proverbsArray = normalizeProverbs(
      (state as Record<string, unknown>).proverbs
    );
    const proverbsJson = JSON.stringify(proverbsArray, null, 2);
    return `Current proverbs list:\n${proverbsJson}\n\nUser request: ${userMessage}`;
  }
  return userMessage;
}

async function proverbsStateFromArgs(context: ToolCallContext) {
  try {
    const rawInput =
      typeof context.toolInput === "string"
        ? JSON.parse(context.toolInput)
        : context.toolInput;

    if (!rawInput || typeof rawInput !== "object") {
      return { proverbs: [] };
    }

    const toolInput = rawInput as Record<string, unknown>;
    const proverbsPayload =
      (toolInput.proverbs_list as Record<string, unknown> | undefined) ??
      toolInput;

    const proverbs =
      proverbsPayload && typeof proverbsPayload === "object"
        ? normalizeProverbs(
            (proverbsPayload as Record<string, unknown>).proverbs
          )
        : [];

    return { proverbs };
  } catch {
    return null;
  }
}

const sharedStateConfig: StrandsAgentConfig = {
  stateContextBuilder: buildProverbsPrompt,
  toolBehaviors: {
    update_proverbs: {
      skipMessagesSnapshot: true,
      stateFromArgs: proverbsStateFromArgs,
    },
  },
};

const baseAgent = new Agent({
  systemPrompt:
    "You are a helpful and wise assistant that helps manage a collection of proverbs.",
  tools: [updateProverbs, getWeather, setThemeColor],
});

const agent = new StrandsAgent(
  baseAgent,
  "proverbs_agent",
  "A proverbs assistant that collaborates with you to manage proverbs",
  sharedStateConfig
);

const server = createStrandsServer(agent, "/");

server.listen(8000, () => {
  console.log("Listening on http://localhost:8000/");
});
