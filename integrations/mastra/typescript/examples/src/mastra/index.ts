import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import {
  registerMastraRunGuidanceCapabilities,
  withMastraRunGuidanceAuthority,
} from "@ag-ui/mastra/run-guidance";
import { authorizeGuidance, runGuidanceEnabled } from "./run-guidance";

import { agenticChatAgent } from "./agents/agentic-chat";
import { agenticChatReasoningAgent } from "./agents/agentic-chat-reasoning";
import { agenticChatMultimodalAgent } from "./agents/agentic-chat-multimodal";
import { toolBasedGenerativeUIAgent } from "./agents/tool-based-generative-ui";
import { backendToolRenderingAgent } from "./agents/backend-tool-rendering";
import { humanInTheLoopAgent } from "./agents/human-in-the-loop";
import { interruptAgent } from "./agents/interrupt";
import { a2uiDynamicSchemaAgent, a2uiRecoveryAgent } from "./agents/a2ui";
import { a2uiFixedSchemaAgent } from "./agents/a2ui-fixed";
import { sharedStateAgent } from "./agents/shared-state";
import { observationalMemoryAgent } from "./agents/observational-memory";
import { toolApprovalAgent } from "./agents/tool-approval";
import { generativeUIAgent } from "./agents/generative-ui";

const chatAgentPath = "/api/agents/agentic_chat";
const chatCapabilities = registerMastraRunGuidanceCapabilities("agentic_chat");
const guidanceSettings = {
  token: process.env.AG_UI_GUIDANCE_TOKEN?.trim(),
  restrictedIngress: process.env.AG_UI_TRUSTED_INGRESS === "true",
};

export const mastra = new Mastra({
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 4111,
    host: "0.0.0.0",
    middleware: [
      async (context, next) => {
        let path: string;
        try {
          path = decodeURIComponent(new URL(context.req.url).pathname).replace(
            /\/+$/,
            "",
          );
        } catch {
          return context.json({ error: "Invalid path" }, 400);
        }
        if (
          path !== chatCapabilities.path &&
          path !== chatAgentPath &&
          !path.startsWith(`${chatAgentPath}/`)
        ) {
          return next();
        }
        const authority = authorizeGuidance(
          context.req.raw.headers.get("authorization"),
          guidanceSettings,
        );
        if (authority === "reject")
          return context.json({ error: "Unauthorized" }, 401);
        if (!runGuidanceEnabled) return next();
        // Mastra's validator also reads the raw body.
        const body: { requestContext?: Record<string, unknown> } | undefined =
          context.req.method === "POST"
            ? await context.req.raw
                .clone()
                .json()
                .catch(() => undefined)
            : undefined;
        return withMastraRunGuidanceAuthority(
          authority === "trusted",
          next,
          body?.requestContext,
        );
      },
    ],
    apiRoutes: runGuidanceEnabled ? [chatCapabilities] : [],
  },
  agents: {
    agentic_chat: agenticChatAgent,
    agentic_chat_reasoning: agenticChatReasoningAgent,
    agentic_chat_multimodal: agenticChatMultimodalAgent,
    tool_based_generative_ui: toolBasedGenerativeUIAgent,
    backend_tool_rendering: backendToolRenderingAgent,
    human_in_the_loop: humanInTheLoopAgent,
    interrupt: interruptAgent,
    a2ui_dynamic_schema: a2uiDynamicSchemaAgent,
    a2ui_recovery: a2uiRecoveryAgent,
    a2ui_fixed_schema: a2uiFixedSchemaAgent,
    shared_state: sharedStateAgent,
    observational_memory: observationalMemoryAgent,
    tool_approval: toolApprovalAgent,
    generative_ui: generativeUIAgent,
  },
  // File-backed (not ":memory:"): suspend/resume persists the agentic-loop
  // workflow snapshot to instance storage and loads it on resumeStream. An
  // in-memory store gives each pooled connection its own empty DB, so the
  // snapshot can't be found on resume ("No snapshot found for this workflow
  // run"). Powers the remote resume of the `interrupt` and `tool_approval`
  // demos.
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: "file:../mastra.db",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});
