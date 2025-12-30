/**
 * A simple agentic chat flow using LangGraph with AG-UI middleware.
 *
 * The AG-UI middleware handles:
 * - Injecting frontend tools from state.tools into the model
 * - Routing frontend tool calls (emit events, skip backend execution)
 */

import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";

const checkpointer = new MemorySaver();

export const agenticChatGraph = createAgent({
  model: "openai:gpt-4o",
  tools: [],  // Backend tools go here
  middleware: [copilotkitMiddleware],
  systemPrompt: "You are a helpful assistant.",
  checkpointer
});
