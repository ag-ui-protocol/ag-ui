import { Mastra } from "@mastra/core";
import { agenticChatAgent } from "./agents/agentic-chat";
import { humanInTheLoopAgent } from "./agents/human-in-the-loop";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";
import { sharedStateAgent } from "./agents/shared-state";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";
import { interruptAgent } from "./agents/interrupt";
import { getStorage } from "./storage";

export const mastra = new Mastra({
  agents: {
    agentic_chat: agenticChatAgent,
    human_in_the_loop: humanInTheLoopAgent,
    backend_tool_rendering: backendToolRenderingAgent,
    shared_state: sharedStateAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
    interrupt: interruptAgent,
  },
  // Instance-level storage is REQUIRED for suspend/resume: Mastra persists the
  // agentic-loop workflow snapshot to `mastra.getStorage()` on suspend and
  // loads it on `resumeStream`. Without it, resume fails with
  // "No snapshot found for this workflow run". Powers the `interrupt` demo.
  storage: getStorage(),
});
