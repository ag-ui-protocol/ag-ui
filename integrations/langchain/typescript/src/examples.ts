import { LangChainAgent } from "./agent";
import { ChatOpenAI } from "@langchain/openai";

const chatOpenAI = new ChatOpenAI({ model: "gpt-4o" })

const agenticChat = new LangChainAgent({
  chainFn: async ({ messages, tools, threadId }) => {
    const model = chatOpenAI.bindTools(tools, {
      strict: true,
    });
    return model.stream(messages, { tools, metadata: { conversation_id: threadId } });
  },
})

const toolBasedGenerativeUI = new LangChainAgent({
  chainFn: async ({ messages, tools, threadId }) => {
    const model = chatOpenAI.bindTools(tools, {
      strict: true,
    });
    return model.stream(messages, { tools, metadata: { conversation_id: threadId } });
  },
})

export const langChainAgents = {
  agentic_chat: agenticChat,
  tool_based_generative_ui: toolBasedGenerativeUI,
}