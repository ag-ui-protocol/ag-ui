import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";

export const agenticChatMultimodalAgent = new Agent({
  id: "agentic_chat_multimodal",
  name: "Agentic Chat Multimodal",
  instructions: `
      You are a helpful assistant that can analyze images, documents, and other media.

      When a user shares an image, describe what you see in detail.
      When a user shares a document, summarize its contents.
      You can also engage in regular text conversation.

      Be descriptive and helpful when analyzing visual content.
  `,
  model: "openai/gpt-5.4",
  memory: new Memory({
    storage: new LibSQLStore({
      id: "agentic-chat-multimodal-memory",
      url: "file:../mastra.db",
    }),
  }),
});
