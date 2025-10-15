import express from "express";
import cors from "cors";
import { agenticChatHandler } from "./agents/agentic_chat.js";

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
  console.log(`Cloudflare AG-UI server running on http://${HOST}:${PORT}`);
  console.log("Available routes:");
  console.log(`  POST http://${HOST}:${PORT}/agentic_chat`);
});
