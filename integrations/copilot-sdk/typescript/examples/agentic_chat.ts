import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

export const createAgenticChatAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "agentic_chat",
    description: "General purpose agentic chat assistant",
    instructions: "You are a helpful assistant. Use declared tools when requested.",
  });
