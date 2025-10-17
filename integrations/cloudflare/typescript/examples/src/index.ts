import * as dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { agenticChatHandler } from "./agents/agentic_chat/index.js";
import { toolBasedGenerativeUiHandler } from "./agents/tool_based_generative_ui/index.js";
import { agenticGenerativeUiHandler } from "./agents/agentic_generative_ui/index.js";
import { humanInTheLoopSDKHandler } from "./agents/human_in_the_loop_sdk/index.js";
import { toolBasedGenerativeUiSDKHandler } from "./agents/tool_based_generative_ui_sdk/index.js";
import { sharedStateHandler } from "./agents/shared_state/index.js";
import { backendToolRenderingHandler } from "./agents/backend_tool_rendering/index.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4114;
const HOST = process.env.HOST || "0.0.0.0";

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    integration: "cloudflare",
    agents: [
      "agentic_chat",
      "tool_based_generative_ui",
      "agentic_generative_ui",
      "human_in_the_loop_sdk",
      "shared_state",
      "backend_tool_rendering"
    ]
  });
});

// Agent routes
app.post("/agentic_chat", agenticChatHandler);
app.post("/tool_based_generative_ui", toolBasedGenerativeUiHandler);
app.post("/agentic_generative_ui", agenticGenerativeUiHandler);
app.post("/human_in_the_loop_sdk", humanInTheLoopSDKHandler);
app.post("/tool_based_generative_ui_sdk", toolBasedGenerativeUiSDKHandler);
app.post("/shared_state", sharedStateHandler);
app.post("/backend_tool_rendering", backendToolRenderingHandler);

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
