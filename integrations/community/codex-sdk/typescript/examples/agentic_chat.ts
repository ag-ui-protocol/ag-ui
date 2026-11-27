import { CodexAgentAdapter } from "../src/index";

export function createAgent() {
  return new CodexAgentAdapter({
    codexOptions: { apiKey: process.env.CODEX_API_KEY },
    threadOptions: {
      workingDirectory: process.env.CODEX_WORKING_DIRECTORY,
      model: process.env.CODEX_MODEL,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    },
  });
}
