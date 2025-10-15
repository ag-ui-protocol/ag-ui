import * as dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { agenticChatHandler } from "./agents/agentic_chat/index.js";
import { toolBasedGenerativeUiHandler } from "./agents/tool_based_generative_ui/index.js";
import { agenticGenerativeUiHandler } from "./agents/agentic_generative_ui/index.js";

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
      "agentic_generative_ui"
    ]
  });
});

// Agent routes
app.post("/agentic_chat", agenticChatHandler);
app.post("/tool_based_generative_ui", toolBasedGenerativeUiHandler);
app.post("/agentic_generative_ui", agenticGenerativeUiHandler);

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Cloudflare AG-UI Server`);
  console.log(`   Running on http://${HOST}:${PORT}`);
  console.log(`\n📡 Available Agents:`);
  console.log(`   POST http://${HOST}:${PORT}/agentic_chat`);
  console.log(`      └─ Basic chat with Llama 3.1 8B`);
  console.log(`   POST http://${HOST}:${PORT}/tool_based_generative_ui`);
  console.log(`      └─ Tool-based UI with Llama 3.3 70B (haiku generation)`);
  console.log(`   POST http://${HOST}:${PORT}/agentic_generative_ui`);
  console.log(`      └─ Progressive state updates with task steps`);
  console.log(`\n✨ Ready to accept requests!\n`);
});
