import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

/** Image parts on the user message are forwarded as blob attachments. */
export const createAgenticChatMultimodalAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "agentic_chat_multimodal",
    description: "Agentic chat that accepts images",
    instructions:
      "You are a helpful assistant that can analyze images, documents, and other media. " +
      "When a user shares an image, describe what you see in detail. " +
      "When a user shares a document, summarize its contents.",
  });
