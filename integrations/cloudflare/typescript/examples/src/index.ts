import * as dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { agenticChatHandler } from "./agents/agentic_chat/index.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4114;
const HOST = process.env.HOST || "0.0.0.0";

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", integration: "cloudflare" });
});

// Agent routes
app.post("/agentic_chat", agenticChatHandler);

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Cloudflare AG-UI Server`);
  console.log(`   Running on http://${HOST}:${PORT}`);
  console.log(`\n📡 Available Agents:`);
  console.log(`   POST http://${HOST}:${PORT}/agentic_chat - Basic chat with Llama 3.1 8B`);
  console.log(`\n✨ Ready to accept requests!\n`);
});
