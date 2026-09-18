/**
 * Agentic chat example for the GitHub Copilot SDK integration.
 */

import type { CopilotClientPort } from "../dist/index.js";
import { CopilotAgent } from "../dist/index.js";

export function createAgenticChatAgent(client: CopilotClientPort): CopilotAgent {
  return new CopilotAgent({
    agentId: "agentic_chat",
    description: "General purpose agentic chat assistant",
    client,
    model: process.env.COPILOT_MODEL ?? "gpt-5.4-mini",
    instructions: "You are a helpful assistant. Use declared tools when requested.",
    sessionConfig: {
      // Keep the demo hermetic: no repo config, skills, hooks, or git access.
      enableConfigDiscovery: false,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
    },
  });
}
