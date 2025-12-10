import { Mastra } from "@mastra/core";
import { agenticChatAgent } from "./agents/agentic-chat";
import { humanInTheLoopAgent } from "./agents/human-in-the-loop";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";
import { sharedStateAgent } from "./agents/shared-state";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";

export const mastra = new Mastra({
  agents: {
    agentic_chat: agenticChatAgent,
    human_in_the_loop: humanInTheLoopAgent,
    backend_tool_rendering: backendToolRenderingAgent,
    shared_state: sharedStateAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
  },
});
