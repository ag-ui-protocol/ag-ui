import { CopilotAgent, type CopilotAgentConfig, type CopilotClientPort } from "../dist/index.js";

/** Keep the demos hermetic: no repo config, skills, hooks, or git access. */
const HERMETIC = {
  enableConfigDiscovery: false,
  enableOnDemandInstructionDiscovery: false,
  enableFileHooks: false,
  enableHostGitOperations: false,
  enableSessionStore: false,
  enableSkills: false,
};

export function defineAgent(
  client: CopilotClientPort,
  config: Omit<CopilotAgentConfig, "client">,
): CopilotAgent {
  return new CopilotAgent({
    client,
    model: process.env.COPILOT_MODEL ?? "gpt-5.4-mini",
    ...config,
    sessionConfig: { ...HERMETIC, ...config.sessionConfig },
  });
}
